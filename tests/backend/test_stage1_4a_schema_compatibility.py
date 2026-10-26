"""Release boundary: 023 is optional only while its feature flags are disabled.

Reuse the guarded stage-3 loopback database, never DB_URL or a live migration.
024--033 are deliberately unavailable in this release tree.
"""
from pathlib import Path

from fastapi.testclient import TestClient
import psycopg
from psycopg.conninfo import make_conninfo
import pytest

from src.backend import app_core, main
from src.backend.core import db_pool, db_runtime
from src.backend.core.collection_clock_schema import configured_paths
from src.backend.core.tenant_context import set_current_tenant_id, reset_current_tenant_id
from test_perf_stage3_postgres import database, DSN, TENANT  # noqa: F401

pytestmark = pytest.mark.skipif(not DSN, reason="dedicated stage-3 loopback PostgreSQL required")


def startup_check(dsn):
    db_runtime.run_db_startup_self_check(
        db_expected_func=lambda: True,
        ensure_db_expected_is_ready_func=lambda: None,
        assert_db_ready_func=lambda: None,
        psycopg=db_pool.pooled_psycopg,
        db_connection_string_func=lambda: dsn,
    )


@pytest.mark.parametrize("database", [{"install_clocks": False}, {"install_clocks": True}],
                         indirect=True, ids=["without-023", "with-023"])
def test_disabled_features_start_read_and_write_without_gc_schema(database, monkeypatch):  # noqa: F811
    dsn = make_conninfo(**database)
    monkeypatch.setenv("DB_URL", dsn)
    monkeypatch.delenv("PORTAL_READ_CONTEXT_PATHS", raising=False)
    monkeypatch.delenv("PORTAL_VERSION_ETAG_PATHS", raising=False)
    assert configured_paths() == (frozenset(), frozenset())
    with psycopg.connect(dsn) as conn:
        assert conn.execute("SELECT to_regclass('public.album_storage_assets')").fetchone()[0] is None
    assert not any(p.name[:3].isdigit() and int(p.name[:3]) >= 24
                   for p in Path("db/migrations").glob("*.sql"))
    with db_pool.web_database_runtime():
        db_pool.open_db_pool()
        try:
            startup_check(dsn)
            with TestClient(main.app) as client:
                client.headers.update({"X-Tenant-Id": TENANT, "X-Device-Id": "perf-device"})
                first = client.get("/api/schedules")
                assert first.status_code == 200
                assert client.get("/api/schedules", headers={"If-None-Match": first.headers["ETag"]}).status_code == 304
                assert client.get("/api/bootstrap-lite").status_code == 200
                # Exercise the real repository transaction with #150 omission
                # semantics; no file storage or authentication mocks are used.
                token = set_current_tenant_id(TENANT)
                try:
                    store = app_core.row_store()
                    before = store.get("albums", 1)
                    assert before["photos"]
                    saved = store.update("albums", 1, lambda current: {"id": 1, "event_name": "Renamed"})
                    assert saved["photos"] == before["photos"]
                finally:
                    reset_current_tenant_id(token)
        finally:
            db_pool.close_db_pool()


@pytest.mark.parametrize("database", [{"install_clocks": False}], indirect=True)
@pytest.mark.parametrize("enable_clock", [False, True], ids=["snapshot-only", "version-etag"])
def test_enabling_stage3_without_023_fails_closed(database, monkeypatch, enable_clock):  # noqa: F811
    dsn = make_conninfo(**database)
    monkeypatch.setenv("DB_URL", dsn)
    monkeypatch.setenv("PORTAL_READ_CONTEXT_PATHS", "/api/schedules")
    monkeypatch.setenv("PORTAL_VERSION_ETAG_PATHS", "/api/schedules" if enable_clock else "")
    try:
        if enable_clock:
            with pytest.raises(RuntimeError, match="Collection clocks are not installed"):
                db_pool.open_db_pool()
            assert db_pool._pool is None
        else:
            db_pool.open_db_pool()
            with pytest.raises(RuntimeError, match="Collection clocks are not installed"):
                startup_check(dsn)
    finally:
        db_pool.close_db_pool()
