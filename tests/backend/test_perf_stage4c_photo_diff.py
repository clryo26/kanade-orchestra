"""4C first unit: real row changes, no GC/ledger/guard claim."""
from __future__ import annotations

from copy import deepcopy

import psycopg
import pytest

from src.backend import app_core
from src.backend.repositories import db_item_repository
from test_album_put_photos_postgres import environment as pg_environment, state
from test_perf_stage4_postgres import call, isolated_db as isolated_db


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
