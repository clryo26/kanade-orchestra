"""Opt-in PostgreSQL tests for the row-level store (JST spec R05/R07; T01/T05/T08/T09/T10).

Never uses the application's DB_URL implicitly: set PORTAL_TEST_DB_URL to an
isolated, disposable PostgreSQL instance (the tests drop and recreate tables).
"""
from __future__ import annotations

import os
import threading
import time
from datetime import timedelta
from urllib.parse import quote

import pytest
from fastapi import HTTPException

psycopg = pytest.importorskip("psycopg")

from src.backend.core import db_runtime  # noqa: E402
from src.backend.core.tenant_context import reset_current_tenant_id, set_current_tenant_id  # noqa: E402
from src.backend.repositories import db_item_repository as items  # noqa: E402
from src.backend.repositories.db_row_repository import _ORG_COLUMN_CACHE  # noqa: E402
from src.backend.utils import datetime_utils as dt  # noqa: E402

DSN = os.environ.get("PORTAL_TEST_DB_URL", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Set PORTAL_TEST_DB_URL to an isolated PostgreSQL test instance")

TABLES = ("events", "desired_pieces", "desired_piece_votes", "concert_record_videos", "performances", "performance_pieces", "connection_settings", "album_photos", "albums")


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setenv("DB_URL", DSN)
    _ORG_COLUMN_CACHE.clear()
    with psycopg.connect(DSN, autocommit=True) as conn:
        with conn.cursor() as cur:
            for table in TABLES:
                cur.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
        db_runtime.ensure_db_schema_compatibility(conn)
    token = set_current_tenant_id("tenant-a")
    try:
        yield items.PostgresRowStore()
    finally:
        reset_current_tenant_id(token)


def _event(item_id, title="t", deadline="2026-10-19"):
    return {"title": title, "date": "2026-10-20", "start_time": "18:00", "deadline": deadline, "url": "", "notes": ""}


def _set_updated_at(sql_expr: str, item_id: int, table="events"):
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(f"UPDATE {table} SET updated_at = {sql_expr} WHERE id = %s", (item_id,))


def test_insert_returns_committed_jst_values_and_deadline_date(store):
    saved = store.insert("events", lambda new_id: _event(new_id))
    assert saved["created_at"].endswith("+09:00") and len(saved["created_at"]) == 32
    assert saved["deadline"] == "2026-10-19"
    again = store.get("events", saved["id"])
    assert again["updated_at"] == saved["updated_at"]  # T05: same version, same text
    with psycopg.connect(DSN) as conn:
        stored = conn.execute("SELECT deadline AT TIME ZONE 'UTC' FROM events WHERE id=%s", (saved["id"],)).fetchone()[0]
    assert str(stored) == "2026-10-19 00:00:00"


@pytest.mark.parametrize("session_tz", ["UTC", "Asia/Tokyo", "America/New_York"])
def test_output_does_not_depend_on_session_timezone(store, monkeypatch, session_tz):
    saved = store.insert("events", lambda new_id: _event(new_id))
    separator = "&" if "?" in DSN else "?"
    monkeypatch.setenv("DB_URL", f"{DSN}{separator}options={quote('-c TimeZone=' + session_tz)}")
    reread = items.PostgresRowStore().get("events", saved["id"])
    assert reread["created_at"] == saved["created_at"]
    assert reread["deadline"] == "2026-10-19"


def test_same_version_from_two_requests_only_one_succeeds(store):
    saved = store.insert("events", lambda new_id: _event(new_id))
    version = saved["updated_at"]
    zulu = dt.parse_instant(version).astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    first = store.update("events", saved["id"], lambda cur: {**cur, "title": "A"}, expected_updated_at=zulu)
    assert first["title"] == "A"
    with pytest.raises(HTTPException) as conflict:
        store.update("events", saved["id"], lambda cur: {**cur, "title": "B"}, expected_updated_at=version)
    assert conflict.value.status_code == 409
    assert store.get("events", saved["id"])["title"] == "A"


def test_concurrent_update_waits_for_lock_then_detects_conflict(store):
    saved = store.insert("events", lambda new_id: _event(new_id))
    version = saved["updated_at"]
    results: dict[str, object] = {}
    started = threading.Event()

    def second():
        # Like the HTTP middleware, every request sets its own tenant context.
        set_current_tenant_id("tenant-a")
        started.set()
        try:
            store.update("events", saved["id"], lambda cur: {**cur, "title": "late"}, expected_updated_at=version)
            results["second"] = "ok"
        except HTTPException as exc:
            results["second"] = exc.status_code

    with store.transaction() as ctx:
        store.update("events", saved["id"], lambda cur: {**cur, "title": "first"}, expected_updated_at=version, ctx=ctx)
        thread = threading.Thread(target=second)
        thread.start()
        started.wait()
        time.sleep(0.5)  # the second request is blocked on the row lock
        assert "second" not in results
    thread.join(10)
    assert results["second"] == 409
    assert store.get("events", saved["id"])["title"] == "first"


def test_other_rows_insert_and_delete_are_not_lost_or_resurrected(store):
    a = store.insert("events", lambda new_id: _event(new_id, "a"))
    b = store.insert("events", lambda new_id: _event(new_id, "b"))
    with store.transaction() as ctx:
        store.update("events", a["id"], lambda cur: {**cur, "title": "a2"}, ctx=ctx)
        # Independent connection: insert and delete while the update is open.
        other = items.PostgresRowStore()
        c = other.insert("events", lambda new_id: _event(new_id, "c"))
        other.delete("events", b["id"], lambda cur: None)
    titles = sorted(item["title"] for item in store.list("events"))
    assert titles == ["a2", "c"]
    with pytest.raises(HTTPException) as gone:
        store.update("events", b["id"], lambda cur: {**cur, "title": "zombie"})
    assert gone.value.status_code == 404
    assert c["id"] not in {a["id"], b["id"]}


def test_child_rows_keep_server_timestamps_and_ignore_client_values(store):
    piece = store.insert(
        "desired_pieces",
        lambda new_id: {"title": "曲", "votes": [{"member_id": 1, "name": "A", "voted_at": "2000-01-01T00:00:00Z"}]},
    )
    first_vote = piece["votes"][0]
    assert first_vote["voted_at"] != "2000-01-01T00:00:00.000000+09:00"
    assert dt.parse_instant(first_vote["voted_at"]) > dt.parse_instant("2020-01-01T00:00:00Z")
    updated = store.update(
        "desired_pieces",
        piece["id"],
        lambda cur: {**cur, "votes": [{**first_vote, "voted_at": "1999-01-01T00:00:00Z"}, {"member_id": 2, "name": "B"}]},
    )
    by_member = {vote["member_id"]: vote for vote in updated["votes"]}
    assert by_member[1]["voted_at"] == first_vote["voted_at"]  # kept from the DB
    assert dt.parse_instant(by_member[2]["voted_at"]) >= dt.parse_instant(first_vote["voted_at"])


def test_tenant_boundary_on_read_update_delete(store):
    saved = store.insert("events", lambda new_id: _event(new_id))
    token = set_current_tenant_id("tenant-b")
    try:
        other = items.PostgresRowStore()
        assert other.get("events", saved["id"]) is None
        with pytest.raises(HTTPException) as missing:
            other.update("events", saved["id"], lambda cur: {**cur, "title": "x"})
        assert missing.value.status_code == 404
        with pytest.raises(HTTPException):
            other.delete("events", saved["id"], lambda cur: None)
        assert other.list("events") == []
    finally:
        reset_current_tenant_id(token)
    assert store.get("events", saved["id"])["title"] == "t"


def test_lock_wait_is_bounded(store, monkeypatch):
    monkeypatch.setattr(items, "LOCK_TIMEOUT", "300ms")
    saved = store.insert("events", lambda new_id: _event(new_id))
    holder = items.PostgresRowStore()
    with holder.transaction() as ctx:
        holder.get("events", saved["id"], ctx=ctx, lock=True)
        started = time.monotonic()
        with pytest.raises(HTTPException) as busy:
            items.PostgresRowStore().update("events", saved["id"], lambda cur: {**cur, "title": "x"})
        assert busy.value.status_code == 503
        assert time.monotonic() - started < 5


def test_version_is_monotonic_and_future_anomaly_stops_update(store):
    saved = store.insert("events", lambda new_id: _event(new_id))
    _set_updated_at("clock_timestamp() + interval '3 seconds'", saved["id"])
    ahead = dt.parse_instant(store.get("events", saved["id"])["updated_at"])
    bumped = store.update("events", saved["id"], lambda cur: {**cur, "title": "n"})
    assert dt.parse_instant(bumped["updated_at"]) == ahead + timedelta(microseconds=1)
    for future in ("interval '6 seconds'", "interval '9 hours'"):
        _set_updated_at(f"clock_timestamp() + {future}", saved["id"])
        with pytest.raises(dt.FutureVersionAnomaly):
            store.update("events", saved["id"], lambda cur: {**cur, "title": "n2"})


def test_rapid_updates_never_reuse_a_version(store):
    saved = store.insert("events", lambda new_id: _event(new_id))
    versions = {saved["updated_at"]}
    for index in range(20):
        versions.add(store.update("events", saved["id"], lambda cur, i=index: {**cur, "title": str(i)})["updated_at"])
    assert len(versions) == 21


def test_group_resequence_swaps_unique_sort_orders(store):
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("INSERT INTO performances (id, organization_id, title) VALUES (1, 'tenant-a', 'P')")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_crv_sort ON concert_record_videos(organization_id, performance_id, sort_order)"
        )
    a = store.insert("concert_record_videos", lambda new_id: {"performance_id": 1, "sort_order": 1, "youtube_url": "a"})
    b = store.insert("concert_record_videos", lambda new_id: {"performance_id": 1, "sort_order": 2, "youtube_url": "b"})
    store.update_many(
        "concert_record_videos",
        {a["id"]: {"sort_order": 2}, b["id"]: {"sort_order": 1}},
        group_keys=["performance:1"],
        unique_two_phase="sort_order",
    )
    order = {item["youtube_url"]: item["sort_order"] for item in store.list("concert_record_videos")}
    assert order == {"a": 2, "b": 1}


def test_update_columns_where_guard_prevents_stale_write(store):
    saved = store.insert("events", lambda new_id: _event(new_id, "v1"))
    assert store.update_columns("events", saved["id"], {"notes": "x"}, where={"title": "other"}) is None
    changed = store.update_columns("events", saved["id"], {"notes": "x"}, where={"title": "v1"})
    assert changed["notes"] == "x" and changed["title"] == "v1"


def test_unknown_deadline_is_not_erased_by_blank_browser_input(store):
    saved = store.insert("events", lambda new_id: _event(new_id))
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("UPDATE events SET deadline='2026-10-19T03:17:00Z' WHERE id=%s", (saved["id"],))
    assert store.get("events", saved["id"])["deadline"] == ""
    changed = store.update("events", saved["id"], lambda cur: {**cur, "title": "edited", "deadline": ""})
    assert changed["deadline"] == ""
    with psycopg.connect(DSN) as conn:
        raw = conn.execute("SELECT deadline FROM events WHERE id=%s", (saved["id"],)).fetchone()[0]
    assert dt.format_instant(raw) == "2026-10-19T12:17:00.000000+09:00"
    # A deliberate valid replacement is allowed, independent of Q04 results.
    changed = store.update("events", saved["id"], lambda cur: {**cur, "deadline": "2026-10-20"})
    assert changed["deadline"] == "2026-10-20"


def test_parallel_album_uploads_keep_all_photos_with_global_ids(store, monkeypatch, tmp_path):
    from src.backend.services import album_service

    monkeypatch.setattr(album_service, "_store", lambda: store)
    monkeypatch.setattr(album_service, "storage_enabled", lambda: False)
    monkeypatch.setattr(album_service, "UPLOAD_DIR", tmp_path)
    a = store.insert("albums", lambda new_id: {"title": "a", "photos": []})
    b = store.insert("albums", lambda new_id: {"title": "b", "photos": []})
    start = threading.Barrier(3)
    results, errors = [], []

    def upload(album_id):
        token = set_current_tenant_id("tenant-a")
        try:
            start.wait(timeout=5)
            results.append(album_service.upload_album_photo(album_id, "same.png", "image/png", b"photo", {"member_id": 1}))
        except Exception as exc:
            errors.append(exc)
        finally:
            reset_current_tenant_id(token)

    threads = [threading.Thread(target=upload, args=(album_id,)) for album_id in (a["id"], a["id"], b["id"])]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(20)
    assert all(not thread.is_alive() for thread in threads)
    assert errors == []
    assert len({photo["id"] for photo in results}) == 3
    assert len(store.get("albums", a["id"])["photos"]) == 2
    assert len(store.get("albums", b["id"])["photos"]) == 1
    assert len({photo["path"] for photo in results}) == 3
    assert all(photo["uploaded_at"].endswith("+09:00") for photo in results)


def test_event_deadline_round_trip_and_unknown_value_is_never_erased(store, monkeypatch):
    """N02/T07: create -> read -> edit keeps the calendar date; an unknown stored value survives an edit."""
    from src.backend.services import event_service

    monkeypatch.setenv("DATA_BACKEND", "db")
    monkeypatch.delenv("LOCAL_JSON_FALLBACK_ENABLED", raising=False)
    created = event_service.create_event(
        {"title": "Party", "date": "2026-10-20", "start_time": "18:00", "deadline": "2026-10-19"},
        {"member_id": 7},
    )
    assert created["deadline"] == "2026-10-19"
    edited = event_service.update_event(created["id"], {**created, "title": "Party 2"})
    assert edited["deadline"] == "2026-10-19"
    # A value written by an unknown earlier version (JST midnight): reported
    # as unknown, and an edit that sends "" does not erase it.
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("UPDATE events SET deadline = '2026-10-18T15:00:00+00:00' WHERE id = %s", (created["id"],))
    unknown = items.PostgresRowStore().get("events", created["id"])
    assert unknown["deadline"] == "" and unknown["deadline_raw"].startswith("2026-10-19T00:00:00")
    event_service.update_event(created["id"], {**created, "title": "Party 3", "deadline": ""})
    with psycopg.connect(DSN) as conn:
        stored = conn.execute("SELECT deadline AT TIME ZONE 'UTC' FROM events WHERE id = %s", (created["id"],)).fetchone()[0]
    assert str(stored) == "2026-10-18 15:00:00"
    # An explicit new date replaces it.
    assert event_service.update_event(created["id"], {**created, "deadline": "2026-11-01"})["deadline"] == "2026-11-01"


def test_parallel_album_uploads_keep_every_photo_with_unique_ids(store, monkeypatch, tmp_path):
    """N05/T08: no lost photo, IDs unique across albums, UUID object names never overwrite."""
    from src.backend.services import album_service

    monkeypatch.setenv("DATA_BACKEND", "db")
    monkeypatch.delenv("LOCAL_JSON_FALLBACK_ENABLED", raising=False)
    monkeypatch.setattr(album_service, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(album_service, "storage_enabled", lambda: False)
    with psycopg.connect(DSN, autocommit=True) as conn:
        for table in ("albums", "album_photos"):
            conn.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
        db_runtime.ensure_db_schema_compatibility(conn)
    album_a = store.insert("albums", lambda new_id: {"event_name": "A"})
    album_b = store.insert("albums", lambda new_id: {"event_name": "B"})
    device = {"member_id": 3, "member_name": "m", "permission": "一般"}
    results = []

    def upload(album_id, index):
        set_current_tenant_id("tenant-a")
        results.append(album_service.upload_album_photo(album_id, "same.jpg", "image/jpeg", f"img-{index}".encode(), device))

    threads = [threading.Thread(target=upload, args=(album, i)) for i, album in enumerate([album_a["id"]] * 3 + [album_b["id"]] * 2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    photos = {album["id"]: album["photos"] for album in store.list("albums")}
    assert len(photos[album_a["id"]]) == 3 and len(photos[album_b["id"]]) == 2
    ids = [photo["id"] for album_photos in photos.values() for photo in album_photos]
    assert len(set(ids)) == 5
    paths = {photo["path"] for album_photos in photos.values() for photo in album_photos}
    assert len(paths) == 5 and all((tmp_path / path).exists() for path in paths)
    assert all(photo["uploaded_at"].endswith("+09:00") for album_photos in photos.values() for photo in album_photos)
    victim = photos[album_a["id"]][0]
    album_service.delete_album_photo(album_a["id"], victim["id"], {"permission": "管理者"})
    assert not (tmp_path / victim["path"]).exists()
    assert len(store.get("albums", album_a["id"])["photos"]) == 2
