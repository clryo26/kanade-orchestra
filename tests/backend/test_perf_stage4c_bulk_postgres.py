"""Opt-in: album bulk refusal against the owned, loopback stage-4 database."""
import psycopg
import pytest
from fastapi import HTTPException

from src.backend import app_core
from src.backend.repositories import db_json_repository as repo
from src.backend.repositories import db_row_repository as rows
from test_album_put_photos_postgres import environment as album_environment, state
from test_perf_stage4_postgres import isolated_db as isolated_db, call  # noqa: F401


@pytest.fixture
def environment(monkeypatch, request):
    yield from album_environment.__wrapped__(monkeypatch, request)


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_bulk_routes_never_borrow_or_modify_real_database(environment, monkeypatch):
    env = environment
    before = state(env)
    with psycopg.connect(env["dsn"]) as observer:
        shadow_before = observer.execute("SELECT * FROM portal_json_collections ORDER BY collection_name").fetchall()
        cached = [{"id": 1, "event_name": "Cached sentinel"}]
        app_core._memory_cache.set("albums", cached)

        def forbidden(*args, **kwargs):
            pytest.fail("Rejected bulk operation must not borrow or run the mutator")

        # An already-open connection must also be safe from the internal helper.
        with monkeypatch.context() as patch:
            patch.setattr(env["pool"], "getconn", forbidden)
            for payload in ([], [{"id": 1, "event_name": "Uncommitted replacement", "photos": []}]):
                actions = [
                    lambda: repo.replace_collection("albums", payload, allow_bulk=True),
                    lambda: repo._replace_collection_in(observer, "albums", payload),
                    lambda: repo.save_generic_json_collection("albums", payload),
                    lambda: repo.mutate_collection_locked("albums", forbidden),
                    lambda: app_core.save_json_data("albums", payload),
                    lambda: app_core.mutate_json_data("albums", forbidden),
                    lambda: app_core.db_replace_collection("albums", payload, allow_bulk=True),
                    lambda: app_core.db_save_generic_json_collection("albums", payload),
                    lambda: app_core.db_mutate_collection_locked("albums", forbidden),
                ]
                with observer.cursor() as cursor:
                    actions.extend([
                        lambda: rows.db_delete_collection_children(cursor, "albums"),
                        lambda: app_core.db_delete_collection_children(cursor, "albums"),
                    ])
                    for action in actions:
                        with pytest.raises(HTTPException) as error:
                            action()
                        assert (error.value.status_code, error.value.detail) == (409, "albums requires the row-level API")
            assert observer.execute("SELECT 1").fetchone() == (1,)
        assert observer.execute("SELECT * FROM portal_json_collections ORDER BY collection_name").fetchall() == shadow_before
        assert app_core._memory_cache.get("albums") == cached
    assert state(env) == before
    assert env["bucket"].counts["delete_calls"] == 0


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_row_updates_and_other_generic_json_writes_still_work(environment):
    before = state(environment)
    response, _ = call(environment, "PUT", "/api/extra/albums/1", json={"event_name": "Row update"})
    assert response.status_code == 200
    assert state(environment)[0][0] == "Row update"
    assert state(environment)[1] == before[1]
    repo.save_generic_json_collection("synthetic_bulk_control", [{"fixture": True}])
    assert repo.load_generic_json_collection("synthetic_bulk_control") == [{"fixture": True}]


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_sync_sql_helpers_retain_upsert_and_empty_source_delete(environment):
    from scripts.sync_prod_to_test_db import TableSpec, _prepare_and_upsert_rows, _delete_rows_absent_from_source

    # Exercise the actual sync SQL helpers, not the app's forbidden list writer.
    # Roll back synthetic modifications; this is not a live sync/role test.
    spec = TableSpec("albums", ("id", "organization_id", "event_name"), ("id",), ())
    with psycopg.connect(environment["dsn"]) as conn:
        with conn.cursor() as cursor:
            _prepare_and_upsert_rows(cursor, spec, [(1, "synthetic-sync", "Synced")])
            assert cursor.execute("SELECT event_name FROM albums WHERE id=1").fetchone() == ("Synced",)
            child = TableSpec("album_photos", ("id",), ("id",), ())
            _delete_rows_absent_from_source(cursor, child, [])
            _delete_rows_absent_from_source(cursor, spec, [])
            assert cursor.execute("SELECT count(*) FROM album_photos").fetchone() == (0,)
            assert cursor.execute("SELECT count(*) FROM albums").fetchone() == (0,)
        conn.rollback()
