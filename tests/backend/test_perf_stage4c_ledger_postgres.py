"""Inert ledger migration only, on the owned loopback stage-4 PostgreSQL DB."""
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql
import pytest

from scripts.sync_prod_to_test_db import _excluded_fingerprints
from scripts.sync_prod_to_test_preflight import EXCLUDED_DB_TABLES, TARGET_DB_TABLES
from test_perf_stage4_postgres import isolated_db as isolated_db  # noqa: F401


MIGRATION = Path("db/migrations/024_album_asset_ledger_foundation.sql")
TABLES = ("album_asset_gc_control", "album_storage_assets", "album_asset_gc_candidates", "album_asset_read_leases")


@pytest.fixture
def environment(monkeypatch, request):
    from test_album_put_photos_postgres import environment as album_environment

    yield from album_environment.__wrapped__(monkeypatch, request)


@pytest.fixture
def database(request):
    # isolated_db validates explicit loopback DSN, DB name and the ownership marker.
    dsn = request.getfixturevalue("isolated_db")
    with psycopg.connect(dsn, connect_timeout=5, autocommit=True) as conn:
        conn.execute("DROP SCHEMA public CASCADE")
        conn.execute("CREATE SCHEMA public")
        conn.execute("CREATE TABLE stage4_fixture_owner (owner text PRIMARY KEY)")
        conn.execute("INSERT INTO stage4_fixture_owner VALUES ('perf-stage4-0')")
        conn.execute("CREATE TABLE albums (id int PRIMARY KEY, event_name text)")
        conn.execute("CREATE TABLE album_photos (id int PRIMARY KEY, album_id int REFERENCES albums(id), filename text)")
        conn.execute("INSERT INTO albums VALUES (1,'Before')")
        conn.execute("INSERT INTO album_photos VALUES (11,1,'fixture.jpg')")
        if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname='perf_album_app'").fetchone():
            conn.execute("CREATE ROLE perf_album_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION")
        conn.execute("GRANT USAGE ON SCHEMA public TO perf_album_app")
        conn.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON albums,album_photos TO perf_album_app")
        yield conn


@pytest.fixture
def ledger(database):
    with database.transaction():
        database.execute(MIGRATION.read_text(encoding="utf-8"))
    environment = uuid4()
    database.execute("INSERT INTO album_asset_gc_control(environment_uuid,bucket) VALUES (%s,'synthetic-album-fixture')", (environment,))
    return database, environment


def asset(conn, environment, **values):
    data = dict(environment_uuid=environment, bucket="synthetic-album-fixture", object_name=f"albums/synthetic/{uuid4()}.jpg", generation=1, kind="original")
    data.update(values)
    return conn.execute(
        sql.SQL("INSERT INTO album_storage_assets ({}) VALUES ({}) RETURNING asset_id").format(
            sql.SQL(",").join(map(sql.Identifier, data)),
            sql.SQL(",").join(sql.Placeholder() for _ in data)), tuple(data.values())
    ).fetchone()[0]


def test_migration_is_empty_disabled_and_does_not_change_album_contract(database):
    before = database.execute("SELECT * FROM album_photos").fetchall()
    with database.transaction():
        database.execute(MIGRATION.read_text(encoding="utf-8"))
    for table in TABLES:
        assert database.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone() == (0,)
    assert database.execute("SELECT * FROM album_photos").fetchall() == before
    assert database.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='album_photos' ORDER BY ordinal_position").fetchall() == [("id",), ("album_id",), ("filename",)]
    assert database.execute("SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('albums'::regclass,'album_photos'::regclass) AND NOT tgisinternal").fetchone() == (0,)
    with psycopg.connect(psycopg.conninfo.make_conninfo(database.info.dsn, user="perf_album_app")) as app:
        app.execute("UPDATE albums SET event_name='After' WHERE id=1")
        app.execute("DELETE FROM album_photos WHERE id=11")
        app.execute("INSERT INTO album_photos VALUES (12,1,'new.jpg')")
    assert database.execute("SELECT filename FROM album_photos").fetchall() == [("new.jpg",)]


def test_migration_rollback_and_second_application_fail_atomically(database):
    with pytest.raises(RuntimeError), database.transaction():
        database.execute(MIGRATION.read_text(encoding="utf-8"))
        raise RuntimeError("Synthetic interruption")
    assert database.execute("SELECT to_regclass('public.album_asset_gc_control')").fetchone() == (None,)
    with database.transaction():
        database.execute(MIGRATION.read_text(encoding="utf-8"))
    with pytest.raises(psycopg.errors.DuplicateTable), database.transaction():
        database.execute(MIGRATION.read_text(encoding="utf-8"))
    assert database.execute("SELECT count(*) FROM album_asset_gc_control").fetchone() == (0,)


def test_existing_migration_runner_records_checksum_and_skips_reapplication(database, monkeypatch, tmp_path):
    from scripts import migrate_db
    from hashlib import sha256

    copied = tmp_path / MIGRATION.name
    copied.write_bytes(MIGRATION.read_bytes())
    monkeypatch.setattr(migrate_db, "MIGRATIONS_DIR", tmp_path)
    monkeypatch.setattr(migrate_db, "connection_string", lambda: database.info.dsn)
    migrate_db.main()
    migrate_db.main()
    assert database.execute("SELECT version,checksum FROM schema_migrations").fetchall() == [("024", sha256(MIGRATION.read_bytes()).hexdigest())]
    copied.write_text(copied.read_text(encoding="utf-8") + "\n-- changed copy\n", encoding="utf-8")
    with pytest.raises(SystemExit, match="Checksum mismatch"):
        migrate_db.main()


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_real_album_put_stays_unchanged_with_foundation_installed(environment):
    from test_perf_stage4_postgres import call
    from test_album_put_photos_postgres import state

    with psycopg.connect(environment["dsn"], connect_timeout=5) as conn:
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
    photos = state(environment)[1]
    response, _ = call(environment, "PUT", "/api/extra/albums/1", json={"event_name": "Foundation installed"})
    assert response.status_code == 200
    assert state(environment)[1] == photos
    assert len(response.json()["photos"]) == 25
    assert not {"asset_id", "generation", "bucket", "environment_uuid"} & response.json()["photos"][0].keys()
    with psycopg.connect(environment["dsn"], connect_timeout=5) as conn:
        for table in TABLES:
            assert conn.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone() == (0,)


def test_even_owner_cannot_enable_unfinished_guard(ledger):
    conn, _ = ledger
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute("UPDATE album_asset_gc_control SET guard_enabled=true")
    assert conn.execute("SELECT guard_enabled FROM album_asset_gc_control").fetchall() == [(False,)]


def test_unsafe_default_app_grants_abort_migration(database):
    database.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO perf_album_app")
    try:
        with pytest.raises(psycopg.errors.RaiseException, match="owner-only ACLs"), database.transaction():
            database.execute(MIGRATION.read_text(encoding="utf-8"))
        assert database.execute("SELECT to_regclass('public.album_asset_gc_control')").fetchone() == (None,)
    finally:
        database.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM perf_album_app")


@pytest.mark.parametrize("table", TABLES)
@pytest.mark.parametrize("operation", ["SELECT * FROM {}", "INSERT INTO {} DEFAULT VALUES", "UPDATE {} SET created_at=created_at", "DELETE FROM {}", "TRUNCATE {}"])
def test_separate_app_login_has_no_ledger_access_even_with_protocol_settings(ledger, table, operation):
    conn, _ = ledger
    dsn = psycopg.conninfo.make_conninfo(conn.info.dsn, user="perf_album_app")
    with psycopg.connect(dsn, autocommit=True) as app:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), app.transaction():
            app.execute("SET LOCAL app.album_delete_protocol='v2'")
            app.execute("SET LOCAL app.portal_sync_mode='on'")
            app.execute(sql.SQL(operation).format(sql.Identifier(table)))


@pytest.mark.parametrize("values,error", [
    ({"generation": 0}, psycopg.errors.CheckViolation),
    ({"generation": -1}, psycopg.errors.CheckViolation),
    ({"object_name": " "}, psycopg.errors.CheckViolation),
    ({"state": "unknown"}, psycopg.errors.CheckViolation),
    ({"state": "deleting"}, psycopg.errors.CheckViolation),
    ({"claim_token": uuid4()}, psycopg.errors.CheckViolation),
    ({"kind": "thumbnail"}, psycopg.errors.CheckViolation),
    ({"environment_uuid": uuid4()}, psycopg.errors.ForeignKeyViolation),
    ({"bucket": "other-fixture"}, psycopg.errors.ForeignKeyViolation),
])
def test_invalid_asset_identity_or_state_fails_closed(ledger, values, error):
    conn, environment = ledger
    with pytest.raises(error), conn.transaction():
        asset(conn, environment, **values)
    assert conn.execute("SELECT count(*) FROM album_storage_assets").fetchone() == (0,)


def test_generation_identity_and_original_parent_constraints(ledger):
    conn, environment = ledger
    original = asset(conn, environment, object_name="albums/synthetic/fixed.jpg", generation=18446744073709551615)
    with pytest.raises(psycopg.errors.UniqueViolation), conn.transaction():
        asset(conn, environment, object_name="albums/synthetic/fixed.jpg", generation=18446744073709551615)
    asset(conn, environment, object_name="albums/synthetic/fixed.jpg", generation=2)
    thumbnail = asset(conn, environment, kind="thumbnail", parent_asset_id=original)
    for parent in (uuid4(), thumbnail):
        with pytest.raises(psycopg.errors.ForeignKeyViolation), conn.transaction():
            asset(conn, environment, kind="thumbnail", parent_asset_id=parent)
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        asset(conn, environment, parent_asset_id=original)
    assert conn.execute("SELECT parent_kind FROM album_storage_assets WHERE asset_id=%s", (thumbnail,)).fetchone() == ("original",)


def test_candidate_dedup_requeue_and_commit_observation_grace(ledger):
    conn, environment = ledger
    original = asset(conn, environment)
    conn.execute("INSERT INTO album_asset_gc_candidates(asset_id) VALUES (%s)", (original,))
    assert conn.execute("SELECT first_observed_at,not_before FROM album_asset_gc_candidates").fetchone() == (None, None)
    for status in ("pending", "held"):
        with pytest.raises(psycopg.errors.UniqueViolation), conn.transaction():
            conn.execute("INSERT INTO album_asset_gc_candidates(asset_id,status) VALUES (%s,%s)", (original, status))
    for expression in ("not_before=clock_timestamp()", "first_observed_at=clock_timestamp()", "first_observed_at=statement_timestamp(),not_before=statement_timestamp()+interval '167 hours'"):
        with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
            conn.execute("UPDATE album_asset_gc_candidates SET " + expression)
    conn.execute("UPDATE album_asset_gc_candidates SET first_observed_at=statement_timestamp(),not_before=statement_timestamp()+interval '168 hours'")
    conn.execute("UPDATE album_asset_gc_candidates SET status='cancelled'")
    conn.execute("INSERT INTO album_asset_gc_candidates(asset_id) VALUES (%s)", (original,))
    assert conn.execute("SELECT count(*) FROM album_asset_gc_candidates").fetchone() == (2,)
    assert conn.execute("SELECT not_before FROM album_asset_gc_candidates WHERE status='pending'").fetchone() == (None,)
    with pytest.raises(psycopg.errors.ForeignKeyViolation), conn.transaction():
        conn.execute("DELETE FROM album_storage_assets WHERE asset_id=%s", (original,))


def test_lease_defaults_are_five_minutes_and_duplicates_fail(ledger):
    conn, environment = ledger
    original = asset(conn, environment)
    lease = conn.execute("INSERT INTO album_asset_read_leases(asset_id) VALUES (%s) RETURNING lease_id,extract(epoch FROM expires_at-renewed_at)", (original,)).fetchone()
    assert lease[1] == 300
    with pytest.raises(psycopg.errors.UniqueViolation), conn.transaction():
        conn.execute("INSERT INTO album_asset_read_leases(asset_id,lease_id) VALUES (%s,%s)", (original, lease[0]))
    for seconds in (0, 301):
        with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
            conn.execute("UPDATE album_asset_read_leases SET expires_at=renewed_at+%s*interval '1 second'", (seconds,))


def test_sync_fingerprint_includes_all_environment_owned_state(ledger):
    conn, environment = ledger
    assert set(TABLES) <= set(EXCLUDED_DB_TABLES)
    assert not set(TABLES) & set(TARGET_DB_TABLES)
    original = asset(conn, environment)
    with conn.cursor() as cursor:
        before = _excluded_fingerprints(cursor, set(TABLES))
        assert set(before) == set(TABLES)
        conn.execute("UPDATE albums SET event_name='Synced fixture' WHERE id=1")
        assert _excluded_fingerprints(cursor, set(TABLES)) == before
        conn.execute("INSERT INTO album_asset_read_leases(asset_id) VALUES (%s)", (original,))
        after = _excluded_fingerprints(cursor, set(TABLES))
        assert after["album_asset_read_leases"] != before["album_asset_read_leases"]
