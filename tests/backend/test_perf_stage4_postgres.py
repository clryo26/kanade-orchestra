"""Opt-in stage 4A target-photo comparison on the owned stage-4 loopback DB.

No live DB credentials, actual GCS, or stage-4 migration. Saved BEFORE reports stay immutable.
The seed uses the existing stage-3 synthetic standard/2x data definition.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from functools import wraps
import io
import json
import os
from pathlib import Path
import platform
import re
import subprocess
from threading import Lock
from time import monotonic, perf_counter, sleep

from fastapi.testclient import TestClient
import httpx
from PIL import Image
import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo
import pytest

from src.backend import app_core, main
from src.backend.core import db_pool
from src.backend.core.tenant_context import reset_current_tenant_id, set_current_tenant_id
from src.backend.repositories.db_item_repository import PostgresRowStore
from src.backend.repositories.db_row_repository import _ORG_COLUMN_CACHE
from src.backend.services import album_service, audit_service
from test_perf_stage3a_postgres import seed_baseline, TENANT
from test_perf_stage4_baseline import SyntheticBucket, SOURCE_PATHS, digest


ROOT = Path(__file__).resolve().parents[2]
DSN = os.getenv("PORTAL_PERF_STAGE4_DB_URL", "").strip()
CURRENT = ContextVar("stage4_meter", default=None)
PHASE = ContextVar("stage4_phase", default="body")
REPORT = {"photo_batches": [], "writes": [], "contention": [], "same_loop_waves": [], "omitted_photos": [], "photo_contract": []}


def validate_dsn(dsn):
    cfg = conninfo_to_dict(dsn)
    if cfg.get("host") not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Stage 4 requires an explicit loopback host")
    if cfg.get("dbname") != "portal_perf_stage4":
        raise ValueError("Stage 4 requires its dedicated portal_perf_stage4 database")
    if any(key in cfg for key in ("service", "servicefile", "hostaddr")):
        raise ValueError("DSN indirection is not accepted")
    return cfg


@pytest.mark.parametrize("dsn", [
    "postgresql://x@remote.invalid/portal_perf_stage4",
    "postgresql://x@127.0.0.1/kanade_portal",
    "dbname=portal_perf_stage4",
    "host=localhost dbname=portal_perf_stage4 hostaddr=192.0.2.1",
])
def test_reject_unsafe_dsn_before_connect(dsn):
    with pytest.raises(ValueError):
        validate_dsn(dsn)


def sql_tag(text):
    query = text.upper().replace('"', "")
    if query.startswith(("SET ", "BEGIN", "COMMIT", "ROLLBACK")):
        return "control"
    if "LEFT JOIN ALBUM_PHOTOS AS PHOTO" in query:
        return "select_album_photo_target"
    for table in ("album_photos", "albums", "auth_devices", "members", "audit_logs"):
        if re.search(r"\b(FROM|INTO|UPDATE)\s+" + table.upper() + r"\b", query):
            return query.split()[0].lower() + "_" + table
    return "schema_or_other"


class Meter:
    def __init__(self):
        self.lock = Lock()
        self.events = []
        self.loans = []
        self.audit_calls = []
        self.audit_callback_delay_ms = []

    def summary(self):
        return {
            "sql_statements": sum(event["statements"] for event in self.events),
            "execute_calls": sum(event["api"] == "execute" for event in self.events),
            "executemany_calls": sum(event["api"] == "executemany" for event in self.events),
            "checkouts": len(self.loans),
            "connection_acquire_ms": sum(row["acquire_ms"] for row in self.loans),
            "connection_held_until_putconn_ms": sum(row["held_ms"] for row in self.loans),
            "audit_elapsed_ms": sum(self.audit_calls),
            "audit_callback_delay_ms": self.audit_callback_delay_ms,
            "sql_by_tag": dict(Counter({tag: sum(e["statements"] for e in self.events if e["tag"] == tag)
                                        for tag in {e["tag"] for e in self.events}})),
            "fetched_rows_by_tag": {tag: sum(e["fetched_rows"] for e in self.events if e["tag"] == tag)
                                    for tag in {e["tag"] for e in self.events}},
            "sql_by_phase": {phase: sum(e["statements"] for e in self.events if e["phase"] == phase)
                             for phase in {e["phase"] for e in self.events}},
            "checkouts_by_phase": dict(Counter(row["phase"] for row in self.loans)),
            "events": self.events,
        }


class MeasuredCursor(psycopg.Cursor):
    def _execute(self, api, query, params, kwargs):
        meter = CURRENT.get()
        text = query.as_string(self.connection) if hasattr(query, "as_string") else str(query)
        event = None
        if meter is not None and text.strip():
            event = {"api": api, "tag": sql_tag(text), "phase": PHASE.get(),
                     "statements": len(params) if api == "executemany" else 1,
                     "fetched_rows": 0, "sql_ms": 0.0, "affected_rows": None}
            with meter.lock:
                meter.events.append(event)
        self._stage4_event = event
        started = perf_counter()
        try:
            if api == "executemany":
                return super().executemany(query, params, **kwargs)
            return super().execute(query, params, **kwargs)
        finally:
            if event is not None:
                event["sql_ms"] = (perf_counter() - started) * 1000
                event["affected_rows"] = self.rowcount

    def execute(self, query, params=None, **kwargs):
        return self._execute("execute", query, params, kwargs)

    def executemany(self, query, params_seq, **kwargs):
        return self._execute("executemany", query, list(params_seq), kwargs)

    def fetchone(self):
        row = super().fetchone()
        if row is not None and getattr(self, "_stage4_event", None) is not None:
            self._stage4_event["fetched_rows"] += 1
        return row

    def fetchall(self):
        rows = super().fetchall()
        if getattr(self, "_stage4_event", None) is not None:
            self._stage4_event["fetched_rows"] += len(rows)
        return rows


@pytest.fixture(scope="module")
def isolated_db():
    if not DSN:
        pytest.skip("PORTAL_PERF_STAGE4_DB_URL is required; never infer it from DB_URL")
    validate_dsn(DSN)
    assert db_pool._pool is None, "Do not replace another application's pool"
    with psycopg.connect(DSN, connect_timeout=5, autocommit=True) as conn:
        assert conn.execute("SELECT current_database()").fetchone()[0] == "portal_perf_stage4"
        tables = conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'").fetchall()
        if tables:
            assert ("stage4_fixture_owner",) in tables, "Refuse to destroy an unowned database"
            assert conn.execute("SELECT owner FROM stage4_fixture_owner").fetchall() == [("perf-stage4-0",)]
        REPORT["postgres_version"] = conn.execute("SHOW server_version").fetchone()[0]
        REPORT["fsync"] = conn.execute("SHOW fsync").fetchone()[0]
    yield DSN
    destination = os.getenv("PORTAL_PERF_STAGE4_PG_REPORT", "").strip()
    if destination:
        path = (ROOT / destination).resolve()
        assert path.parent == (ROOT / "docs/perf_stage4").resolve() and path.name.endswith("_AFTER.json")
        assert len(REPORT["photo_batches"]) == 60
        assert len(REPORT["writes"]) == 10 and len(REPORT["contention"]) == 4
        assert len(REPORT["same_loop_waves"]) == 2 and len(REPORT["omitted_photos"]) == 1
        assert len(REPORT["photo_contract"]) == 1
        REPORT.update({
            "phase": "4A target-photo AFTER with actual PostgreSQL and synthetic GCS; conditional GET held",
            "head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
            "python": platform.python_version(), "system": platform.system(),
            "measurement_sha256": digest(Path(__file__).read_bytes()),
            "source_sha256": {name: digest((ROOT / name).read_bytes()) for name in (*SOURCE_PATHS, "src/backend/repositories/album_repository.py")},
            "unmeasured": {"real_gcs_http": None, "wire_bytes": None, "real_device": None,
                           "actual_cloud_run_workers": None, "production_latency": None},
        })
        path.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@pytest.fixture
def environment(isolated_db, monkeypatch, request):
    import google.cloud.storage

    scale = request.param
    assert db_pool._pool is None
    with psycopg.connect(isolated_db, autocommit=True) as conn:
        # Only the validated, test-owned DB can reach this schema reset.
        conn.execute("DROP SCHEMA public CASCADE")
        conn.execute("CREATE SCHEMA public")
        counts = seed_baseline(conn, scale, with_children=True)
        conn.execute((ROOT / "db/migrations/002_operations_foundation.sql").read_text(encoding="utf-8-sig"))
        REPORT.setdefault("fixture_counts", {})[str(scale)] = counts
        conn.execute("CREATE TABLE stage4_fixture_owner (owner text PRIMARY KEY)")
        conn.execute("INSERT INTO stage4_fixture_owner VALUES ('perf-stage4-0')")
        conn.execute("UPDATE members SET permission='管理者' WHERE id=1")
        conn.execute("UPDATE auth_devices SET permission='管理者' WHERE id=1")
        conn.execute("UPDATE albums SET event_name='Synthetic album ' || id, created_by_member_id=1, "
                     "created_by_member_name='Synthetic 1'")
        conn.execute("UPDATE album_photos SET album_id=((id-1)/25)+1")
        conn.execute("UPDATE album_photos SET object_name='albums/' || album_id || '/synthetic/' || id || '.jpg', "
                     "filename='fixture-' || id || '.jpg', "
                     "url='/api/albums/' || album_id || '/photos/' || id, uploaded_by_member_id=1")
    dsn = make_conninfo(isolated_db, application_name="portal_perf_stage4_baseline")
    for key, value in {"DB_URL": dsn, "DATA_BACKEND": "db", "WEB_PUSH_ENABLED": "false", "AUDIT_LOG_ENABLED": "true",
                       "PORTAL_READ_CONTEXT_PATHS": "", "PORTAL_VERSION_ETAG_PATHS": ""}.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("LOCAL_JSON_FALLBACK_ENABLED", raising=False)
    _ORG_COLUMN_CACHE.clear()
    app_core._memory_cache.clear_all_tenants()
    assert isinstance(app_core.row_store(), PostgresRowStore)
    bucket = SyntheticBucket({}, Counter())
    monkeypatch.setattr(album_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(album_service, "get_storage_bucket", lambda: bucket)

    def no_live_gcs(*args, **kwargs):
        raise AssertionError("Stage 4 PostgreSQL tests must never construct a live GCS client")

    monkeypatch.setattr(google.cloud.storage, "Client", no_live_gcs)
    db_pool.open_db_pool()
    assert db_pool._pool_dsn == dsn
    pool = db_pool._pool
    acquire, release = pool.getconn, pool.putconn
    loans, guard = {}, Lock()
    peak = [0]

    def getconn(*args, **kwargs):
        meter = CURRENT.get()
        started = perf_counter()
        conn = acquire(*args, **kwargs)
        conn.cursor_factory = MeasuredCursor
        if meter is not None:
            row = {"phase": PHASE.get(), "acquire_ms": (perf_counter() - started) * 1000, "held_ms": 0.0}
            with meter.lock:
                meter.loans.append(row)
            with guard:
                loans[id(conn)] = (row, perf_counter())
                peak[0] = max(peak[0], len(loans))
        return conn

    def putconn(conn):
        with guard:
            value = loans.pop(id(conn), None)
        if value:
            value[0]["held_ms"] = (perf_counter() - value[1]) * 1000
        return release(conn)

    monkeypatch.setattr(pool, "getconn", getconn)
    monkeypatch.setattr(pool, "putconn", putconn)
    original_audit, original_actor = audit_service.write_audit_log, audit_service.device_auth_record

    @wraps(original_actor)
    def actor(*args, **kwargs):
        token = PHASE.set("audit_actor")
        try:
            return original_actor(*args, **kwargs)
        finally:
            PHASE.reset(token)

    @wraps(original_audit)
    def audit(*args, **kwargs):
        meter = CURRENT.get()
        token = PHASE.set("audit_write")
        started = perf_counter()
        if meter is not None:
            asyncio.get_running_loop().call_soon(
                lambda: meter.audit_callback_delay_ms.append((perf_counter() - started) * 1000))
        try:
            return original_audit(*args, **kwargs)
        finally:
            if meter is not None:
                meter.audit_calls.append((perf_counter() - started) * 1000)
            PHASE.reset(token)

    monkeypatch.setattr(audit_service, "write_audit_log", audit)
    monkeypatch.setattr(audit_service, "device_auth_record", actor)
    client = TestClient(main.app)  # No lifespan, no startup seeding/cloud access.
    client.headers.update({"X-Tenant-Id": TENANT, "X-Device-Id": "perf-device", "Accept-Encoding": "identity"})
    token = set_current_tenant_id(TENANT)
    try:
        albums = app_core.row_store().list("albums")
        manifest_dir = ROOT / "tests/fixtures/perf_stage4_photos"
        manifest = json.loads((manifest_dir / "manifest.json").read_text(encoding="utf-8"))
        originals = [(manifest_dir / row["file"]).read_bytes() for row in manifest["images"]]
        thumbnails = [album_service._make_thumbnail(content) for content in originals]
        for album in albums:
            for photo in album["photos"]:
                index = (photo["id"] - 1) % 4
                bucket.objects[photo["object_name"]] = originals[index]
                bucket.objects[album_service._thumbnail_key(photo)] = thumbnails[index]
        with db_pool.web_database_runtime():
            yield {"client": client, "pool": pool, "albums": albums, "scale": scale,
                   "fixture_counts": counts, "bucket": bucket, "dsn": isolated_db, "peak_loans": peak}
        assert not loans, "Every measured loan must have been returned"
    finally:
        reset_current_tenant_id(token)
        client.close()
        db_pool.close_db_pool()
        _ORG_COLUMN_CACHE.clear()
        app_core._memory_cache.clear_all_tenants()


def call(env, method, path, **kwargs):
    meter = Meter()
    token = CURRENT.set(meter)
    started = perf_counter()
    try:
        response = env["client"].request(method, path, **kwargs)
    finally:
        CURRENT.reset(token)
    return response, {"request_ms": (perf_counter() - started) * 1000, **meter.summary()}


@pytest.mark.parametrize("environment", [1, 2], indirect=True)
def test_real_photo_read_sql_and_connections(environment):
    env = environment
    visible = [(album["id"], photo["id"]) for album in env["albums"] for photo in album["photos"]]
    for count in (1, 25, 50):
        for repeat in range(5):
            for state in ("cold_columns_warm_thumbnail", "warm_columns_conditional_probe"):
                if state.startswith("cold"):
                    _ORG_COLUMN_CACHE.clear()
                before = env["pool"].get_stats().get("requests_wait_ms", 0)
                records, body_bytes = [], 0
                for album_id, photo_id in visible[:count]:
                    response, result = call(env, "GET", f"/api/albums/{album_id}/photos/{photo_id}/thumbnail",
                                            headers={"If-None-Match": "*"} if state.startswith("warm") else {})
                    assert response.status_code == 200
                    assert result["checkouts"] == 1
                    assert result["fetched_rows_by_tag"]["select_album_photo_target"] == 1
                    assert result["sql_by_tag"]["select_album_photo_target"] == 1
                    assert "select_album_photos" not in result["sql_by_tag"]
                    assert not any(event["tag"].startswith(("insert_", "update_", "delete_")) for event in result["events"])
                    with Image.open(io.BytesIO(response.content)) as image:
                        assert max(image.size) == 384
                    body_bytes += len(response.content)
                    records.append(result)
                REPORT["photo_batches"].append({"scale": env["scale"], "count": count, "repeat": repeat,
                                               "state": state, "body_bytes": body_bytes,
                                               "pool_queue_wait_ms": env["pool"].get_stats().get("requests_wait_ms", 0) - before,
                                               "first_request_events": records[0]["events"],
                                               "requests": [{key: value for key, value in row.items() if key != "events"}
                                                            for row in records]})


@pytest.mark.parametrize("environment", [1, 2], indirect=True)
def test_title_update_rewrites_children_and_keeps_real_audit(environment):
    env = environment
    for repeat in range(5):
        payload = {**env["albums"][0], "event_name": f"Synthetic title {repeat}"}
        response, result = call(env, "PUT", "/api/extra/albums/1", json=payload)
        assert response.status_code == 200, response.text
        assert len(response.json()["photos"]) == 25
        deletes = [e for e in result["events"] if e["tag"] == "delete_album_photos"]
        inserts = [e for e in result["events"] if e["tag"] == "insert_album_photos"]
        assert sum(e["affected_rows"] for e in deletes) == 25
        assert sum(e["statements"] for e in inserts) == 25
        assert result["sql_by_tag"]["insert_audit_logs"] == 1
        assert result["checkouts_by_phase"]["audit_actor"] >= 1
        assert result["checkouts_by_phase"]["audit_write"] == 1
        with psycopg.connect(env["dsn"], autocommit=True) as observer:
            assert observer.execute("SELECT count(*) FROM audit_logs").fetchone()[0] == repeat + 1
        REPORT["writes"].append({"scale": env["scale"], "repeat": repeat, **result})


def wait_for_album_lock(dsn):
    deadline = monotonic() + 3
    with psycopg.connect(dsn, autocommit=True, connect_timeout=5) as observer:
        while monotonic() < deadline:
            rows = observer.execute("SELECT pid FROM pg_stat_activity WHERE datname=current_database() "
                                    "AND application_name='portal_perf_stage4_baseline' AND wait_event_type='Lock'").fetchall()
            if rows:
                return
            sleep(0.01)
    raise AssertionError("Expected the real update to block on the held album row")


@pytest.mark.parametrize("environment", [1, 2], indirect=True)
@pytest.mark.parametrize("outcome", ["release", "timeout"])
def test_album_row_lock_read_and_write_contention(environment, outcome):
    env = environment
    with psycopg.connect(env["dsn"], connect_timeout=5) as holder:
        holder.execute("SELECT id FROM albums WHERE organization_id=%s AND id=1 FOR UPDATE", (TENANT,))
        before = env["pool"].get_stats().get("requests_wait_ms", 0)
        with ThreadPoolExecutor(max_workers=1) as workers:
            pending = workers.submit(call, env, "PUT", "/api/extra/albums/1",
                                     json={**env["albums"][0], "event_name": "After lock"})
            try:
                wait_for_album_lock(env["dsn"])
                # The committed old photo remains readable while the writer waits.
                read, read_result = call(env, "GET", "/api/albums/1/photos/1/thumbnail")
                assert read.status_code == 200 and not pending.done()
                if outcome == "release":
                    holder.commit()
                response, result = pending.result(timeout=12)
            finally:
                holder.rollback()
    if outcome == "release":
        assert response.status_code == 200
    else:
        assert response.status_code == 503, response.text
        assert response.json()["detail"]["code"] == "save_busy"
        assert not any(e["tag"] == "delete_album_photos" for e in result["events"])
    REPORT["contention"].append({"scale": env["scale"], "outcome": outcome,
                                  "write_status": response.status_code, "write": result, "read": read_result,
                                  "pool_queue_wait_ms": env["pool"].get_stats().get("requests_wait_ms", 0) - before})


@pytest.mark.parametrize("environment", [1, 2], indirect=True)
def test_real_reads_writes_audit_on_one_event_loop(environment):
    env = environment

    async def wave():
        gaps, results = [], []
        finished = asyncio.Event()

        async def heartbeat():
            last = perf_counter()
            while not finished.is_set():
                await asyncio.sleep(0.01)
                now = perf_counter()
                gaps.append((now - last) * 1000)
                last = now

        async def one(client, index):
            meter = Meter()
            token = CURRENT.set(meter)
            start = perf_counter()
            method = "PUT" if index % 3 == 0 else "GET"
            try:
                if method == "PUT":
                    album = env["albums"][(index // 3) % 2]
                    response = await client.put(f"/api/extra/albums/{album['id']}",
                                                json={**album, "event_name": f"Wave title {index}"})
                else:
                    response = await client.get(f"/api/albums/1/photos/{index + 1}/thumbnail")
                assert response.status_code == 200, response.text
                results.append({"method": method, "status": response.status_code,
                                "request_ms": (perf_counter() - start) * 1000, **meter.summary()})
            finally:
                CURRENT.reset(token)

        pulse = asyncio.create_task(heartbeat())
        try:
            async with httpx.AsyncClient(app=main.app, base_url="http://synthetic", headers=dict(env["client"].headers)) as client:
                await asyncio.gather(*(one(client, index) for index in range(12)))
            await asyncio.sleep(0.02)
        finally:
            finished.set()
            await pulse
        return results, gaps

    before = env["pool"].get_stats().get("requests_wait_ms", 0)
    results, gaps = asyncio.run(wave())
    assert len(results) == 12 and gaps and env["peak_loans"][0] <= 5
    assert sum(row["sql_by_tag"].get("insert_audit_logs", 0) for row in results) == 4
    with psycopg.connect(env["dsn"], autocommit=True) as observer:
        assert observer.execute("SELECT count(*) FROM audit_logs").fetchone()[0] == 4
        assert observer.execute("SELECT count(*) FROM album_photos").fetchone()[0] == 500 * env["scale"]
    REPORT["same_loop_waves"].append({
        "scale": env["scale"], "model": "one ASGI event loop, 8 photo GET and 4 actual PUT with audit",
        "request_results": results, "heartbeat_interval_ms": 10, "observed_heartbeat_gaps_ms": gaps,
        "peak_measured_pool_loans": env["peak_loans"][0],
        "pool_queue_wait_ms": env["pool"].get_stats().get("requests_wait_ms", 0) - before,
    })


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_capture_generic_put_omitted_photo_collection(environment):
    env = environment
    response, result = call(env, "PUT", "/api/extra/albums/1", json={"event_name": "Title-only API probe"})
    assert response.status_code == 200 and response.json()["photos"] == []
    with psycopg.connect(env["dsn"], autocommit=True) as observer:
        assert observer.execute("SELECT count(*) FROM album_photos WHERE album_id=1").fetchone()[0] == 0
        assert observer.execute("SELECT count(*) FROM audit_logs").fetchone()[0] == 1
    REPORT["omitted_photos"].append({
        "status": 200, "remaining_album_photos": 0,
        "scope": "Synthetic API probe, not a reproduced UI data-loss incident; no behaviour fix here",
        **result,
    })


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_target_photo_parent_tenant_and_reuse_contract(environment):
    env = environment
    base = "/api/albums"
    records = []
    # Public access remains public: no device header required.
    response, meter = call(env, "GET", f"{base}/1/photos/1", headers={"X-Device-Id": ""})
    assert response.status_code == 200
    assert response.content == env["bucket"].objects[env["albums"][0]["photos"][0]["object_name"]]
    assert meter["checkouts"] == 1
    for album_id, photo_id, headers, detail in [
        (999999, 1, {}, "Data not found"),
        (1, 999999, {}, "Photo not found"),
        (2, 1, {}, "Photo not found"),
        (1, 1, {"X-Tenant-Id": "other-synthetic-tenant"}, "Data not found"),
    ]:
        before = dict(env["bucket"].counts)
        for suffix in ("", "/thumbnail"):
            result, meter = call(env, "GET", f"{base}/{album_id}/photos/{photo_id}{suffix}", headers=headers)
            assert result.status_code == 404 and result.json()["detail"] == detail
            assert meter["checkouts"] == 1
        assert dict(env["bucket"].counts) == before, "Do not access storage before parent/child checks"
        records.append({"album_id": album_id, "photo_id": photo_id, "detail": detail})
    # No FK in the compatibility schema: deliberately inconsistent tenant
    # rows must still never cross the parent+child join's organization scope.
    with psycopg.connect(env["dsn"], autocommit=True) as writer:
        writer.execute("INSERT INTO album_photos(id,album_id,organization_id,filename,object_name) "
                       "VALUES(50001,1,'other-synthetic-tenant','wrong.jpg','forbidden')")
    wrong, _ = call(env, "GET", f"{base}/1/photos/50001")
    assert wrong.status_code == 404 and wrong.json()["detail"] == "Photo not found"
    # Another committed writer changes the reference while the same process
    # stays alive; the reused id must resolve to the new bytes, not a list cache.
    env["bucket"].objects["albums/reused-id.jpg"] = b"replacement-original"
    with psycopg.connect(env["dsn"], autocommit=True) as writer:
        writer.execute("DELETE FROM album_photos WHERE id=1")
        writer.execute("INSERT INTO album_photos(id,album_id,organization_id,filename,object_name) "
                       "VALUES(1,1,%s,'replacement.jpg','albums/reused-id.jpg')", (TENANT,))
    changed, _ = call(env, "GET", f"{base}/1/photos/1")
    assert changed.status_code == 200 and changed.content == b"replacement-original"
    with psycopg.connect(env["dsn"], autocommit=True) as writer:
        writer.execute("DELETE FROM albums WHERE id=1")
    missing_parent, _ = call(env, "GET", f"{base}/1/photos/1")
    assert missing_parent.status_code == 404 and missing_parent.json()["detail"] == "Data not found"
    REPORT["photo_contract"].append({"cases": records, "inconsistent_child_tenant_blocked": True,
                                     "reused_id_reads_new_reference": True, "orphan_child_blocked": True,
                                     "unauthenticated_photo_read_preserved": True})
