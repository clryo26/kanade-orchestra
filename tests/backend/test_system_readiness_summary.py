from __future__ import annotations

from fastapi.testclient import TestClient

from src.backend.routers import scores as scores_router


def _login_system_admin(client: TestClient, device_id: str = "dev-system") -> dict[str, str]:
    login = client.post(
        "/api/auth/portal-login",
        json={
            "name": "administrator",
            "part": "",
            "password": "systemadminadmin",
            "device_id": device_id,
            "device_name": "Readiness Test Device",
        },
    )
    assert login.status_code == 200
    return {"X-Device-Id": device_id}


def _force_local_backend(monkeypatch) -> None:
    monkeypatch.setenv("DATA_BACKEND", "local")
    monkeypatch.setenv("LOCAL_JSON_FALLBACK_ENABLED", "true")
    for key in ["DB_URL", "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]:
        monkeypatch.delenv(key, raising=False)


def test_readiness_summary_requires_system_admin_auth(monkeypatch, backend_env) -> None:
    _force_local_backend(monkeypatch)
    with TestClient(backend_env.app) as client:
        response = client.get("/api/system/readiness-summary")
        assert response.status_code in {401, 403}


def test_readiness_summary_returns_expected_shape(monkeypatch, backend_env) -> None:
    _force_local_backend(monkeypatch)
    with TestClient(backend_env.app) as client:
        headers = _login_system_admin(client)
        response = client.get("/api/system/readiness-summary", headers=headers)
        assert response.status_code == 200
        payload = response.json()
        assert payload["overall_status"] in {"ok", "warning"}
        assert isinstance(payload.get("checks"), list)
        assert "runtime" in payload
        assert "governance" in payload
        assert any(item.get("key") == "app_core_budget" for item in payload.get("checks", []))



def _use_local_pdf_editor_storage(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(scores_router, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(scores_router, "PDF_EDITOR_LOCAL_DIR", tmp_path / "pdf-editor")
    monkeypatch.setattr(scores_router, "storage_enabled", lambda: False)


def test_pdf_editor_system_admin_can_upload_and_list_single_pdf(monkeypatch, backend_env, tmp_path) -> None:
    _force_local_backend(monkeypatch)
    _use_local_pdf_editor_storage(monkeypatch, tmp_path)
    with TestClient(backend_env.app) as client:
        headers = _login_system_admin(client, "dev-pdf-system")
        uploaded = client.post(
            "/api/system/pdf-editor/files",
            headers=headers,
            files={"file": ("sample score.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")},
        )
        assert uploaded.status_code == 200
        assert uploaded.json()["file"]["name"] == "sample score.pdf"

        listed = client.get("/api/system/pdf-editor/files", headers=headers)
        assert listed.status_code == 200
        files = listed.json()["files"]
        assert len(files) == 1
        assert files[0]["name"] == "sample score.pdf"


def test_pdf_editor_rejects_non_pdf(monkeypatch, backend_env, tmp_path) -> None:
    _force_local_backend(monkeypatch)
    _use_local_pdf_editor_storage(monkeypatch, tmp_path)
    with TestClient(backend_env.app) as client:
        headers = _login_system_admin(client, "dev-pdf-system")
        response = client.post(
            "/api/system/pdf-editor/files",
            headers=headers,
            files={"file": ("not-pdf.txt", b"text", "text/plain")},
        )
        assert response.status_code == 400


def test_pdf_editor_requires_system_admin(monkeypatch, backend_env, tmp_path) -> None:
    _force_local_backend(monkeypatch)
    _use_local_pdf_editor_storage(monkeypatch, tmp_path)
    with TestClient(backend_env.app) as client:
        response = client.get("/api/system/pdf-editor/files")
        assert response.status_code in {401, 403}
