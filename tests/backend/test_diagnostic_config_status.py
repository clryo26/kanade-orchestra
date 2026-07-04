from __future__ import annotations

import importlib
from typing import Any

from fastapi.testclient import TestClient


MODULE = "src.backend.routers.meta"


def _reload_meta_module(monkeypatch, env: dict[str, str]) -> Any:
    for key in [
        "DIAGNOSTIC_CONFIG_ENABLED",
        "DIAGNOSTIC_CONFIG_REQUIRE_ADMIN",
        "DIAGNOSTIC_CONFIG_VERBOSE",
        "DIAGNOSTIC_CONFIG_ADMIN_TOKEN",
        "DIAGNOSTIC_CONFIG_ALLOW_DEVICE_AUTH",
        "APP_ENV",
        "DATA_BACKEND",
        "DB_HOST",
        "DB_NAME",
        "DB_USER",
        "DB_URL",
        "GCS_BUCKET",
        "CORS_ORIGINS",
        "K_SERVICE",
        "K_REVISION",
    ]:
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    mod = importlib.import_module(MODULE)
    return importlib.reload(mod)


def _build_test_app(meta_module):
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(meta_module.router)
    return app


def test_config_status_disabled_by_default_returns_404(monkeypatch):
    meta_module = _reload_meta_module(monkeypatch, {"APP_ENV": "production"})
    app = _build_test_app(meta_module)

    with TestClient(app) as client:
        response = client.get("/api/diagnostic/config-status")

    assert response.status_code == 404


def test_config_status_requires_admin_in_production(monkeypatch):
    meta_module = _reload_meta_module(
        monkeypatch,
        {
            "APP_ENV": "production",
            "DIAGNOSTIC_CONFIG_ENABLED": "true",
            "DIAGNOSTIC_CONFIG_REQUIRE_ADMIN": "true",
            "DIAGNOSTIC_CONFIG_ADMIN_TOKEN": "test-diagnostic-token",
            "DATA_BACKEND": "db",
        },
    )
    app = _build_test_app(meta_module)

    with TestClient(app) as client:
        response = client.get("/api/diagnostic/config-status")

    assert response.status_code == 401


def test_config_status_accepts_bearer_token_in_production(monkeypatch):
    meta_module = _reload_meta_module(
        monkeypatch,
        {
            "APP_ENV": "production",
            "DIAGNOSTIC_CONFIG_ENABLED": "true",
            "DIAGNOSTIC_CONFIG_REQUIRE_ADMIN": "true",
            "DIAGNOSTIC_CONFIG_ADMIN_TOKEN": "phase8b-secret",
            "DATA_BACKEND": "db",
        },
    )
    app = _build_test_app(meta_module)

    with TestClient(app) as client:
        response = client.get(
            "/api/diagnostic/config-status",
            headers={"Authorization": "Bearer phase8b-secret"},
        )

    assert response.status_code == 200


def test_config_status_still_requires_bearer_in_production_even_when_device_fallback_flag_enabled(monkeypatch):
    meta_module = _reload_meta_module(
        monkeypatch,
        {
            "APP_ENV": "production",
            "DIAGNOSTIC_CONFIG_ENABLED": "true",
            "DIAGNOSTIC_CONFIG_REQUIRE_ADMIN": "true",
            "DIAGNOSTIC_CONFIG_ADMIN_TOKEN": "phase8b-secret",
            "DIAGNOSTIC_CONFIG_ALLOW_DEVICE_AUTH": "true",
            "DATA_BACKEND": "db",
        },
    )
    app = _build_test_app(meta_module)

    with TestClient(app) as client:
        response = client.get("/api/diagnostic/config-status", headers={"X-Device-Id": "dev-1"})

    assert response.status_code == 401


def test_config_status_returns_masked_payload_when_enabled(monkeypatch):
    meta_module = _reload_meta_module(
        monkeypatch,
        {
            "APP_ENV": "dev",
            "DIAGNOSTIC_CONFIG_ENABLED": "true",
            "DIAGNOSTIC_CONFIG_REQUIRE_ADMIN": "false",
            "DIAGNOSTIC_CONFIG_VERBOSE": "false",
            "DATA_BACKEND": "db",
            "DB_HOST": "127.0.0.1",
            "DB_NAME": "orchestra",
            "DB_USER": "orchestra",
            "DB_URL": "postgresql://orchestra:secret@127.0.0.1:5432/orchestra",
            "GCS_BUCKET": "kanade-orchestra-private-bucket",
            "CORS_ORIGINS": "http://localhost:8080,http://127.0.0.1:8080",
            "K_SERVICE": "oke-portal",
            "K_REVISION": "oke-portal-00012-abc",
        },
    )
    app = _build_test_app(meta_module)

    with TestClient(app) as client:
        response = client.get("/api/diagnostic/config-status")

    assert response.status_code == 200
    payload = response.json()

    assert payload["appEnv"] == "dev"
    assert payload["profile"] == "db"
    assert payload["corsConfigured"] is True
    assert payload["corsOriginCount"] == 2
    assert payload["cloudRunDetected"] is True

    assert payload["databaseHostMasked"] != "127.0.0.1"
    assert payload["gcsBucketMasked"] != "kanade-orchestra-private-bucket"
    assert payload["cloudRunRevisionMasked"] != "oke-portal-00012-abc"

    # Leaky keys from previous implementation should never appear.
    assert "dbHost" not in payload
    assert "dbName" not in payload
    assert "dbUrlMasked" not in payload
    assert "corsOrigins" not in payload
