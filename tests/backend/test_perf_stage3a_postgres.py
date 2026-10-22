"""Opt-in 3A baseline/probes, not production migrations or stage-3 implementation.

Only PORTAL_PERF_STAGE3_DB_URL pointing to the dedicated loopback database is
accepted. Never use application DB_URL implicitly. All data is synthetic.
"""
from __future__ import annotations

from contextlib import contextmanager
from functools import wraps
import inspect
import json
import os
from pathlib import Path
import platform
import subprocess
from time import perf_counter
from uuid import uuid4

import pytest

psycopg = pytest.importorskip("psycopg")
from psycopg import sql  # noqa: E402
from psycopg.conninfo import conninfo_to_dict  # noqa: E402
from psycopg_pool import ConnectionPool  # noqa: E402

DSN = os.getenv("PORTAL_PERF_STAGE3_DB_URL", "")
pytestmark = pytest.mark.skipif(not DSN, reason="isolated stage-3A PostgreSQL required")
TENANT = "perf-stage3a"
REPORT = {"phase": "before", "samples": [], "limitations": [
    "Synthetic local PostgreSQL, not production/TEST or real-device evidence",
    "Compatibility-created baseline schema, not a migration replay",
    "Prototype triggers test PostgreSQL semantics, not the future application",
    "No GCS, rollout, admission control, or read-context implementation tested",
]}


@pytest.fixture(scope="module")
def isolated_db():
    cfg = conninfo_to_dict(DSN)
    assert cfg.get("host") in {"127.0.0.1", "localhost", "::1"}
    assert cfg.get("dbname") == "portal_perf_stage3a"
    with psycopg.connect(DSN, connect_timeout=5) as conn:
        assert conn.execute("SELECT current_database()").fetchone()[0] == "portal_perf_stage3a"
        REPORT["postgres_version"] = conn.execute("SHOW server_version").fetchone()[0]
    REPORT["source_commit"] = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    REPORT["python_version"] = platform.python_version()
    yield DSN
    REPORT["baseline_complete"] = len(REPORT["samples"]) == 240
    destination = os.getenv("PORTAL_PERF_STAGE3_REPORT", "")
    if destination:
        target = Path(destination).resolve()
        assert target.is_relative_to(Path("docs/perf_stage3a").resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@pytest.fixture
def probe(isolated_db):
    """Test-owned schema with real FK cascades and transition tables."""
    schema = "probe_" + uuid4().hex
    with psycopg.connect(isolated_db, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        conn.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema)))
        conn.execute("CREATE TABLE clocks (organization_id text, collection text, version bigint, "
                     "PRIMARY KEY(organization_id,collection))")
        conn.execute("CREATE TABLE parents (id int PRIMARY KEY, organization_id text NOT NULL, value text)")
        conn.execute("CREATE TABLE children (id int PRIMARY KEY, organization_id text NOT NULL, "
                     "parent_id int REFERENCES parents(id) ON DELETE CASCADE, value text)")
        conn.execute("""CREATE FUNCTION bump() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            INSERT INTO clocks SELECT DISTINCT organization_id, 'parents', 1 FROM new_rows
            ORDER BY organization_id
            ON CONFLICT(organization_id,collection) DO UPDATE SET version=clocks.version+1;
          ELSIF TG_OP = 'DELETE' THEN
            INSERT INTO clocks SELECT DISTINCT organization_id, 'parents', 1 FROM old_rows
            ORDER BY organization_id
            ON CONFLICT(organization_id,collection) DO UPDATE SET version=clocks.version+1;
          ELSE
            INSERT INTO clocks SELECT organization_id, 'parents', 1 FROM
              (SELECT organization_id FROM old_rows UNION SELECT organization_id FROM new_rows) d
            ORDER BY organization_id
            ON CONFLICT(organization_id,collection) DO UPDATE SET version=clocks.version+1;
          END IF;
          RETURN NULL;
        END $$""")
        for table in ("parents", "children"):
            for event, relations in (("INSERT", "NEW TABLE AS new_rows"),
                                     ("DELETE", "OLD TABLE AS old_rows"),
                                     ("UPDATE", "OLD TABLE AS old_rows NEW TABLE AS new_rows")):
                conn.execute(sql.SQL("CREATE TRIGGER {} AFTER " + event + " ON {} REFERENCING "
                                     + relations + " FOR EACH STATEMENT EXECUTE FUNCTION bump()")
                             .format(sql.Identifier(table + event), sql.Identifier(table)))
    try:
        yield schema
    finally:
        with psycopg.connect(isolated_db, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def connect_probe(schema, **kwargs):
    conn = psycopg.connect(DSN, connect_timeout=5, **kwargs)
    conn.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema)))
    return conn


def clock(conn, organization="a"):
    row = conn.execute("SELECT version FROM clocks WHERE organization_id=%s", (organization,)).fetchone()
    return row[0] if row else 0


def test_statement_transition_tables_and_rollback(probe):
    with connect_probe(probe, autocommit=True) as conn:
        conn.execute("INSERT INTO parents VALUES (1,'a','x'),(2,'a','y')")
        assert clock(conn) == 1
        conn.execute("UPDATE parents SET value='z' WHERE id=999")
        assert clock(conn) == 1
        with pytest.raises(RuntimeError), conn.transaction():
            conn.execute("UPDATE parents SET value='rollback'")
            assert clock(conn) == 2
            raise RuntimeError("intentional rollback")
        assert clock(conn) == 1
        conn.execute("UPDATE parents SET organization_id='b' WHERE id=1")
        assert (clock(conn), clock(conn, "b")) == (2, 1)
        conn.execute("DELETE FROM parents WHERE id=1")
        assert clock(conn, "b") == 2


def test_child_cascade_does_not_need_deleted_parent(probe):
    with connect_probe(probe, autocommit=True) as conn:
        conn.execute("INSERT INTO parents VALUES (1,'a','x')")
        conn.execute("INSERT INTO children VALUES (1,'a',1,'child')")
        before = clock(conn)
        conn.execute("DELETE FROM parents WHERE id=1")
        assert conn.execute("SELECT count(*) FROM children").fetchone()[0] == 0
        assert clock(conn) == before + 2


def test_executemany_and_same_value_updates_invalidate(probe):
    with connect_probe(probe, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO parents VALUES (%s,'a','x')", [(i,) for i in range(10)])
        assert clock(conn) == 10
        conn.execute("UPDATE parents SET value=value")
        assert clock(conn) == 11
        REPORT["prototype_noop"] = {"same_value_update_statements": 1, "extra_version_updates": 1,
                                    "potential_extra_200": 1, "actual_http_transfers": None}


def test_upsert_and_multiple_organizations(probe):
    with connect_probe(probe, autocommit=True) as conn:
        conn.execute("INSERT INTO parents VALUES (1,'a','x'),(2,'b','y')")
        assert clock(conn) == clock(conn, "b") == 1
        conn.execute("INSERT INTO parents VALUES (1,'a','new') "
                     "ON CONFLICT(id) DO UPDATE SET value=excluded.value")
        assert clock(conn) == 2 and clock(conn, "b") == 1


def test_repeatable_read_keeps_body_and_clock_together(probe):
    with connect_probe(probe, autocommit=True) as writer:
        writer.execute("INSERT INTO parents VALUES (1,'a','old')")
        with connect_probe(probe, autocommit=True) as reader, reader.transaction():
            reader.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            before = (clock(reader), reader.execute("SELECT value FROM parents").fetchone()[0])
            writer.execute("UPDATE parents SET value='new'")
            assert before == (clock(reader), reader.execute("SELECT value FROM parents").fetchone()[0])
        assert (clock(writer), writer.execute("SELECT value FROM parents").fetchone()[0]) == (2, "new")


def test_set_local_and_read_only_do_not_leak(isolated_db):
    with ConnectionPool(isolated_db, min_size=1, max_size=1, open=True) as pool:
        with pool.connection() as conn:
            defaults = tuple(conn.execute("SHOW " + key).fetchone()[0] for key in
                             ("lock_timeout", "statement_timeout", "transaction_read_only"))
        with pool.connection() as conn:
            pid = conn.info.backend_pid
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            conn.execute("SET LOCAL lock_timeout='1s'")
            conn.execute("SET LOCAL statement_timeout='3s'")
            conn.execute("SET LOCAL app.portal_sync_mode='on'")
            assert conn.execute("SHOW transaction_read_only").fetchone()[0] == "on"
            with pytest.raises(psycopg.errors.ReadOnlySqlTransaction), conn.transaction():
                conn.execute("CREATE TABLE must_not_exist (id int)")
        with pool.connection() as conn:
            assert conn.info.backend_pid == pid
            assert tuple(conn.execute("SHOW " + key).fetchone()[0] for key in
                         ("lock_timeout", "statement_timeout", "transaction_read_only")) == defaults
            assert conn.execute("SELECT current_setting('app.portal_sync_mode',true)").fetchone()[0] != "on"


def test_version_row_lock_times_out_not_deadlocks(probe):
    with connect_probe(probe, autocommit=True) as setup:
        setup.execute("INSERT INTO parents VALUES (1,'a','x'),(2,'a','y')")
    with connect_probe(probe) as first:
        first.execute("UPDATE parents SET value='first' WHERE id=1")
        with connect_probe(probe, autocommit=True) as second:
            with pytest.raises(psycopg.errors.LockNotAvailable), second.transaction():
                second.execute("SET LOCAL lock_timeout='1s'")
                second.execute("UPDATE parents SET value='second' WHERE id=2")
    with connect_probe(probe, autocommit=True) as conn:
        assert conn.execute("SELECT value FROM parents WHERE id=2").fetchone()[0] == "y"


class CountCursor:
    def __init__(self, inner, meter):
        self.inner, self.meter = inner, meter

    def __enter__(self):
        self.inner.__enter__()
        return self

    def __exit__(self, *args):
        return self.inner.__exit__(*args)

    def __getattr__(self, key):
        return getattr(self.inner, key)

    def execute(self, query, *args, **kwargs):
        text = query.as_string(self.inner.connection) if hasattr(query, "as_string") else str(query)
        start = perf_counter()
        try:
            self.inner.execute(query, *args, **kwargs)
        finally:
            self.meter["sql"] += 1
            self.meter["xmin_sql"] += int("xmin::text" in text)
            self.meter["sql_roundtrip_ms"] += (perf_counter() - start) * 1000
        return self


class CountConnection:
    def __init__(self, inner, meter):
        self.inner, self.meter = inner, meter

    def __getattr__(self, key):
        return getattr(self.inner, key)

    def cursor(self, *args, **kwargs):
        return CountCursor(self.inner.cursor(*args, **kwargs), self.meter)


def seed_baseline(conn, scale):
    from src.backend.core import db_runtime
    from src.backend.core.db_schema import PORTAL_DB_TABLES

    db_runtime.ensure_db_schema_compatibility(conn)
    conn.execute(Path("db/migrations/016_menu_visibility_settings.sql").read_text(encoding="utf-8-sig"))
    for table in PORTAL_DB_TABLES - {"portal_json_collections"}:
        conn.execute(sql.SQL("TRUNCATE {}").format(sql.Identifier(table)))
    counts = {"members": 100, "performances": 10, "schedules": 200, "absences": 5000,
              "events": 20, "event_responses": 1000, "albums": 20, "album_photos": 500,
              "payments": 30, "part_settings": 30, "org_settings": 30, "sns_settings": 30}
    defaults = {"date": "2026-12-01", "title": "Synthetic", "content": "Synthetic notice",
                "venue": "Synthetic hall", "part": "Violin", "permission": "一般"}
    for table, count in counts.items():
        types = dict(conn.execute("SELECT column_name,data_type FROM information_schema.columns "
                                  "WHERE table_schema='public' AND table_name=%s", (table,)).fetchall())
        columns = set(types)
        rows = []
        for i in range(count * scale):
            row = {"id": i + 1, "organization_id": TENANT}
            row.update({k: "" for k, kind in types.items() if kind == "text" and k != "organization_id"})
            row.update({k: "18:00" for k, kind in types.items() if kind == "time without time zone"})
            row.update({k: False for k, kind in types.items() if kind == "boolean"})
            row.update({k: v for k, v in defaults.items() if k in columns})
            if "name" in columns:
                row["name"] = f"Synthetic {i % (100 * scale) + 1}"
            for key, modulus in (("member_id", 100), ("schedule_id", 200), ("event_id", 20),
                                 ("performance_id", 10), ("album_id", 20)):
                if key in columns:
                    row[key] = i % (modulus * scale) + 1
            rows.append(row)
        keys = tuple(rows[0])
        with conn.cursor() as cur:
            cur.executemany(sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
                sql.Identifier(table), sql.SQL(',').join(map(sql.Identifier, keys)),
                sql.SQL(',').join(sql.Placeholder() for _ in keys)), [tuple(row[k] for k in keys) for row in rows])
    conn.execute("INSERT INTO auth_devices (id,organization_id,device_id,member_id,member_name,permission) "
                 "VALUES (1,%s,'perf-device',1,'Synthetic 1','一般')", (TENANT,))
    return {table: count * scale for table, count in counts.items()}


@pytest.mark.parametrize("scale", [1, 2])
def test_current_http_baseline(isolated_db, monkeypatch, scale):
    from fastapi.testclient import TestClient
    from src.backend import app_core, main
    from src.backend.core import db_pool
    from src.backend.repositories.db_row_repository import _ORG_COLUMN_CACHE

    monkeypatch.setenv("DB_URL", isolated_db)
    monkeypatch.setenv("DATA_BACKEND", "db")
    monkeypatch.delenv("LOCAL_JSON_FALLBACK_ENABLED", raising=False)
    with psycopg.connect(isolated_db, autocommit=True) as conn:
        counts = seed_baseline(conn, scale)
    REPORT.setdefault("fixture_counts", {})[str(scale)] = counts
    assert db_pool._pool is None, "do not replace another application's pool"
    db_pool.open_db_pool()
    meter = {}
    original = db_pool.pooled_psycopg.connect

    @contextmanager
    def measured(*args, **kwargs):
        started = perf_counter()
        with original(*args, **kwargs) as conn:
            meter["checkouts"] += 1
            meter["connection_acquire_ms"] += (perf_counter() - started) * 1000
            held = perf_counter()
            try:
                yield CountConnection(conn, meter)
            finally:
                meter["connection_body_hold_ms"] += (perf_counter() - held) * 1000

    monkeypatch.setattr(db_pool.pooled_psycopg, "connect", measured)
    from src.backend.services import (
        announcement_service, bootstrap_service, event_service, member_introduction_service,
        member_service, performance_service, schedule_service,
    )

    def count_builder(fn):
        if inspect.iscoroutinefunction(fn):
            @wraps(fn)
            async def async_call(*args, **kwargs):
                meter["payload_builds"] += 1
                return await fn(*args, **kwargs)
            return async_call

        @wraps(fn)
        def call(*args, **kwargs):
            meter["payload_builds"] += 1
            return fn(*args, **kwargs)
        return call

    for module, name in (
        (performance_service, "list_performances"), (schedule_service, "list_schedules"),
        (announcement_service, "list_announcements"), (event_service, "list_events"),
        (member_service, "list_members"), (member_introduction_service, "response"),
        (bootstrap_service, "bootstrap_lite_payload"), (bootstrap_service, "bootstrap_core_payload"),
    ):
        monkeypatch.setattr(module, name, count_builder(getattr(module, name)))
    client = TestClient(main.app)  # no lifespan: no startup seeding/external services
    headers = {"X-Tenant-Id": TENANT, "X-Device-Id": "perf-device", "Accept-Encoding": "identity"}
    try:
        for path in ("bootstrap-lite", "bootstrap-core", "performances", "schedules",
                     "announcements", "events", "members", "member-introductions"):
            for repeat in range(5):
                app_core._memory_cache.clear_all_tenants()
                _ORG_COLUMN_CACHE.clear()
                etag = None
                for phase in ("cold200", "warm304", "cleared_memory304"):
                    if phase == "cleared_memory304":
                        app_core._memory_cache.clear_all_tenants()
                    meter.clear()
                    meter.update(sql=0, xmin_sql=0, checkouts=0, connection_acquire_ms=0.0,
                                 connection_body_hold_ms=0.0, sql_roundtrip_ms=0.0, payload_builds=0)
                    pool_before = db_pool._pool.get_stats()
                    started = perf_counter()
                    response = client.get("/api/" + path, headers={**headers, **(
                        {"If-None-Match": etag} if etag else {})})
                    elapsed = (perf_counter() - started) * 1000
                    queue_ms = (db_pool._pool.get_stats().get("requests_wait_ms", 0)
                                - pool_before.get("requests_wait_ms", 0))
                    assert response.status_code == (200 if phase == "cold200" else 304), response.text
                    if phase == "cold200":
                        etag = response.headers["etag"]
                    REPORT["samples"].append({"scale": scale, "path": path, "repeat": repeat,
                                              "cache_state": phase, "status": response.status_code,
                                              "application_body_bytes": len(response.content),
                                              "request_ms": elapsed, "pool_queue_wait_ms": queue_ms, **meter})
    finally:
        client.close()
        db_pool.close_db_pool()
        app_core._memory_cache.clear_all_tenants()
        _ORG_COLUMN_CACHE.clear()
