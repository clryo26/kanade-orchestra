from __future__ import annotations

from fastapi.testclient import TestClient

from src.backend import main as backend


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
