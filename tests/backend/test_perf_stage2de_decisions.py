"""Synthetic D0/E0 evidence. Real service/middleware functions, no live DB/GCS."""
from __future__ import annotations

import asyncio
import gzip
import json
import os
from pathlib import Path
from time import perf_counter
from types import SimpleNamespace

import pytest
from fastapi import Request
from fastapi.responses import Response


def report(name, value):
    if os.getenv("PORTAL_PERF_CDE_REPORT") == "1":
        target = Path("docs/perf_stage2_cde") / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def test_d0_existing_summary_and_empty_core_do_not_require_v2():
    from src.backend.services import auth_service as auth, bootstrap_service as bootstrap

    samples = []
    for scale in (1, 2):
        fixture = {
            "members": [{"id": i + 1, "name": f"Synthetic {i}", "part": "Violin", "permission": "一般", "password": ""}
                        for i in range(100 * scale)],
            "performances": [{"id": i + 1, "title": f"Synthetic {i}", "date": "2026-12-01"} for i in range(10 * scale)],
            "schedules": [{"id": i + 1, "date": "2026-12-01", "performance_id": 1} for i in range(200 * scale)],
            "absences": [{"id": i + 1, "schedule_id": i % (200 * scale) + 1, "member_id": i % (100 * scale) + 1}
                         for i in range(5000 * scale)],
            "events": [{"id": i + 1, "title": f"Event {i}"} for i in range(20 * scale)],
            "event_responses": [{"id": i + 1, "event_id": i % (20 * scale) + 1, "member_id": i % (100 * scale) + 1}
                                for i in range(1000 * scale)],
            "albums": [{"id": i + 1, "title": f"Album {i}", "photos": [{"id": i * 25 + j + 1} for j in range(25)]}
                       for i in range(20 * scale)],
            "payments": [{"id": i + 1, "member_id": i + 1} for i in range(100 * scale)],
        }

        async def devices():
            return []

        for permission in ("一般", "管理者", "システム管理者"):
            for repeat in range(5):
                loads = []

                def load(name):
                    loads.append(name)
                    return fixture.get(name, [])

                start = perf_counter()
                lite = asyncio.run(bootstrap.bootstrap_lite_payload(
                    load_json_data=load, public_member_list=auth.public_member_list,
                    personal_payment_list=lambda rows: auth.personal_payment_list(rows, {"member_id": 1, "permission": permission}),
                    cloud_run_revision=lambda: "synthetic"))
                lite_ms = (perf_counter() - start) * 1000
                lite_loads = list(loads)
                loads.clear()
                core = asyncio.run(bootstrap.bootstrap_core_payload(cloud_run_revision=lambda: "synthetic"))
                full = asyncio.run(bootstrap.bootstrap_payload(
                    load_json_data=load, public_member_payload=auth.public_member_payload,
                    recording_payload=lambda: {"files": []}, sheet_payload=lambda: {"files": []},
                    list_auth_devices=devices, cloud_run_revision=lambda: "synthetic"))
                assert core["extras"] == {}
                assert "comment" not in lite["members"][0]
                assert len(lite["extras"]["payments"]) == 1
                assert "concert_record_videos" not in full["extras"]

                def size(value):
                    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
                    return {"jsonBytes": len(body), "gzipBytes": len(gzip.compress(body, mtime=0))}

                samples.append({"scale": scale, "permission": permission, "repeat": repeat,
                                "lite": size(lite), "core": size(core), "full": size(full),
                                "liteBuildMs": lite_ms, "liteLoads": lite_loads,
                                "liteFields": {key: size(value)["jsonBytes"] for key, value in lite.items()}})
    report("d0_bootstrap.json", {"mode": "real payload functions, synthetic data, service-level gzip estimate",
                                "samples": samples, "dbQueries": None, "browserDisplayMs": None,
                                "decision": "D1 held: core already empty; no measured browser benefit for moving required lite fields"})


@pytest.fixture(scope="module")
def audit_measurements():
    values = []
    yield values
    report("e0_audit.json", {"samples": values, "realPoolWaitMs": None, "realEventLoopDelayMs": None,
                             "decision": "E1 held: authentication snapshot can differ from current audit actor"})


@pytest.mark.parametrize("status", [200, 201, 204, 401, 403, 500, None])
@pytest.mark.parametrize("actor_mode", ["member", "no_member", "empty", "lookup_error"])
def test_e0_audit_reads_current_actor_after_handler(monkeypatch, status, actor_mode, audit_measurements):
    from src.backend.core.audit_middleware import create_audit_log_middleware
    from src.backend.services import audit_service as audit

    counters = {"actorLookups": 0, "inserts": 0, "actorMs": 0.0, "insertMs": 0.0}
    rows = []
    actor = {"member_id": 1, "member_name": "before", "permission": "一般"}
    authentication_snapshot = dict(actor)

    def lookup(_device):
        start = perf_counter()
        counters["actorLookups"] += 1
        try:
            if actor_mode == "lookup_error":
                raise RuntimeError("synthetic lookup failure")
            if actor_mode == "empty":
                return {}
            return {**actor, "member_id": None} if actor_mode == "no_member" else dict(actor)
        finally:
            counters["actorMs"] += (perf_counter() - start) * 1000

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return self

        def execute(self, sql, values):
            start = perf_counter()
            rows.append(values)
            counters["inserts"] += 1
            counters["insertMs"] += (perf_counter() - start) * 1000

    monkeypatch.setattr(audit, "db_configured", lambda *args: True)
    monkeypatch.setattr(audit, "db_connection_string", lambda: "synthetic")
    monkeypatch.setattr(audit, "psycopg", SimpleNamespace(connect=lambda *args, **kwargs: Connection()))
    monkeypatch.setattr(audit, "device_auth_record", lookup)
    monkeypatch.setenv("AUDIT_LOG_ENABLED", "true")
    middleware = create_audit_log_middleware(SimpleNamespace(exception=lambda *args: None))
    request = Request({"type": "http", "method": "POST", "path": "/api/announcements", "query_string": b"",
                       "headers": [(b"x-device-id", b"synthetic"), (b"x-request-id", b"fixture")],
                       "client": ("127.0.0.1", 1)})

    async def handler(_request):
        # A different request may commit the same change while this handler runs.
        actor.update(member_name="after", permission="管理者")
        if status is None:
            raise RuntimeError("synthetic handler failure")
        return Response(status_code=status)

    if status is None:
        with pytest.raises(RuntimeError):
            asyncio.run(middleware(request, handler))
    else:
        response = asyncio.run(middleware(request, handler))
        assert response.status_code == status and "app;dur=" in response.headers["Server-Timing"]
    assert len(rows) == 1 and rows[0][7] == status
    if actor_mode in ("member", "no_member"):
        assert rows[0][2] == "after" and rows[0][2] != authentication_snapshot["member_name"]
    else:
        assert rows[0][2] == ""
    audit_measurements.append({"mode": "real middleware/audit function, fake DB adapter",
                               "status": status, "actorMode": actor_mode, "counters": counters})
