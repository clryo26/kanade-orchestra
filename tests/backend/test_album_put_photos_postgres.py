"""Issue #150: opt-in real HTTP/repositories on the stage-4 owned loopback DB."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json

import psycopg
import pytest

from src.backend import app_core
from src.backend.services import album_service
from src.backend.repositories import db_item_repository
from test_perf_stage4_postgres import (  # noqa: F401 - pytest imports fixtures
    environment as stage4_environment,
    isolated_db as isolated_db,
    call,
    wait_for_album_lock,
    TENANT,
)


@pytest.fixture
def environment(monkeypatch, request):
    # Reuse the guarded seed/pool/real-audit fixture without copying its logic.
    yield from stage4_environment.__wrapped__(
        request.getfixturevalue("isolated_db"), monkeypatch, request
    )


PHOTO_QUERY = """SELECT id,album_id,organization_id,filename,url,object_name,coalesce(path,''),
 uploaded_by_member_id,coalesce(uploaded_by_member_name,''),uploaded_at,created_at,updated_at
 FROM album_photos WHERE organization_id=%s AND album_id=1 ORDER BY id"""


def state(env):
    with psycopg.connect(env["dsn"], autocommit=True) as c:
        parent = c.execute(
            "SELECT event_name,created_by_member_id,created_by_member_name,created_at,updated_at FROM albums WHERE id=1 AND organization_id=%s",
            (TENANT,),
        ).fetchone()
        photos = c.execute(PHOTO_QUERY, (TENANT,)).fetchall()
    return parent, photos


def audit_statuses(env):
    with psycopg.connect(env["dsn"], autocommit=True) as c:
        return [
            r[0] for r in c.execute("SELECT status_code FROM audit_logs ORDER BY id").fetchall()
        ]


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize("wrapper", ["flat", "dict", "string"])
def test_http_omission_preserves_actual_rows_creator_and_audit(environment, wrapper):
    env = environment
    before, photos = state(env)
    body = {"event_name": "After omission"}
    if wrapper != "flat":
        body = {"payload": body if wrapper == "dict" else json.dumps(body)}
    response, meter = call(env, "PUT", "/api/extra/albums/1", json=body)
    assert response.status_code == 200 and len(response.json()["photos"]) == 25
    after, saved_photos = state(env)
    assert after[0] == "After omission" and after[1:4] == before[1:4]
    assert after[4] != before[4] and saved_photos == photos
    assert meter["sql_by_tag"].get("delete_album_photos", 0) == 0
    assert meter["sql_by_tag"].get("insert_album_photos", 0) == 0
    assert audit_statuses(env) == [200]


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize("value", [None, "bad", {}, 0, False, [None], [{"id": 1}, 1]])
def test_bad_shapes_roll_back_parent_and_photos_before_child_delete(environment, value):
    env = environment
    before = state(env)
    response, meter = call(
        env, "PUT", "/api/extra/albums/1", json={"event_name": "No save", "photos": value}
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "写真情報の形式が正しくありません"
    assert state(env) == before
    assert not any(
        e["tag"] in {"update_albums", "delete_album_photos", "insert_album_photos"}
        for e in meter["events"]
    )
    assert audit_statuses(env) == [422]  # rejected requests still have an audit


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize("kind", ["empty", "same", "add", "change", "remove"])
def test_explicit_collection_replacement_is_retained(environment, kind):
    env = environment
    photos = deepcopy(env["albums"][0]["photos"])
    if kind == "empty":
        photos = []
    if kind == "add":
        photos.append({"id": 50001, "filename": "new.jpg", "object_name": "synthetic/new.jpg"})
    if kind == "change":
        photos[0]["filename"] = "renamed.jpg"
    if kind == "remove":
        photos = photos[1:]
    result, _ = call(
        env, "PUT", "/api/extra/albums/1", json={"event_name": "After", "photos": photos}
    )
    assert result.status_code == 200
    assert len(result.json()["photos"]) == len(photos)
    assert [row[0] for row in state(env)[1]] == sorted(p["id"] for p in photos)
    if kind == "change":
        assert state(env)[1][0][3] == "renamed.jpg"
    assert env["bucket"].counts["delete_calls"] == 0


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize("first", ["add", "remove"])
def test_waiting_omission_uses_collection_committed_before_parent_lock(environment, first):
    env = environment
    with psycopg.connect(env["dsn"]) as writer:
        writer.execute(
            "SELECT id FROM albums WHERE id=1 AND organization_id=%s FOR UPDATE", (TENANT,)
        )
        with ThreadPoolExecutor(max_workers=1) as threads:
            pending = threads.submit(
                call, env, "PUT", "/api/extra/albums/1", json={"event_name": "Waiting title"}
            )
            try:
                wait_for_album_lock(env["dsn"])
                if first == "add":
                    writer.execute(
                        "INSERT INTO album_photos(id,album_id,organization_id,filename,object_name) VALUES(50001,1,%s,'concurrent.jpg','synthetic/concurrent.jpg')",
                        (TENANT,),
                    )
                else:
                    writer.execute(
                        "DELETE FROM album_photos WHERE id=1 AND organization_id=%s", (TENANT,)
                    )
                writer.commit()
                response, _ = pending.result(timeout=12)
            finally:
                writer.rollback()
    assert response.status_code == 200
    ids = [r[0] for r in state(env)[1]]
    assert len(ids) == (26 if first == "add" else 24)
    assert (50001 in ids) if first == "add" else (1 not in ids)


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize("failure", ["write_exception", "pk_conflict"])
def test_failure_after_child_delete_rolls_back_all_changes(environment, monkeypatch, failure):
    env = environment
    before = state(env)
    if failure == "write_exception":
        original = db_item_repository.PostgresRowStore._write_children

        def broken(self, *args, **kwargs):
            original(self, *args, **kwargs)
            raise RuntimeError("Injected after child write")

        monkeypatch.setattr(db_item_repository.PostgresRowStore, "_write_children", broken)
        with pytest.raises(RuntimeError, match="Injected"):
            app_core.row_store().update("albums", 1, lambda current: {"event_name": "No commit"})
    else:
        photos = deepcopy(env["albums"][0]["photos"])
        photos.append({"id": 26, "filename": "conflict.jpg"})  # already owned by album 2
        with pytest.raises(psycopg.errors.UniqueViolation):
            app_core.row_store().update(
                "albums", 1, lambda current: {"event_name": "No commit", "photos": photos}
            )
    assert state(env) == before


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_version_and_permission_failures_preserve_data(environment):
    env = environment
    before = state(env)
    for raw, status, headers in [
        (
            {
                "payload": {"event_name": "No", "photos": None},
                "expected_updated_at": "2020-01-01T00:00:00Z",
            },
            409,
            {},
        ),
        ({"event_name": "No", "photos": None}, 401, {"X-Device-Id": "unknown"}),
        ({"event_name": "No"}, 401, {"X-Tenant-Id": "other-tenant"}),
    ]:
        response, _ = call(env, "PUT", "/api/extra/albums/1", json=raw, headers=headers)
        assert response.status_code == status
        assert state(env) == before
    with psycopg.connect(env["dsn"], autocommit=True) as c:
        c.execute("UPDATE members SET permission='一般' WHERE id=1")
        c.execute(
            "UPDATE albums SET created_by_member_id=2,created_by_member_name='other' WHERE id=1"
        )
    before = state(env)
    response, _ = call(env, "PUT", "/api/extra/albums/1", json={"event_name": "No", "photos": None})
    assert response.status_code == 403 and state(env) == before


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_direct_store_and_service_also_preserve_photos(environment):
    env = environment
    before = state(env)
    saved = app_core.row_store().update("albums", 1, lambda current: {"event_name": "Direct"})
    assert len(saved["photos"]) == 25 and state(env)[1] == before[1]
    service = album_service.update_album(1, {"event_name": "Service"})
    assert [p["id"] for p in service["photos"]] == [p["id"] for p in saved["photos"]]


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize("later", ["add", "remove"])
def test_photo_writer_waits_for_omission_commit_in_reverse_order(environment, later):
    env = environment

    def change_photos():
        # The observer filters this application_name; mark this controlled
        # raw writer too, instead of mistaking an unlabelled lock wait for none.
        with psycopg.connect(env["dsn"], application_name="portal_perf_stage4_baseline") as writer:
            writer.execute(
                "SELECT id FROM albums WHERE id=1 AND organization_id=%s FOR UPDATE", (TENANT,)
            )
            if later == "add":
                writer.execute(
                    "INSERT INTO album_photos(id,album_id,organization_id,filename,object_name) VALUES(50001,1,%s,'later.jpg','synthetic/later.jpg')",
                    (TENANT,),
                )
            else:
                writer.execute(
                    "DELETE FROM album_photos WHERE id=1 AND organization_id=%s", (TENANT,)
                )

    with ThreadPoolExecutor(max_workers=1) as threads:
        with app_core.row_store().transaction() as ctx:
            updated = app_core.row_store().update(
                "albums", 1, lambda current: {"event_name": "Omission first"}, ctx=ctx
            )
            assert len(updated["photos"]) == 25
            pending = threads.submit(change_photos)
            wait_for_album_lock(env["dsn"])
            assert not pending.done()
        pending.result(timeout=12)
    parent, photos = state(env)
    assert parent[0] == "Omission first" and len(photos) == (26 if later == "add" else 24)
