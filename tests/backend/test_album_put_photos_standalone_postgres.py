"""Opt-in #150 HTTP/DB checks, independent of every performance fixture.

Only an empty or explicitly test-owned loopback DB is writable. No DB_URL fallback.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
from time import monotonic, sleep

from fastapi.testclient import TestClient
import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo
import pytest

from src.backend import app_core, main
from src.backend.core import db_pool, db_runtime
from src.backend.repositories import db_item_repository
from src.backend.repositories.db_row_repository import _ORG_COLUMN_CACHE

DB_NAME = "portal_issue150_standalone"
OWNER = "issue150-standalone-v1"
TENANT = "issue150-test"
ROOT = Path(__file__).resolve().parents[2]


def validate_test_dsn(dsn):
    info = conninfo_to_dict(dsn)
    # Reject DNS, socket, multi-host and service/hostaddr overrides before connecting.
    if (
        info.get("host") not in {"127.0.0.1", "::1"}
        or info.get("dbname") != DB_NAME
        or info.get("user") != "issue150"
        or not info.get("port", "").isdigit()
        or any(key in info for key in ("hostaddr", "service", "options"))
    ):
        raise ValueError("Issue 150 tests require the explicitly owned loopback database")
    # Explicit values also prevent libpq environment overrides from redirecting I/O.
    return make_conninfo(
        dsn,
        connect_timeout="3",
        application_name="issue150-standalone",
        hostaddr=info["host"],
        options="-c search_path=public",
    )


@pytest.mark.parametrize(
    "dsn",
    [
        "host=db.example dbname=portal_issue150_standalone user=issue150 port=63916",
        "host=127.0.0.1 dbname=production user=issue150 port=63916",
        "host=127.0.0.1 dbname=portal_issue150_standalone user=postgres port=63916",
        "host=127.0.0.1 hostaddr=192.0.2.1 dbname=portal_issue150_standalone user=issue150 port=63916",
    ],
)
def test_reject_nonisolated_dsn_before_connecting(dsn):
    with pytest.raises(ValueError):
        validate_test_dsn(dsn)


@pytest.fixture(scope="module")
def isolated_dsn():
    value = os.getenv("PORTAL_ISSUE150_TEST_DB_URL", "")
    if not value:
        pytest.skip("Set PORTAL_ISSUE150_TEST_DB_URL to the owned loopback test DB")
    dsn = validate_test_dsn(value)
    with psycopg.connect(dsn) as c:
        assert c.execute("SELECT current_database(),session_user").fetchone() == (
            DB_NAME,
            "issue150",
        )
        tables = {
            r[0] for r in c.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'")
        }
        if tables:
            assert "issue150_test_owner" in tables, "Refuse existing unowned DB; no reset performed"
            assert c.execute("SELECT owner FROM issue150_test_owner").fetchall() == [(OWNER,)]
        else:
            c.execute("CREATE TABLE issue150_test_owner (owner text PRIMARY KEY)")
            c.execute("INSERT INTO issue150_test_owner VALUES (%s)", (OWNER,))
            # Use main's schema builder, not a performance fixture or a live migration.
            db_runtime.ensure_db_schema_compatibility(c)
            c.execute(
                (ROOT / "db/migrations/002_operations_foundation.sql").read_text(
                    encoding="utf-8-sig"
                )
            )
            c.execute(
                "ALTER TABLE album_photos ADD CONSTRAINT issue150_album_fk "
                "FOREIGN KEY (album_id) REFERENCES albums(id)"
            )
    return dsn


@pytest.fixture
def pg_album(isolated_dsn, monkeypatch):
    import google.cloud.storage

    assert db_pool._pool is None, "Do not replace another application's pool"
    for key, value in {
        "DB_URL": isolated_dsn,
        "DATA_BACKEND": "db",
        "LOCAL_JSON_FALLBACK_ENABLED": "false",
        "AUDIT_LOG_ENABLED": "true",
        "WEB_PUSH_ENABLED": "false",
    }.items():
        monkeypatch.setenv(key, value)
    with psycopg.connect(isolated_dsn) as c:
        # Only the guarded test-owned DB reaches these explicit fixture deletes.
        for table in ("audit_logs", "album_photos", "albums", "auth_devices", "members"):
            c.execute(psycopg.sql.SQL("DELETE FROM {}").format(psycopg.sql.Identifier(table)))
        c.execute(
            "INSERT INTO members (id,organization_id,name,permission) VALUES (1,%s,'Creator','一般')",
            (TENANT,),
        )
        c.execute(
            "INSERT INTO auth_devices (id,organization_id,device_id,member_id,member_name,permission) "
            "VALUES (1,%s,'issue150-device',1,'Creator','一般')",
            (TENANT,),
        )
        c.execute(
            "INSERT INTO albums (id,organization_id,event_name,created_by_member_id,created_by_member_name,created_at,updated_at) "
            "VALUES (1,%s,'Before',1,'Creator','2026-10-23T00:00:00Z','2026-10-23T00:00:01Z')",
            (TENANT,),
        )
        for i in range(1, 4):
            c.execute(
                "INSERT INTO album_photos (id,organization_id,album_id,filename,url,object_name,path,uploaded_by_member_id,uploaded_by_member_name,uploaded_at,created_at,updated_at) "
                "VALUES (%s,%s,1,%s,%s,%s,'',1,'Creator','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z','2026-10-23T00:00:01Z')",
                (
                    i,
                    TENANT,
                    f"fixture-{i}.jpg",
                    f"/api/albums/1/photos/{i}",
                    f"albums/fixture-{i}.jpg",
                ),
            )
    app_core._memory_cache.clear_all_tenants()
    _ORG_COLUMN_CACHE.clear()
    monkeypatch.setattr(
        google.cloud.storage, "Client", lambda *a, **k: pytest.fail("Live GCS is forbidden")
    )
    db_pool.open_db_pool()
    assert db_pool._pool_dsn == isolated_dsn
    client = TestClient(main.app)  # No lifespan: no startup seeding/network.
    client.headers.update({"X-Tenant-Id": TENANT, "X-Device-Id": "issue150-device"})
    try:
        assert isinstance(app_core.row_store(), db_item_repository.PostgresRowStore)
        yield client, isolated_dsn
    finally:
        client.close()
        db_pool.close_db_pool()
        app_core._memory_cache.clear_all_tenants()
        _ORG_COLUMN_CACHE.clear()


def snapshot(dsn):
    with psycopg.connect(dsn) as c:
        parent = c.execute(
            "SELECT event_name,created_by_member_id,created_by_member_name,created_at,updated_at "
            "FROM albums WHERE id=1 AND organization_id=%s",
            (TENANT,),
        ).fetchone()
        photos = c.execute(
            "SELECT id,organization_id,album_id,filename,url,object_name,path,uploaded_by_member_id,uploaded_by_member_name,uploaded_at,created_at,updated_at FROM album_photos WHERE album_id=1 ORDER BY id"
        ).fetchall()
    return parent, photos


def test_omitted_put_keeps_real_rows_and_creator(pg_album):
    client, dsn = pg_album
    before, photos = snapshot(dsn)
    response = client.put("/api/extra/albums/1", json={"event_name": "After"})
    assert response.status_code == 200 and len(response.json()["photos"]) == 3
    after, saved = snapshot(dsn)
    assert after[0] == "After" and after[1:4] == before[1:4]
    assert after[4] > before[4] and saved == photos
    with psycopg.connect(dsn) as c:
        assert c.execute("SELECT status_code FROM audit_logs").fetchall() == [(200,)]


def test_explicit_empty_put_removes_only_references(pg_album):
    client, dsn = pg_album
    response = client.put("/api/extra/albums/1", json={"event_name": "After", "photos": []})
    assert response.status_code == 200 and response.json()["photos"] == []
    parent, photos = snapshot(dsn)
    assert parent[0:3] == ("After", 1, "Creator") and photos == []


def test_null_put_is_422_and_changes_no_rows(pg_album):
    client, dsn = pg_album
    before = snapshot(dsn)
    response = client.put(
        "/api/extra/albums/1", json={"event_name": "Must not save", "photos": None}
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "写真情報の形式が正しくありません"
    assert snapshot(dsn) == before
    with psycopg.connect(dsn) as c:
        assert c.execute("SELECT status_code FROM audit_logs").fetchall() == [(422,)]


def test_exception_after_child_write_rolls_back_parent_and_photos(pg_album, monkeypatch):
    client, dsn = pg_album
    before = snapshot(dsn)
    original = db_item_repository.PostgresRowStore._write_children

    def fail_after_write(self, *args, **kwargs):
        original(self, *args, **kwargs)
        raise RuntimeError("Injected failure after children")

    monkeypatch.setattr(db_item_repository.PostgresRowStore, "_write_children", fail_after_write)
    # Let a real application exception escape; do not replace the DB transaction.
    with pytest.raises(Exception, match="Injected failure after children"):
        client.put("/api/extra/albums/1", json={"event_name": "Must roll back"})
    assert snapshot(dsn) == before


def test_waiting_put_preserves_photo_removed_before_lock(pg_album):
    client, dsn = pg_album
    with ThreadPoolExecutor(max_workers=1) as executor:
        with psycopg.connect(dsn) as writer:
            writer.execute("SELECT id FROM albums WHERE id=1 FOR UPDATE")
            writer.execute("DELETE FROM album_photos WHERE id=3")
            future = executor.submit(
                client.put, "/api/extra/albums/1", json={"event_name": "After wait"}
            )
            deadline = monotonic() + 3
            while monotonic() < deadline:
                writer.execute("SELECT pg_stat_clear_snapshot()")
                waiting = writer.execute(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                    "AND application_name='issue150-standalone' AND wait_event_type='Lock'"
                ).fetchone()[0]
                if waiting:
                    break
                sleep(0.01)
            else:
                pytest.fail("PUT never reached the parent lock")
        response = future.result(timeout=5)
    assert response.status_code == 200
    assert [p["id"] for p in response.json()["photos"]] == [1, 2]
    assert [r[0] for r in snapshot(dsn)[1]] == [1, 2]
