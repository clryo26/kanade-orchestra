"""4C first unit: real row changes, no GC/ledger/guard claim."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path

import psycopg
import pytest

from src.backend import app_core
from src.backend.repositories import db_item_repository
from test_album_put_photos_postgres import environment as pg_environment, state
from test_perf_stage4_postgres import call, isolated_db as isolated_db


BATCH_ROWS = []


@pytest.fixture(scope="module", autouse=True)
def save_batch_report():
    yield
    destination = os.getenv("PORTAL_STAGE4C_BATCH_REPORT", "")
    if not destination:
        return
    root = Path(__file__).resolve().parents[2]
    target = (root / destination).resolve()
    assert target.parent == (root / "docs/perf_stage4").resolve()
    assert target.name.startswith("STAGE4C_BATCH_") and target.name.endswith(
        ("_BEFORE.json", "_AFTER.json")
    )
    assert len(BATCH_ROWS) == 4
    reference = os.getenv("PORTAL_STAGE4C_BATCH_WRITER", "working-tree")
    report = {
        "writer_reference": reference,
        "cases": BATCH_ROWS,
        "measurement_test_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "source_sha256": hashlib.sha256(
            (root / "src/backend/repositories/db_item_repository.py").read_bytes()
        ).hexdigest()
        if reference == "working-tree"
        else None,
        "limits": "Owned loopback PostgreSQL, synthetic GCS; no candidate/version trigger installed. Statement counts are measured, trigger invocations are not.",
    }
    with target.open("x", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.write("\n")


@pytest.fixture
def environment(monkeypatch, request):
    yield from pg_environment.__wrapped__(monkeypatch, request)


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize(
    "kind,expected",
    [
        ("name", (0, 0, 0)),
        ("same", (0, 0, 0)),
        ("reorder", (0, 0, 0)),
        ("add", (1, 0, 0)),
        ("missing_id", (1, 0, 0)),
        ("change", (0, 1, 0)),
        ("reference", (0, 1, 0)),
        ("remove", (0, 0, 1)),
        ("empty", (0, 0, 25)),
    ],
)
def test_only_requested_photo_rows_are_written(environment, kind, expected):
    env = environment
    parent, photos_before = state(env)
    photos = deepcopy(env["albums"][0]["photos"])
    body = {"event_name": "After diff"}
    if kind == "reorder":
        photos.reverse()
    if kind in {"add", "missing_id"}:
        new = {"filename": "added.jpg", "object_name": "synthetic/new-diff.jpg"}
        if kind == "add":
            new["id"] = 50001
        photos.append(new)
    if kind == "change":
        photos[0]["filename"] = "changed.jpg"
    if kind == "reference":
        photos[0]["object_name"] = "synthetic/replaced.jpg"
    if kind == "remove":
        photos = photos[1:]
    if kind == "empty":
        photos = []
    if kind != "name":
        body["photos"] = photos
    if kind == "missing_id":
        # This compatibility path uses the existing DB sequence. Match a
        # properly aligned sequence; the upload MAX allocator is unchanged.
        with psycopg.connect(env["dsn"]) as c:
            c.execute(
                "SELECT setval(pg_get_serial_sequence('album_photos','id'), (SELECT max(id) FROM album_photos))"
            )
    response, meter = call(env, "PUT", "/api/extra/albums/1", json=body)
    assert response.status_code == 200
    actual = tuple(
        sum(max(e["affected_rows"], 0) for e in meter["events"] if e["tag"] == op + "_album_photos")
        for op in ("insert", "update", "delete")
    )
    assert actual == expected
    after_parent, after = state(env)
    assert after_parent[0] == "After diff" and after_parent[1:4] == parent[1:4]
    before_map = {p[0]: p for p in photos_before}
    for photo in after:
        if photo[0] in before_map and not (photo[0] == 1 and kind in {"change", "reference"}):
            assert (
                photo == before_map[photo[0]]
            ), "Untouched photos retain all snapshot columns/timestamps"
    if kind in {"change", "reference"}:
        assert after[0][9:11] == photos_before[0][9:11]
        assert after[0][-1] > photos_before[0][-1]
    if kind == "missing_id":
        assert max(p["id"] for p in response.json()["photos"]) == 501
    assert env["bucket"].counts["delete_calls"] == 0
    assert meter["sql_by_tag"]["insert_audit_logs"] == 1


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize("conflict", ["duplicate", "other_parent", "other_tenant"])
def test_ids_never_collapse_or_move_foreign_photos(environment, conflict):
    env = environment
    before = state(env)
    photos = deepcopy(env["albums"][0]["photos"])
    foreign = deepcopy(env["albums"][1]["photos"][0])
    if conflict == "duplicate":
        photos.append({**photos[0], "filename": "duplicate.jpg"})
    else:
        photos.append(foreign)
    with psycopg.connect(env["dsn"]) as c:
        if conflict == "other_tenant":
            c.execute(
                "UPDATE album_photos SET organization_id='other-test' WHERE id=%s", (foreign["id"],)
            )
        foreign_before = c.execute(
            "SELECT * FROM album_photos WHERE id=%s", (foreign["id"],)
        ).fetchone()
    with pytest.raises(psycopg.errors.UniqueViolation):
        app_core.row_store().update("albums", 1, lambda current: {**current, "photos": photos})
    assert state(env) == before
    with psycopg.connect(env["dsn"]) as c:
        assert (
            c.execute("SELECT * FROM album_photos WHERE id=%s", (foreign["id"],)).fetchone()
            == foreign_before
        )


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_real_photo_update_is_rolled_back_with_parent(environment, monkeypatch):
    env = environment
    before = state(env)
    original = db_item_repository.PostgresRowStore._write_children

    def fail_after_real_diff(self, *args, **kwargs):
        original(self, *args, **kwargs)
        raise RuntimeError("Injected after photo UPDATE")

    def change(current):
        current["event_name"] = "Must not commit"
        current["photos"][0]["filename"] = "must-not-commit.jpg"
        return current

    monkeypatch.setattr(
        db_item_repository.PostgresRowStore, "_write_children", fail_after_real_diff
    )
    with pytest.raises(RuntimeError, match="Injected"):
        app_core.row_store().update("albums", 1, change)
    assert state(env) == before


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_legacy_sequence_collision_rolls_back_without_collapsing_ids(environment):
    env = environment
    before = state(env)
    photos = deepcopy(env["albums"][0]["photos"])
    photos.append({"filename": "new.jpg", "object_name": "synthetic/sequence-test.jpg"})
    with psycopg.connect(env["dsn"]) as c:
        c.execute("SELECT setval(pg_get_serial_sequence('album_photos','id'),1,false)")
    with pytest.raises(psycopg.errors.UniqueViolation):
        app_core.row_store().update("albums", 1, lambda current: {**current, "photos": photos})
    assert state(env) == before


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize(
    "operation,count", [("delete", 5), ("delete", 25), ("update", 5), ("update", 25)]
)
def test_bulk_photo_statement_counts(environment, operation, count):
    env = environment
    before = state(env)
    photos = deepcopy(env["albums"][0]["photos"])
    if operation == "delete":
        photos = photos[count:]
    else:
        for photo in photos[:count]:
            photo["filename"] = "bulk-" + photo["filename"]
    with psycopg.connect(env["dsn"]) as c:
        foreign_before = c.execute(
            "SELECT * FROM album_photos WHERE album_id=2 ORDER BY id"
        ).fetchall()
        version = c.execute("SHOW server_version").fetchone()[0]
    response, meter = call(
        env, "PUT", "/api/extra/albums/1", json={"event_name": "Bulk measurement", "photos": photos}
    )
    events = [
        e
        for e in meter["events"]
        if e["tag"] in {"delete_album_photos", "update_album_photos", "insert_album_photos"}
    ]
    BATCH_ROWS.append(
        {
            "postgres_version": version,
            "operation": operation,
            "photo_count": count,
            "http_status": response.status_code,
            "request_sql_statements": meter["sql_statements"],
            "sequential_checkouts": meter["checkouts"],
            "photo_statements": sum(e["statements"] for e in events),
            "photo_rows_affected": sum(max(e["affected_rows"], 0) for e in events),
            "photo_events": events,
        }
    )
    assert response.status_code == 200
    assert all(e["tag"] == operation + "_album_photos" for e in events)
    assert sum(e["affected_rows"] for e in events) == count
    after = state(env)
    before_map = {p[0]: p for p in before[1]}
    for photo in after[1]:
        if operation == "delete" or photo[0] > count:
            assert photo == before_map[photo[0]]
        else:
            assert photo[3] == "bulk-" + before_map[photo[0]][3]
            assert photo[9:11] == before_map[photo[0]][9:11]
            assert photo[-1] > before_map[photo[0]][-1]
    assert len(after[1]) == (25 - count if operation == "delete" else 25)
    with psycopg.connect(env["dsn"]) as c:
        assert (
            c.execute("SELECT * FROM album_photos WHERE album_id=2 ORDER BY id").fetchall()
            == foreign_before
        )
        assert c.execute("SELECT status_code FROM audit_logs").fetchall() == [(200,)]
    assert sum(e["statements"] for e in events) == (1 if operation == "delete" else count)
