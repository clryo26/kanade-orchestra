"""Stage 3 actual migration/route tests, isolated loopback database only."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from pathlib import Path
import os

import pytest
import psycopg
from psycopg.conninfo import conninfo_to_dict
from fastapi.testclient import TestClient

from src.backend import app_core, main
from src.backend.core import db_pool
from src.backend.core.collection_clock_schema import CLOCK_PATHS, table_dependencies
from src.backend.core.read_context import read_scope
from src.backend.repositories.db_row_repository import _ORG_COLUMN_CACHE
from src.backend.services import collection_clock_maintenance as maintenance
from test_perf_stage3a_postgres import TENANT, seed_baseline

DSN = os.getenv("PORTAL_PERF_STAGE3_DB_URL", "")
pytestmark = pytest.mark.skipif(not DSN, reason="dedicated stage-3 loopback PostgreSQL required")


@pytest.fixture
def database(monkeypatch, request):
    cfg = conninfo_to_dict(DSN)
    assert cfg.get("host") in {"127.0.0.1", "localhost", "::1"}
    assert cfg.get("dbname") == "portal_perf_stage3a"
    assert db_pool._pool is None
    with psycopg.connect(DSN, autocommit=True) as conn:
        assert conn.execute("SELECT current_database()").fetchone()[0] == "portal_perf_stage3a"
        conn.execute("DROP SCHEMA public CASCADE")
        conn.execute("CREATE SCHEMA public")
        seed_baseline(conn, getattr(request, "param", 1), with_children=True)
        conn.execute("ALTER TABLE performance_pieces ADD FOREIGN KEY(performance_id) "
                     "REFERENCES performances(id) ON DELETE CASCADE")
        conn.execute("ALTER TABLE payment_performance_fees ADD FOREIGN KEY(payment_id) "
                     "REFERENCES payments(id) ON DELETE CASCADE")
        conn.execute("ALTER TABLE payment_performance_fees ADD PRIMARY KEY(payment_id,performance_id)")
        for role in ("perf_clock_app", "perf_clock_sync", "portal_clock_maintainers"):
            if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,)).fetchone():
                conn.execute(f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION")
        conn.execute("GRANT portal_clock_maintainers TO perf_clock_sync")
        with conn.transaction():
            conn.execute(Path("db/migrations/023_portal_collection_versions.sql").read_text(encoding="utf-8"))
        conn.execute("GRANT USAGE ON SCHEMA public TO perf_clock_app,perf_clock_sync")
        conn.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO perf_clock_app,perf_clock_sync")
        conn.execute("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO perf_clock_app,perf_clock_sync")
        conn.execute("REVOKE INSERT,UPDATE,DELETE ON portal_data_generation,portal_collection_versions FROM perf_clock_app")
    monkeypatch.setenv("DATA_BACKEND", "db")
    monkeypatch.setenv("WEB_PUSH_ENABLED", "false")
    monkeypatch.setenv("PORTAL_READ_CONTEXT_PATHS", "")
    monkeypatch.setenv("PORTAL_VERSION_ETAG_PATHS", "")
    monkeypatch.delenv("LOCAL_JSON_FALLBACK_ENABLED", raising=False)
    _ORG_COLUMN_CACHE.clear()
    app_core._memory_cache.clear_all_tenants()
    try:
        yield cfg
    finally:
        db_pool.close_db_pool()
        _ORG_COLUMN_CACHE.clear()
        app_core._memory_cache.clear_all_tenants()


def role_dsn(cfg, role):
    return psycopg.conninfo.make_conninfo(**{**cfg, "user": role})


@contextmanager
def enabled(database, monkeypatch, paths, *, clocks=True, max_size=5):
    dsn = role_dsn(database, "perf_clock_app")
    monkeypatch.setenv("DB_URL", dsn)
    monkeypatch.setenv("PORTAL_READ_CONTEXT_PATHS", ",".join(paths))
    monkeypatch.setenv("PORTAL_VERSION_ETAG_PATHS", ",".join(set(paths) & CLOCK_PATHS) if clocks else "")
    monkeypatch.setattr(db_pool, "DB_POOL_MAX_SIZE", max_size)
    db_pool.open_db_pool()
    assert db_pool._pool_dsn == dsn
    client = TestClient(main.app)
    client.headers.update({"X-Tenant-Id": TENANT, "X-Device-Id": "perf-device", "Accept-Encoding": "identity"})
    try:
        yield client
    finally:
        client.close()
        db_pool.close_db_pool()


def version(conn, collection="schedules", org=TENANT):
    return conn.execute("SELECT version FROM portal_collection_versions WHERE organization_id=%s AND collection_name=%s",
                        (org, collection)).fetchone()[0]


def test_generated_migration_and_untrusted_sync_setting(database):
    from scripts.generate_collection_clock_migration import render
    assert len(table_dependencies()) == 12
    assert Path("db/migrations/023_portal_collection_versions.sql").read_text(encoding="utf-8") == render()
    with psycopg.connect(role_dsn(database, "perf_clock_app")) as conn:
        before = version(conn)
        conn.execute("SET LOCAL app.portal_sync_mode='on'")
        conn.execute("UPDATE schedules SET notes='untrusted' WHERE id=1")
        assert version(conn) == before+1
    with psycopg.connect(role_dsn(database, "perf_clock_app")) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("UPDATE portal_collection_versions SET version=1")


def test_real_triggers_zero_move_rollback_and_cascade(database):
    with psycopg.connect(DSN, autocommit=True) as conn:
        before = version(conn, "events")
        conn.execute("UPDATE events SET title='unused' WHERE id=9999")
        assert version(conn, "events") == before
        with pytest.raises(RuntimeError), conn.transaction():
            conn.execute("UPDATE events SET title='rolled back' WHERE id=1")
            raise RuntimeError("rollback")
        assert version(conn, "events") == before
        conn.execute("UPDATE events SET organization_id='other' WHERE id=1")
        assert version(conn, "events") == before+1
        assert version(conn, "events", "other") == 1
        before = version(conn, "performances")
        conn.execute("DELETE FROM performances WHERE id=1")
        assert version(conn, "performances") == before+2
        assert conn.execute("SELECT count(*) FROM performance_pieces WHERE performance_id=1").fetchone()[0] == 0


@pytest.mark.parametrize("path", ["/api/bootstrap-lite", "/api/bootstrap-core", "/api/performances",
                                 "/api/schedules", "/api/announcements", "/api/events", "/api/members",
                                 "/api/member-introductions"])
def test_target_response_and_304_use_one_checkout(database, monkeypatch, path):
    with enabled(database, monkeypatch, [path]) as client:
        calls = []
        getconn = db_pool._pool.getconn
        monkeypatch.setattr(db_pool._pool, "getconn", lambda *a, **k: (calls.append(True), getconn(*a, **k))[1])
        first = client.get(path)
        assert first.status_code == 200, first.text
        assert len(calls) == 1
        calls.clear()
        result = client.get(path, headers={"If-None-Match": first.headers["ETag"]})
        assert result.status_code == 304 and not result.content
        assert len(calls) == 1
        assert result.headers["Cache-Control"] == "private, no-cache"
        assert "X-Tenant-Id" in result.headers["Vary"]
        assert "Accept-Encoding" in result.headers["Vary"]


def test_external_write_and_stale_memory_no_longer_return_old_304(database, monkeypatch):
    with enabled(database, monkeypatch, ["/api/schedules"]) as client:
        first = client.get("/api/schedules")
        tag = first.headers["ETag"]
        with psycopg.connect(DSN, autocommit=True) as writer:
            writer.execute("UPDATE schedules SET notes='external update' WHERE id=1")
        result = client.get("/api/schedules", headers={"If-None-Match": tag})
        assert result.status_code == 200
        assert result.json()[0]["notes"] == "external update"
        assert result.headers["ETag"] != tag


def test_context_only_bypasses_old_collection_cache(database, monkeypatch):
    from src.backend.core.tenant_context import set_current_tenant_id, reset_current_tenant_id
    token = set_current_tenant_id(TENANT)
    app_core._memory_cache.set("schedules", [{"id": 999, "date": "2020-01-01", "venue": "stale"}])
    reset_current_tenant_id(token)
    with enabled(database, monkeypatch, ["/api/schedules"], clocks=False) as client:
        response = client.get("/api/schedules")
        assert response.status_code == 200
        assert response.json()[0]["id"] == 1


def test_snapshot_body_keeps_version_after_other_writer_commits(database, monkeypatch):
    from src.backend.services import bootstrap_service
    original = bootstrap_service.bootstrap_lite_payload
    once = []

    async def build(**kwargs):
        if not once:
            once.append(True)
            with psycopg.connect(DSN, autocommit=True) as writer:
                writer.execute("UPDATE schedules SET notes='after snapshot' WHERE id=1")
        return await original(**kwargs)

    monkeypatch.setattr(bootstrap_service, "bootstrap_lite_payload", build)
    with enabled(database, monkeypatch, ["/api/bootstrap-lite"]) as client:
        old = client.get("/api/bootstrap-lite")
        assert old.status_code == 200
        assert old.json()["schedules"][0]["notes"] != "after snapshot"
        fresh = client.get("/api/bootstrap-lite", headers={"If-None-Match": old.headers["ETag"]})
        assert fresh.status_code == 200
        assert fresh.json()["schedules"][0]["notes"] == "after snapshot"


def test_required_auth_precedes_intro_304_and_writeful_get_is_excluded(database, monkeypatch):
    with enabled(database, monkeypatch, ["/api/member-introductions"]) as client:
        first = client.get("/api/member-introductions")
        with psycopg.connect(DSN, autocommit=True) as writer:
            writer.execute("UPDATE members SET permission='エキストラ',system_access_until='2000-01-01' WHERE id=1")
        response = client.get("/api/member-introductions", headers={"If-None-Match": first.headers["ETag"]})
        assert response.status_code == 403
    from src.backend.core.collection_clock_schema import configured_paths
    monkeypatch.setenv("PORTAL_READ_CONTEXT_PATHS", "/api/auth/devices/perf-device")
    with pytest.raises(ValueError):
        configured_paths()


def test_revision_only_changes_bootstrap_etag(database, monkeypatch):
    from src.backend.services import meta_service
    rev = ["r1"]
    monkeypatch.setattr(meta_service, "cloud_run_revision", lambda: rev[0])
    with enabled(database, monkeypatch, ["/api/members", "/api/bootstrap-core"]) as client:
        members = client.get("/api/members")
        core = client.get("/api/bootstrap-core")
        rev[0] = "r2"
        assert client.get("/api/members", headers={"If-None-Match": members.headers["ETag"]}).status_code == 304
        assert client.get("/api/bootstrap-core", headers={"If-None-Match": core.headers["ETag"]}).status_code == 200


def test_read_anomaly_message_and_privileged_application_role_are_rejected(database, monkeypatch):
    with enabled(database, monkeypatch, ["/api/schedules"]) as client:
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("DELETE FROM portal_collection_versions WHERE organization_id=%s AND collection_name='schedules'", (TENANT,))
        response = client.get("/api/schedules")
        assert response.status_code == 503
        assert response.json()["detail"] == {"code": "version_clock_anomaly",
                                              "message": "データを確認できませんでした。管理者に連絡してください"}
    monkeypatch.setenv("DB_URL", DSN)
    with pytest.raises(RuntimeError, match="non-owner"):
        db_pool.open_db_pool()
    assert db_pool._pool is None


def test_version_regression_on_successive_snapshots_is_rejected(database, monkeypatch):
    with enabled(database, monkeypatch, ["/api/schedules"], max_size=1) as client:
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("UPDATE portal_collection_versions SET version=10 WHERE collection_name='schedules'")
        first = client.get("/api/schedules")
        assert first.status_code == 200
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("UPDATE portal_collection_versions SET version=9 WHERE collection_name='schedules'")
        result = client.get("/api/schedules", headers={"If-None-Match": first.headers["ETag"]})
        assert result.status_code == 503 and result.json()["detail"]["code"] == "version_clock_anomaly"


def test_nested_checkout_write_and_child_task_are_rejected(database, monkeypatch):
    with enabled(database, monkeypatch, ["/api/schedules"], clocks=False):
        async def run():
            async with read_scope() as frame:
                with pytest.raises(RuntimeError, match="Nested"):
                    with db_pool.db_connection(db_pool.db_connection_string()):
                        pass
                with frame.borrow() as conn:
                    with pytest.raises(RuntimeError, match="Only SELECT"):
                        conn.execute("DELETE FROM schedules")
                    with pytest.raises(RuntimeError, match="commit"):
                        conn.commit()
                    with pytest.raises(RuntimeError, match="transaction mode"):
                        conn.autocommit = True
                    cursor = conn.execute("SELECT 1")
                    fetch = cursor.fetchone
                for operation in (lambda: conn.execute("SELECT 1"), lambda: cursor.execute("SELECT 1"), fetch):
                    with pytest.raises(RuntimeError, match="lease"):
                        operation()
                async def child():
                    with frame.borrow():
                        pass
                with pytest.raises(RuntimeError, match="child tasks"):
                    await asyncio.create_task(child())
        asyncio.run(run())


def test_insert_upsert_and_truncate_guard(database):
    with psycopg.connect(DSN, autocommit=True) as owner:
        owner.execute("GRANT TRUNCATE ON schedules TO perf_clock_app,perf_clock_sync")
    with psycopg.connect(role_dsn(database, "perf_clock_app")) as conn:
        before = version(conn)
        conn.execute("INSERT INTO schedules(id,organization_id,date,venue) "
                     "VALUES(9998,%s,'2026-10-22','fixture'),(9999,%s,'2026-10-22','fixture')", (TENANT, TENANT))
        assert version(conn) == before+1
        conn.execute("INSERT INTO schedules(id,organization_id,date,venue) VALUES(9998,%s,'2026-10-22','upsert') "
                     "ON CONFLICT(id) DO UPDATE SET venue=excluded.venue", (TENANT,))
        assert version(conn) == before+2
    with psycopg.connect(role_dsn(database, "perf_clock_app")) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("TRUNCATE schedules")
    with psycopg.connect(role_dsn(database, "perf_clock_sync")) as conn:
        generation = conn.execute("SELECT generation FROM portal_data_generation").fetchone()[0]
        conn.execute("TRUNCATE schedules")
        assert conn.execute("SELECT generation FROM portal_data_generation").fetchone()[0] != generation


@pytest.mark.parametrize("rollback", [False, True])
def test_local_settings_do_not_leak_through_application_pool(database, monkeypatch, rollback):
    with enabled(database, monkeypatch, ["/api/schedules"], clocks=False, max_size=1):
        baseline = {}
        with db_pool.db_connection(db_pool.db_connection_string(), autocommit=True) as conn:
            pid = conn.info.backend_pid
            for name in ("statement_timeout", "lock_timeout", "app.portal_sync_mode"):
                baseline[name] = conn.execute("SELECT current_setting(%s,true)", (name,)).fetchone()[0] or ""
        try:
            with db_pool.db_connection(db_pool.db_connection_string()) as conn:
                conn.execute("SET LOCAL statement_timeout='3s'")
                conn.execute("SET LOCAL lock_timeout='1s'")
                conn.execute("SET LOCAL app.portal_sync_mode='on'")
                if rollback:
                    raise ValueError("rollback fixture")
        except ValueError:
            assert rollback
        with db_pool.db_connection(db_pool.db_connection_string(), autocommit=True) as conn:
            assert conn.info.backend_pid == pid
            for name, value in baseline.items():
                assert (conn.execute("SELECT current_setting(%s,true)", (name,)).fetchone()[0] or "") == value


def test_real_read_deadline_cancels_sql_and_returns_clean_connection(database, monkeypatch):
    from src.backend.core import read_context
    from time import monotonic
    with enabled(database, monkeypatch, ["/api/schedules"], clocks=False, max_size=1):
        async def run():
            with pytest.raises(psycopg.errors.QueryCanceled):
                async with read_scope() as frame:
                    with frame.borrow() as conn:
                        row = conn.execute("SELECT current_setting('statement_timeout'),current_setting('lock_timeout'),"
                                           "current_setting('transaction_isolation'),current_setting('transaction_read_only')").fetchone()
                        assert row == ('3s', '1s', 'repeatable read', 'on')
                        frame.deadline = monotonic()+0.1
                        conn.execute("SELECT pg_sleep(0.5)")
            assert read_context.current_read_context() is None
        asyncio.run(run())
        with db_pool.db_connection(db_pool.db_connection_string(), autocommit=True) as conn:
            assert conn.execute("SELECT current_setting('transaction_read_only')").fetchone()[0] == 'off'
            assert conn.execute("SELECT 1").fetchone()[0] == 1


@pytest.mark.parametrize("sql", ["ALTER TABLE payment_performance_fees DROP CONSTRAINT payment_performance_fees_pkey",
                                 "ALTER TABLE performance_pieces DROP CONSTRAINT performance_pieces_performance_id_fkey",
                                 "ALTER TABLE schedules DISABLE TRIGGER portal_clock_update"])
def test_preflight_rejects_missing_existing_schema_requirements(database, sql):
    with psycopg.connect(DSN) as conn:
        conn.execute(sql)
        with pytest.raises(RuntimeError):
            maintenance.verify_schema(conn)


@pytest.mark.parametrize("table,clocks", [("portal_collection_versions", True), ("menu_visibility_settings", False)])
def test_read_lock_timeout_is_capacity_not_clock_corruption(database, monkeypatch, table, clocks):
    from psycopg import sql
    with enabled(database, monkeypatch, ["/api/bootstrap-core"], clocks=clocks) as client:
        with psycopg.connect(DSN) as owner:
            owner.execute(sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(sql.Identifier(table)))
            response = client.get("/api/bootstrap-core")
            assert response.status_code == 503
            assert response.json()["detail"]["code"] == "read_capacity_exceeded"
            assert response.headers["Retry-After"] == "2"


def test_digest_detects_unversioned_content_and_generation_is_environment_local(database):
    with psycopg.connect(DSN) as conn:
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        previous = maintenance.canonical_digests(conn)
    with psycopg.connect(DSN) as writer:
        writer.execute("ALTER TABLE schedules DISABLE TRIGGER portal_clock_update")
        writer.execute("UPDATE schedules SET notes='missing clock bump' WHERE id=1")
        writer.execute("ALTER TABLE schedules ENABLE TRIGGER portal_clock_update")
    with psycopg.connect(DSN) as conn:
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        current = maintenance.canonical_digests(conn)
    with pytest.raises(RuntimeError, match="anomaly"):
        maintenance.compare_digests(previous, current)
    with psycopg.connect(role_dsn(database, "perf_clock_sync")) as conn:
        generation = maintenance.finalize_generation(conn)
    assert generation != previous["generation"]


def test_trusted_sync_skips_clock_but_finalizes_new_generation(database):
    with psycopg.connect(role_dsn(database, "perf_clock_sync")) as conn:
        before = version(conn)
        previous_generation = conn.execute("SELECT generation FROM portal_data_generation").fetchone()[0]
        conn.execute("SET LOCAL app.portal_sync_mode='on'")
        conn.execute("DELETE FROM schedules")  # source zero rows is also a normal sync operation
        assert version(conn) == before
    with psycopg.connect(role_dsn(database, "perf_clock_sync")) as conn:
        assert conn.execute("SELECT current_setting('app.portal_sync_mode',true)").fetchone()[0] != "on"
        generation = maintenance.finalize_generation(conn)
        assert version(conn) > before and generation != str(previous_generation)


def test_restricted_startup_checks_schema_without_ddl(database, monkeypatch):
    with enabled(database, monkeypatch, ["/api/schedules"]):
        app_core.run_db_startup_self_check()


def test_private_operations_cli_target_role_and_digest_state(database, monkeypatch, tmp_path):
    from scripts.portal_collection_clocks import main as cli
    dsn = role_dsn(database, "perf_clock_app")
    monkeypatch.setenv("PERF_CLOCK_OPERATIONS_DSN", dsn)
    state = tmp_path / "state.json"
    args = ["--dsn-env", "PERF_CLOCK_OPERATIONS_DSN", "--expected-database", "portal_perf_stage3a",
            "--environment", "local"]
    assert cli(["check", *args, "--state", str(state)]) == 0
    assert state.exists()
    old = state.read_bytes()
    assert cli(["check", *args, "--state", str(state)]) == 0
    assert state.read_bytes() == old
    assert cli(["finalize", *args, "--execute"]) == 1
    assert cli(["preflight", *["wrong" if a == "portal_perf_stage3a" else a for a in args]]) == 1
    monkeypatch.setenv("PERF_CLOCK_OPERATIONS_DSN", role_dsn(database, "perf_clock_sync"))
    assert cli(["finalize", *args, "--execute", "--state", str(state)]) == 0
    assert state.read_bytes() != old


def test_admission_rejects_repeated_attempts_before_any_checkout(database, monkeypatch):
    import httpx
    from threading import Event, Lock
    from src.backend.core import read_context
    from src.backend.services import member_introduction_service

    original = member_introduction_service.list_introductions
    entered, release, lock = [], Event(), Lock()
    def slow_list():
        with lock:
            entered.append(True)
        assert release.wait(4)
        return original()
    monkeypatch.setattr(member_introduction_service, "list_introductions", slow_list)
    monkeypatch.setattr(read_context, "ADMISSION_SECONDS", 0.1)
    with enabled(database, monkeypatch, ["/api/member-introductions"]) as client:
        getconn = db_pool._pool.getconn
        checkouts = []
        def count(*args, **kwargs):
            checkouts.append(True)
            return getconn(*args, **kwargs)
        monkeypatch.setattr(db_pool._pool, "getconn", count)
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                         base_url="http://testserver", headers=dict(client.headers)) as http:
                waiting = [asyncio.create_task(http.get("/api/member-introductions")) for _ in range(4)]
                try:
                    for _ in range(300):
                        if len(entered) == 4:
                            break
                        await asyncio.sleep(0.005)
                    assert len(entered) == len(checkouts) == 4
                    # Models an older client's three attempts, not real BFCache/device evidence.
                    for _ in range(3):
                        rejected = await http.get("/api/member-introductions")
                        assert rejected.status_code == 503
                        assert rejected.json()["detail"]["code"] == "read_capacity_exceeded"
                        assert rejected.headers["Retry-After"] == "2"
                        assert len(checkouts) == 4
                finally:
                    release.set()
                    results = await asyncio.gather(*waiting)
                assert all(r.status_code == 200 for r in results)
        asyncio.run(run())


def test_snapshot_reads_concurrent_with_saves_and_existing_audit(database, monkeypatch):
    import httpx
    from src.backend.services import audit_service
    from time import perf_counter
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(Path("db/migrations/002_operations_foundation.sql").read_text(encoding="utf-8-sig"))
        conn.execute("UPDATE members SET permission='管理者' WHERE id=1")
        conn.execute("GRANT SELECT,INSERT ON audit_logs TO perf_clock_app")
        conn.execute("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO perf_clock_app")
    monkeypatch.setenv("AUDIT_LOG_ENABLED", "true")
    audit = audit_service.write_audit_log
    audit_ms = []
    def measured(*args, **kwargs):
        start = perf_counter()
        try:
            return audit(*args, **kwargs)
        finally:
            audit_ms.append((perf_counter()-start)*1000)
    monkeypatch.setattr(audit_service, "write_audit_log", measured)
    paths = ["/api/bootstrap-lite", "/api/performances", "/api/members", "/api/member-introductions"]
    with enabled(database, monkeypatch, paths) as client:
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                         base_url="http://testserver", headers=dict(client.headers)) as http:
                for repeat in range(5):
                    body = {"id": 1, "date": "2026-12-01", "venue": "Synthetic hall",
                            "time": "18:00", "start_time": "18:00", "end_time": "20:00",
                            "available_start_time": "17:00", "available_end_time": "21:00",
                            "notes": f"Concurrent save {repeat}", "performance_id": 1}
                    responses = await asyncio.gather(*[http.get(path) for path in paths],
                                                     http.put("/api/schedules/1", json=body))
                    assert all(r.status_code == 200 for r in responses), [(r.status_code, r.text[:100]) for r in responses]
        asyncio.run(run())
        with psycopg.connect(DSN) as conn:
            assert conn.execute("SELECT count(*) FROM audit_logs WHERE actor_member_id=1 "
                                 "AND actor_permission='管理者' AND status_code=200").fetchone()[0] == 5
        assert len(audit_ms) == 5
        # Synchronous audit remains a separate pool checkout and a measured
        # event-loop-blocking phase, not part of the RR read connection.
        assert all(ms >= 0 for ms in audit_ms)
