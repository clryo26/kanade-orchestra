"""Protocol-only guard; activation is forced ONLY inside the owned test DB."""
import json
import os
from pathlib import Path

import psycopg
import pytest

from src.backend.core import db_pool
from src.backend.repositories.db_item_repository import PostgresRowStore
from test_perf_stage4c_ledger_postgres import database as database, ledger as ledger  # noqa: F401
from test_perf_stage4_postgres import isolated_db as isolated_db, call  # noqa: F401


MIGRATION = Path("db/migrations/025_album_write_protocol.sql")
MEASUREMENTS = []


@pytest.fixture(scope="module", autouse=True)
def save_measurements():
    yield
    target = os.getenv("PORTAL_STAGE4C_PROTOCOL_REPORT", "")
    if target:
        path = Path(target).resolve()
        assert path.parent == (Path.cwd() / "docs/perf_stage4").resolve()
        assert path.name in {"STAGE4C_PROTOCOL_PG16.json", "STAGE4C_PROTOCOL_PG18.json"}
        with path.open("x", encoding="utf-8") as out:
            json.dump({"measurements": MEASUREMENTS, "scope": "synthetic loopback; not live latency or GCS counts"}, out, indent=2)
            out.write("\n")


@pytest.fixture
def protocol(request):
    conn, environment = request.getfixturevalue("ledger")
    with conn.transaction():
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
    conn.execute("GRANT TRUNCATE ON albums,album_photos TO perf_album_app")
    return conn, environment


@pytest.fixture
def armed(protocol):
    conn, environment = protocol
    # There is deliberately NO equivalent activation helper in app/migrations.
    # This tests incomplete protocol enforcement in isolation, not GC readiness.
    conn.execute("ALTER TABLE album_asset_gc_control DROP CONSTRAINT album_gc_foundation_guard_disabled")
    conn.execute("UPDATE album_asset_gc_control SET guard_enabled=true")
    return conn, environment


def app_connection(conn, **kwargs):
    return psycopg.connect(psycopg.conninfo.make_conninfo(conn.info.dsn, user="perf_album_app"), **kwargs)


def test_migration_retains_safety_and_disabled_or_missing_control_preserves_legacy(protocol):
    conn, _ = protocol
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute("UPDATE album_asset_gc_control SET guard_enabled=true")
    for missing in (False, True):
        if missing:
            conn.execute("DELETE FROM album_asset_gc_control")
        with app_connection(conn) as app:
            app.execute("UPDATE albums SET event_name='Legacy write' WHERE id=1")
            app.execute("UPDATE album_photos SET filename='legacy.jpg' WHERE id=11")
    assert conn.execute("SELECT count(*) FROM pg_trigger WHERE tgname IN ('album_write_protocol','album_photo_write_protocol','album_truncate_protocol','album_photo_truncate_protocol') AND tgenabled='O'").fetchone() == (4,)


def test_migration_rollback_and_fixed_definer_permissions(request):
    conn, _ = request.getfixturevalue("ledger")
    with pytest.raises(RuntimeError), conn.transaction():
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
        raise RuntimeError("synthetic rollback")
    assert conn.execute("SELECT to_regprocedure('public.album_require_write_protocol()')").fetchone() == (None,)
    with conn.transaction():
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert conn.execute("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.album_require_write_protocol()'::regprocedure").fetchone() == (True, ["search_path=pg_catalog"])
    assert conn.execute("SELECT has_function_privilege('perf_album_app','public.album_require_write_protocol()','EXECUTE')").fetchone() == (False,)
    assert conn.execute("SELECT has_table_privilege('perf_album_app','public.album_asset_gc_control','SELECT')").fetchone() == (False,)


def test_missing_foundation_safety_aborts_migration(request):
    conn, _ = request.getfixturevalue("ledger")
    conn.execute("ALTER TABLE album_asset_gc_control DROP CONSTRAINT album_gc_foundation_guard_disabled")
    with pytest.raises(psycopg.errors.RaiseException, match="safety constraint required"), conn.transaction():
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert conn.execute("SELECT to_regprocedure('public.album_require_write_protocol()')").fetchone() == (None,)


def test_unsafe_default_function_grants_abort_migration(request):
    conn, _ = request.getfixturevalue("ledger")
    conn.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO perf_album_app")
    try:
        with pytest.raises(psycopg.errors.RaiseException, match="owner-only function ACLs"), conn.transaction():
            conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert conn.execute("SELECT to_regprocedure('public.album_require_write_protocol()')").fetchone() == (None,)
    finally:
        conn.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM perf_album_app")


def test_existing_migration_runner_applies_024_then_025_and_skips(request, monkeypatch, tmp_path):
    from scripts import migrate_db
    conn = request.getfixturevalue("database")
    for path in (Path("db/migrations/024_album_asset_ledger_foundation.sql"), MIGRATION):
        (tmp_path / path.name).write_bytes(path.read_bytes())
    monkeypatch.setattr(migrate_db, "MIGRATIONS_DIR", tmp_path)
    monkeypatch.setattr(migrate_db, "connection_string", lambda: conn.info.dsn)
    migrate_db.main()
    migrate_db.main()
    assert conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall() == [("024",), ("025",)]
    assert conn.execute("SELECT count(*) FROM album_asset_gc_control").fetchone() == (0,)


STATEMENTS = [
    "INSERT INTO albums VALUES (2,'New')", "UPDATE albums SET event_name='New' WHERE id=1", "DELETE FROM albums WHERE id=1",
    "INSERT INTO album_photos VALUES (12,1,'new.jpg')", "UPDATE album_photos SET filename='new.jpg' WHERE id=11", "DELETE FROM album_photos WHERE id=11",
]


@pytest.mark.parametrize("statement", STATEMENTS)
@pytest.mark.parametrize("marker", [None, "v1", "sync_only"])
def test_guard_rejects_old_direct_and_forged_sync_writes(armed, statement, marker):
    conn, _ = armed
    with app_connection(conn, autocommit=True) as app:
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="require v2"), app.transaction():
            if marker == "sync_only":
                app.execute("SET LOCAL app.portal_sync_mode='on'")
            elif marker:
                app.execute("SELECT set_config('app.album_delete_protocol',%s,true)", (marker,))
            app.execute(statement)
    assert conn.execute("SELECT event_name FROM albums WHERE id=1").fetchone() == ("Before",)
    assert conn.execute("SELECT filename FROM album_photos WHERE id=11").fetchone() == ("fixture.jpg",)


def test_raw_autocommit_cannot_retain_set_local(armed):
    conn, _ = armed
    with app_connection(conn, autocommit=True) as app:
        app.execute("SET LOCAL app.album_delete_protocol='v2'")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            app.execute("UPDATE albums SET event_name='Not saved' WHERE id=1")


@pytest.mark.parametrize("target", ["album_photos", "albums,album_photos"])
def test_truncate_is_rejected_even_with_v2(armed, target):
    conn, _ = armed
    with app_connection(conn, autocommit=True) as app:
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="TRUNCATE"), app.transaction():
            app.execute("SET LOCAL app.album_delete_protocol='v2'")
            app.execute("TRUNCATE " + target)


def test_v2_allows_atomic_dml_but_marker_does_not_leak(armed):
    conn, _ = armed
    with app_connection(conn, autocommit=True) as app:
        with app.transaction():
            app.execute("SET LOCAL app.album_delete_protocol='v2'")
            app.execute("UPDATE albums SET event_name='V2' WHERE id=1")
            app.execute("UPDATE album_photos SET filename='v2.jpg' WHERE id=11")
            app.execute("INSERT INTO albums VALUES (2,'New')")
            app.execute("INSERT INTO album_photos VALUES (12,2,'new.jpg')")
            app.execute("DELETE FROM album_photos WHERE id=12")
            app.execute("DELETE FROM albums WHERE id=2")
        assert app.execute("SELECT current_setting('app.album_delete_protocol',true)").fetchone()[0] in (None, "")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            app.execute("UPDATE albums SET event_name='Old server' WHERE id=1")
    assert conn.execute("SELECT event_name FROM albums WHERE id=1").fetchone() == ("V2",)


def test_disabled_trigger_call_cost_is_counted(protocol):
    conn, _ = protocol
    conn.execute("SET track_functions='pl'")
    with conn.transaction():
        conn.execute("UPDATE albums SET event_name='One row' WHERE id=1")
        count = conn.execute("SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='public.album_require_write_protocol()'::regprocedure").fetchone()[0]
        assert count == 1
    MEASUREMENTS.append({"case": "disabled_guard_one_parent_update", "row_trigger_calls": count, "control_reads_in_function_per_call": 1})


def test_false_control_observation_holds_share_lock_until_writer_commits(protocol):
    conn, _ = protocol
    # Only the synthetic test setup removes the safety constraint.
    conn.execute("ALTER TABLE album_asset_gc_control DROP CONSTRAINT album_gc_foundation_guard_disabled")
    with app_connection(conn) as app:
        app.execute("UPDATE albums SET event_name='In flight' WHERE id=1")
        with pytest.raises(psycopg.errors.LockNotAvailable), conn.transaction():
            conn.execute("SET LOCAL lock_timeout='100ms'")
            conn.execute("UPDATE album_asset_gc_control SET guard_enabled=true")
    conn.execute("UPDATE album_asset_gc_control SET guard_enabled=true")


@pytest.fixture
def environment(monkeypatch, request):
    from test_album_put_photos_postgres import environment as album_environment
    monkeypatch.setattr(db_pool, "DB_POOL_MAX_SIZE", 1)
    monkeypatch.delenv("PORTAL_ALBUM_WRITE_PROTOCOL_V2", raising=False)
    yield from album_environment.__wrapped__(monkeypatch, request)


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_http_flag_off_cost_and_flag_on_use_one_extra_statement(environment, monkeypatch):
    from test_album_put_photos_postgres import state
    conninfo = environment["dsn"]
    with psycopg.connect(conninfo, connect_timeout=5) as conn:
        conn.execute(Path("db/migrations/024_album_asset_ledger_foundation.sql").read_text(encoding="utf-8"))
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
    before = state(environment)[1]
    # First HTTP access also warms auth-table schema metadata. Preserve it as
    # a separate measurement; compare opt-in against the same warm state.
    response, first = call(environment, "PUT", "/api/extra/albums/1", json={"event_name": "Warm"})
    assert response.status_code == 200
    response, baseline = call(environment, "PUT", "/api/extra/albums/1", json={"event_name": "Off"})
    assert response.status_code == 200
    monkeypatch.setenv("PORTAL_ALBUM_WRITE_PROTOCOL_V2", "true")
    # Test-only activation: prove the real HTTP writer carries the marker.
    with psycopg.connect(conninfo, connect_timeout=5) as conn:
        conn.execute("INSERT INTO album_asset_gc_control(environment_uuid,bucket) VALUES (gen_random_uuid(),'synthetic')")
        conn.execute("ALTER TABLE album_asset_gc_control DROP CONSTRAINT album_gc_foundation_guard_disabled")
        conn.execute("UPDATE album_asset_gc_control SET guard_enabled=true")
    response, enabled = call(environment, "PUT", "/api/extra/albums/1", json={"event_name": "On"})
    assert response.status_code == 200 and state(environment)[1] == before
    assert enabled["sql_statements"] == baseline["sql_statements"] + 1
    assert enabled["checkouts"] == baseline["checkouts"]
    MEASUREMENTS.append({"case": "name_only_http_put", "first_http_after_fixture_sql": first["sql_statements"], "warm_off_sql": baseline["sql_statements"], "warm_on_sql": enabled["sql_statements"], "off_checkouts": baseline["checkouts"], "on_checkouts": enabled["checkouts"], "limits": "Python-issued SQL; excludes trigger-internal control SELECT"})


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize("outcome", ["commit", "rollback"])
def test_real_store_shared_context_and_same_pool_connection_cleanup(environment, monkeypatch, outcome):
    monkeypatch.setenv("PORTAL_ALBUM_WRITE_PROTOCOL_V2", "true")
    store = PostgresRowStore()
    try:
        with store.transaction() as ctx:
            pid = ctx.conn.info.backend_pid
            store.update("albums", 1, lambda item: {**item, "event_name": "Updated"}, ctx=ctx)
            store.update_columns("albums", 1, {"event_name": "Again"}, ctx=ctx)
            ctx.cur.execute("SELECT current_setting('app.album_delete_protocol',true)")
            assert ctx.cur.fetchone() == ("v2",)
            if outcome == "rollback":
                raise RuntimeError("synthetic rollback")
    except RuntimeError as exc:
        assert outcome == "rollback" and str(exc) == "synthetic rollback"
    with db_pool.db_connection(db_pool._pool_dsn, autocommit=True) as conn:
        assert conn.info.backend_pid == pid
        assert conn.execute("SELECT current_setting('app.album_delete_protocol',true)").fetchone()[0] in (None, "")


@pytest.mark.parametrize("environment", [1], indirect=True)
@pytest.mark.parametrize("operation", ["insert", "update", "update_columns", "update_many", "delete"])
def test_all_store_write_methods_carry_protocol(environment, monkeypatch, operation):
    monkeypatch.setenv("PORTAL_ALBUM_WRITE_PROTOCOL_V2", "true")
    with psycopg.connect(environment["dsn"], connect_timeout=5) as conn:
        conn.execute(Path("db/migrations/024_album_asset_ledger_foundation.sql").read_text(encoding="utf-8"))
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
        conn.execute("INSERT INTO album_asset_gc_control(environment_uuid,bucket) VALUES (gen_random_uuid(),'synthetic')")
        conn.execute("ALTER TABLE album_asset_gc_control DROP CONSTRAINT album_gc_foundation_guard_disabled")
        conn.execute("UPDATE album_asset_gc_control SET guard_enabled=true")
    store = PostgresRowStore()
    actions = {
        "insert": lambda: store.insert("albums", lambda _id: {"event_name": "New", "photos": []}),
        "update": lambda: store.update("albums", 1, lambda item: {**item, "event_name": "New"}),
        "update_columns": lambda: store.update_columns("albums", 1, {"event_name": "New"}),
        "update_many": lambda: store.update_many("albums", {1: {"event_name": "New"}}),
        "delete": lambda: store.delete("albums", 1, lambda _item: None),
    }
    actions[operation]()
