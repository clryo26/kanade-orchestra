"""Same-fixture before/after measurements; no production connection or data."""
from __future__ import annotations

from functools import wraps
import inspect
import json
import os
from pathlib import Path
from time import perf_counter

import psycopg
import pytest

from test_perf_stage3_postgres import database, enabled, DSN  # noqa: F401
from src.backend import app_core
from src.backend.core import db_pool
from src.backend.core.collection_clock_schema import READ_DEPENDENCIES
from src.backend.repositories.db_row_repository import _ORG_COLUMN_CACHE

pytestmark = pytest.mark.skipif(not DSN, reason="dedicated stage-3 loopback PostgreSQL required")


@pytest.mark.parametrize("database", [1, 2], indirect=True)
def test_same_fixture_body_parity_and_http_measurements(database, monkeypatch, request):  # noqa: F811
    paths = list(READ_DEPENDENCIES)
    meter = {}
    samples, bodies = [], {}

    class Counter(psycopg.Cursor):
        def execute(self, query, params=None, **kwargs):
            text = (query.as_string(self.connection) if hasattr(query, "as_string")
                    else query.decode("utf-8") if isinstance(query, bytes) else str(query))
            # psycopg_pool.check_connection() executes an empty query. It is
            # pool health work, not an application SELECT or transaction SET.
            if text.strip():
                meter["sql"] += 1
                control = text.lstrip().upper().startswith(("BEGIN", "SET ", "COMMIT", "ROLLBACK"))
                meter["transaction_control_sql"] += int(control)
                meter["data_sql"] += int(not control)
                meter["xmin_sql"] += int("xmin" in text)
            return super().execute(query, params, **kwargs)

    from src.backend.services import (
        announcement_service, bootstrap_service, event_service, member_introduction_service,
        member_service, performance_service, schedule_service,
    )
    def counted(fn):
        if inspect.iscoroutinefunction(fn):
            @wraps(fn)
            async def call(*args, **kwargs):
                meter["payload_builds"] += 1
                return await fn(*args, **kwargs)
        else:
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
        monkeypatch.setattr(module, name, counted(getattr(module, name)))
    with enabled(database, monkeypatch, paths) as client:
        acquire = db_pool._pool.getconn
        def getconn(*args, **kwargs):
            started = perf_counter()
            conn = acquire(*args, **kwargs)
            meter["connection_acquire_ms"] += (perf_counter()-started)*1000
            meter["checkouts"] += 1
            conn.cursor_factory = Counter
            return conn
        monkeypatch.setattr(db_pool._pool, "getconn", getconn)
        for mode in ("legacy", "snapshot"):
            monkeypatch.setenv("PORTAL_READ_CONTEXT_PATHS", ",".join(paths) if mode == "snapshot" else "")
            monkeypatch.setenv("PORTAL_VERSION_ETAG_PATHS", ",".join(p for p in paths if p != "/api/member-introductions")
                               if mode == "snapshot" else "")
            for path in paths:
                for repeat in range(5):
                    app_core._memory_cache.clear_all_tenants()
                    _ORG_COLUMN_CACHE.clear()
                    tag = None
                    for phase in ("cold200", "warm304", "cleared_memory304"):
                        if phase == "cleared_memory304":
                            app_core._memory_cache.clear_all_tenants()
                        meter.clear()
                        meter.update(sql=0, data_sql=0, transaction_control_sql=0, xmin_sql=0,
                                     checkouts=0, payload_builds=0, connection_acquire_ms=0.0)
                        pool_before = db_pool._pool.get_stats().get("requests_wait_ms", 0)
                        start = perf_counter()
                        response = client.get(path, headers={"If-None-Match": tag} if tag else {})
                        elapsed = (perf_counter()-start)*1000
                        assert response.status_code == (200 if phase == "cold200" else 304), response.text
                        if phase == "cold200":
                            tag = response.headers["ETag"]
                            if mode == "legacy":
                                bodies[path] = response.json()
                            else:
                                assert response.json() == bodies[path]
                        if mode == "snapshot":
                            assert meter["checkouts"] == 1 and meter["xmin_sql"] == 0
                            if phase != "cold200" and path != "/api/member-introductions":
                                assert meter["payload_builds"] == 0
                        samples.append(dict(mode=mode, path=path, repeat=repeat, cache_state=phase,
                                            status=response.status_code, application_body_bytes=len(response.content),
                                            request_ms=elapsed, pool_queue_wait_ms=db_pool._pool.get_stats().get(
                                                "requests_wait_ms", 0)-pool_before, **meter))
        # A conservative version bump may turn an otherwise-304 into an
        # identical-body 200. Record this cost instead of claiming an improvement.
        no_op = []
        for _ in range(5):
            before = client.get("/api/schedules")
            with psycopg.connect(DSN, autocommit=True) as writer:
                writer.execute("UPDATE schedules SET venue=venue WHERE id=1")
            after = client.get("/api/schedules", headers={"If-None-Match": before.headers["ETag"]})
            assert after.status_code == 200 and after.json() == before.json()
            no_op.append({"status": 200, "application_body_bytes": len(after.content)})
    dest = os.getenv("PORTAL_PERF_STAGE3_REPORT", "")
    if dest:
        report = Path(dest).resolve()
        assert report.is_relative_to(Path("docs/perf_stage3").resolve())
        report.parent.mkdir(parents=True, exist_ok=True)
        scale = request.node.callspec.params["database"]
        report = report.with_name(report.stem + f"_scale{scale}.json")
        report.write_text(json.dumps({"scope": "same fixture, actual routes, isolated PostgreSQL, identity encoding",
                                      "scale": scale, "body_parity": True, "samples": samples,
                                      "schedules_same_value_update_additional_200": no_op,
                                      "test_instance_hit_frequency": None, "gcs_requests": None,
                                      "limitations": ["Compatibility schema plus real 023 migration, not full migration replay",
                                                      "No TEST/production traffic or real-device measurements",
                                                      "Application SQL includes transaction setup; pool empty-query health checks excluded",
                                                      "Body bytes are not compressed transfer bytes"]}, indent=2)+"\n", encoding="utf-8")
