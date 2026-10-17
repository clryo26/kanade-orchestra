from __future__ import annotations

import asyncio
from uuid import uuid4

from fastapi.testclient import TestClient

from src.backend.production_maintenance import app as maintenance_app
from src.backend.repositories import promotion_repository as repo
from src.backend.services import promotion_service as service
from src.backend.services import promotion_image_service as images
from src.backend.services import promotion_reset_service as reset

ADMIN = {"permission": "システム管理者", "hidden_user": True, "member_name": "Administrator"}


def test_reset_manifest_survives_image_failure_and_resumes(backend_env, monkeypatch):
    status, body = asyncio.run(service.mutate("POST", None, {"title": "Reset test"}, ADMIN, str(uuid4())))
    assert status == 200
    # Legacy image is owned by this explicit promotion ID; reset must remember
    # its path before removing the DB row.
    name = f"promotion-images/{body['id']}/image.png"
    path = images.local_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"image")
    with repo.transaction() as cur:
        cur.execute("UPDATE promotions SET image_url=%s WHERE id=%s", (f"/api/extra/promotions/{body['id']}/image?ext=png", body["id"]))
    assert reset.prepare("test-env")["mode"] == "dry-run"
    with repo.transaction() as cur:
        cur.execute("SELECT COUNT(*) AS count FROM promotion_reset_runs")
        assert cur.fetchone()["count"] == 0
    run = reset.prepare("test-env", execute=True)
    original = images.delete_object
    monkeypatch.setattr(images, "delete_object", lambda *args: (_ for _ in ()).throw(RuntimeError("offline")))
    assert reset.resume(run["run_id"], "test-env", execute=True)["state"] == "cleaning"
    assert repo.list_items() == [] and path.exists()
    monkeypatch.setattr(images, "delete_object", original)
    assert reset.resume(run["run_id"], "test-env", execute=True)["state"] == "completed"
    assert not path.exists()
    assert reset.resume(run["run_id"], "test-env", execute=True)["state"] == "completed"


def test_production_maintenance_does_not_serve_writes():
    client = TestClient(maintenance_app)
    assert client.get("/api/health").json()["mode"] == "production-maintenance"
    for method in ("GET", "POST", "PUT", "DELETE"):
        response = client.request(method, "/api/extra/promotions")
        assert response.status_code == 503
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["retry-after"]
