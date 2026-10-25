"""Private references only; no real registration/GC or production connections."""
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from scripts.sync_prod_to_test_db import _table_spec, _assert_album_sync_unbound, _fetch_source_rows, _prepare_and_upsert_rows
from src.backend.services.album_asset_fields import ALBUM_PHOTO_INTERNAL_COLUMNS
from test_perf_stage4c_ledger_postgres import database as database, ledger as ledger, asset  # noqa: F401
from test_perf_stage4_postgres import isolated_db as isolated_db, call  # noqa: F401


MIGRATION = Path("db/migrations/026_album_photo_asset_references.sql")


@pytest.fixture
def prepared(request):
    conn, environment = request.getfixturevalue("ledger")
    conn.execute("ALTER TABLE albums ADD COLUMN organization_id text NOT NULL DEFAULT 'synthetic'")
    conn.execute("ALTER TABLE album_photos ADD COLUMN organization_id text NOT NULL DEFAULT 'synthetic', ADD COLUMN object_name text, ADD COLUMN path text, ADD COLUMN url text, ADD COLUMN uploaded_at timestamptz")
    conn.execute("UPDATE album_photos SET object_name='albums/synthetic/fixture.jpg',url='/api/albums/1/photos/11'")
    with conn.transaction():
        conn.execute(Path("db/migrations/025_album_write_protocol.sql").read_text(encoding="utf-8"))
    return conn, environment


@pytest.fixture
def linked(prepared):
    conn, environment = prepared
    with conn.transaction():
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
    original = asset(conn, environment, object_name="albums/synthetic/fixture.jpg")
    thumbnail = asset(conn, environment, kind="thumbnail", parent_asset_id=original)
    conn.execute("UPDATE album_photos SET original_asset_id=%s,thumbnail_asset_id=%s WHERE id=11", (original, thumbnail))
    return conn, environment, original, thumbnail


def bindings(conn):
    return conn.execute("SELECT original_asset_id,thumbnail_asset_id FROM album_photos WHERE id=11").fetchone()


def test_migration_preserves_rows_does_not_rewrite_heap_and_keeps_guard_off(prepared):
    conn, _ = prepared
    before = conn.execute("SELECT id,filename,object_name,url,uploaded_at FROM album_photos").fetchall()
    heap = conn.execute("SELECT pg_relation_filenode('album_photos'::regclass)").fetchone()
    with conn.transaction():
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert conn.execute("SELECT pg_relation_filenode('album_photos'::regclass)").fetchone() == heap
    assert conn.execute("SELECT id,filename,object_name,url,uploaded_at FROM album_photos").fetchall() == before
    assert bindings(conn) == (None, None)
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute("UPDATE album_asset_gc_control SET guard_enabled=true")


def test_migration_rolls_back_and_checks_prerequisites(prepared):
    conn, _ = prepared
    with pytest.raises(RuntimeError), conn.transaction():
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
        raise RuntimeError("synthetic")
    assert conn.execute("SELECT count(*) FROM information_schema.columns WHERE table_name='album_photos' AND column_name='original_asset_id'").fetchone() == (0,)
    conn.execute("ALTER TABLE album_photos ALTER COLUMN organization_id DROP NOT NULL")
    with pytest.raises(psycopg.errors.RaiseException, match="Non-null organization"), conn.transaction():
        conn.execute(MIGRATION.read_text(encoding="utf-8"))


def test_typed_original_and_matching_thumbnail_parent_are_required(linked):
    conn, env, original, thumbnail = linked
    other = asset(conn, env)
    wrong_thumbnail = asset(conn, env, kind="thumbnail", parent_asset_id=other)
    for original_id, thumbnail_id in ((thumbnail, None), (original, original), (original, wrong_thumbnail), (None, thumbnail), (uuid4(), None)):
        with pytest.raises(psycopg.IntegrityError), conn.transaction():
            conn.execute("UPDATE album_photos SET original_asset_id=%s,thumbnail_asset_id=%s WHERE id=11", (original_id, thumbnail_id))
    assert bindings(conn) == (original, thumbnail)
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute("UPDATE album_photos SET original_asset_kind='thumbnail'")


@pytest.mark.parametrize("column,value,expected", [("filename", "renamed.jpg", "both"), ("object_name", "albums/new.jpg", "none"), ("path", "local/new.jpg", "none"), ("url", "/api/new", "original"), ("uploaded_at", "2026-10-25T00:00:00Z", "original"), ("organization_id", "other", "original")])
def test_public_changes_preserve_or_detach_only_relevant_bindings(linked, column, value, expected):
    from psycopg import sql
    conn, _, original, thumbnail = linked
    with psycopg.connect(psycopg.conninfo.make_conninfo(conn.info.dsn, user="perf_album_app")) as app:
        app.execute(sql.SQL("UPDATE album_photos SET {}=%s WHERE id=11").format(sql.Identifier(column)), (value,))
    assert bindings(conn) == {"both": (original, thumbnail), "none": (None, None), "original": (original, None)}[expected]


def test_sync_refuses_bound_target_before_mutation_and_lock_is_held(linked):
    conn, _, original, thumbnail = linked
    with conn.cursor() as cursor:
        spec = _table_spec(cursor, "album_photos")
        with pytest.raises(RuntimeError, match="rebinding"), conn.transaction():
            _assert_album_sync_unbound(cursor, spec)
    assert bindings(conn) == (original, thumbnail)


def test_sync_reads_public_only_and_accepts_unbound_target_under_lock(linked):
    conn, _, _, _ = linked
    with conn.cursor() as cursor:
        source = _table_spec(cursor, "album_photos")
        source_rows = _fetch_source_rows(cursor, source)
        assert not set(source.columns) & ALBUM_PHOTO_INTERNAL_COLUMNS
    conn.execute("UPDATE album_photos SET original_asset_id=NULL,thumbnail_asset_id=NULL")
    with conn.transaction(), conn.cursor() as cursor:
        _assert_album_sync_unbound(cursor, source)
        with psycopg.connect(conn.info.dsn, autocommit=True) as other:
            other.execute("SET lock_timeout='100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                other.execute("UPDATE album_photos SET filename='race' WHERE id=11")
        _prepare_and_upsert_rows(cursor, source, source_rows)
    assert bindings(conn) == (None, None)


@pytest.fixture
def environment(monkeypatch, request):
    from test_album_put_photos_postgres import environment as base
    yield from base.__wrapped__(monkeypatch, request)


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_actual_api_hides_refs_preserves_them_and_ignores_forged_client_values(environment):
    from test_perf_stage3a_postgres import TENANT
    from src.backend import app_core
    from src.backend.repositories.album_repository import AlbumRepository
    dsn = environment["dsn"]
    with psycopg.connect(dsn, connect_timeout=5, autocommit=True) as conn:
        for path in ("024_album_asset_ledger_foundation.sql", "025_album_write_protocol.sql", MIGRATION.name):
            with conn.transaction():
                conn.execute((Path("db/migrations") / path).read_text(encoding="utf-8"))
        env = uuid4()
        conn.execute("INSERT INTO album_asset_gc_control(environment_uuid,bucket) VALUES (%s,'synthetic-album-fixture')", (env,))
        original = asset(conn, env, object_name=environment["albums"][0]["photos"][0]["object_name"])
        thumbnail = asset(conn, env, kind="thumbnail", parent_asset_id=original)
        conn.execute("UPDATE album_photos SET original_asset_id=%s,thumbnail_asset_id=%s WHERE id=1 AND organization_id=%s", (original, thumbnail, TENANT))
        response, _ = call(environment, "PUT", "/api/extra/albums/1", json={"event_name": "Rename"})
        assert response.status_code == 200
        photo = response.json()["photos"][0]
        assert not set(photo) & ALBUM_PHOTO_INTERNAL_COLUMNS
        photos = response.json()["photos"]
        photos[0].update({key: "forged" for key in ALBUM_PHOTO_INTERNAL_COLUMNS})
        photos[0]["filename"] = "metadata.jpg"
        assert call(environment, "PUT", "/api/extra/albums/1", json={"event_name": "Rename", "photos": photos})[0].status_code == 200
        assert conn.execute("SELECT original_asset_id,thumbnail_asset_id FROM album_photos WHERE id=1").fetchone() == (original, thumbnail)
        assert not set(AlbumRepository().find_photo(1, 1, store=app_core.row_store())) & ALBUM_PHOTO_INTERNAL_COLUMNS
        assert not set(app_core.row_store().get("albums", 1)["photos"][0]) & ALBUM_PHOTO_INTERNAL_COLUMNS
        assert conn.execute("SELECT count(*) FROM album_asset_gc_candidates").fetchone() == (0,)
