"""Slow storage must not stall other requests on the ASGI event loop."""
from __future__ import annotations

import asyncio
import threading

import httpx
import pytest
from fastapi import FastAPI

from src.backend.core.middleware import configure_middlewares
from src.backend.core.tenant_context import get_current_tenant_id
from src.backend.routers import scores


@pytest.mark.parametrize("operation", ["zip", "upload"])
def test_slow_sheet_storage_allows_a_concurrent_cancel_request(monkeypatch, operation):
    started, release, finished = threading.Event(), threading.Event(), threading.Event()

    def slow_step(*args):
        assert get_current_tenant_id() == "review-organization"
        started.set()
        release.wait(timeout=2)
        finished.set()
        return {"state": "building"} if operation == "zip" else (200, {"file": {"id": 1}})

    monkeypatch.setattr(scores.zips, "step", slow_step)
    monkeypatch.setattr(scores.library, "_store_upload", slow_step)
    monkeypatch.setattr(scores.zips, "cancel", lambda *args: {"state": "cancelled"})
    app = FastAPI()
    configure_middlewares(app, environ={})
    app.include_router(scores.router)
    app.dependency_overrides[scores.get_device_auth] = lambda: {"device_id": "test"}
    app.dependency_overrides[scores.get_sheet_manager_device_auth] = lambda: {"device_id": "test"}

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            headers = {"X-Organization-Id": "review-organization"}
            request = client.post("/api/sheets/zip-jobs/test/step", headers=headers) if operation == "zip" else client.post(
                "/api/sheets/upload", headers=headers, data={"performance_id": "1", "piece": "Sym"},
                files={"file": ("test.pdf", b"%PDF-1.4 test", "application/pdf")})
            task = asyncio.create_task(request)
            try:
                for _ in range(100):
                    if started.is_set():
                        break
                    await asyncio.sleep(0.005)
                assert started.is_set()
                response = await asyncio.wait_for(client.post("/api/sheets/zip-jobs/test/cancel"), timeout=1)
                assert response.json()["state"] == "cancelled"
                assert not finished.is_set(), "The cancel request had to wait for slow storage"
            finally:
                release.set()
                assert (await task).status_code == 200

    asyncio.run(run())
