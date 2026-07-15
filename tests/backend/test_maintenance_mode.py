from __future__ import annotations

from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

from src.backend.core import middleware as middleware_module
from src.backend.core.audit_middleware import create_audit_log_middleware
from src.backend.core.maintenance_mode import (
    MaintenanceModeConfigurationError,
    resolve_maintenance_mode,
)
from src.backend.core.middleware import configure_middlewares
from src.backend.routers import meta
from src.backend.services import audit_service


@pytest.mark.parametrize("value", [None, "", "0", "false", "no", "off"])
def test_disabled_values_are_accepted(value: str | None):
    environ = {} if value is None else {"MAINTENANCE_MODE": value}

    config = resolve_maintenance_mode(environ)

    assert config.enabled is False
    assert config.status == "disabled"


@pytest.mark.parametrize("value", ["1", "true", "yes", "on"])
def test_enabled_values_are_accepted_for_test_service(value: str):
    config = resolve_maintenance_mode(
        {
            "MAINTENANCE_MODE": value,
            "APP_ENV": "test",
            "K_SERVICE": "kanade-orchestra-test",
        }
    )

    assert config.enabled is True
    assert config.status == "enabled"


def test_invalid_boolean_value_is_rejected():
    with pytest.raises(MaintenanceModeConfigurationError):
        resolve_maintenance_mode({"MAINTENANCE_MODE": "enabled"})


@pytest.mark.parametrize("app_env", ["prod", "production"])
def test_production_app_environment_is_rejected(app_env: str):
    with pytest.raises(MaintenanceModeConfigurationError):
        resolve_maintenance_mode(
            {
                "MAINTENANCE_MODE": "true",
                "APP_ENV": app_env,
                "K_SERVICE": "kanade-orchestra-test",
            }
        )


def test_production_cloud_run_service_is_rejected():
    with pytest.raises(MaintenanceModeConfigurationError):
        resolve_maintenance_mode(
            {
                "MAINTENANCE_MODE": "true",
                "APP_ENV": "test",
                "K_SERVICE": "kanade-orchestra",
            }
        )


def test_missing_cloud_run_service_is_rejected():
    with pytest.raises(MaintenanceModeConfigurationError):
        resolve_maintenance_mode({"MAINTENANCE_MODE": "true", "APP_ENV": "test"})


def test_missing_app_environment_is_rejected():
    with pytest.raises(MaintenanceModeConfigurationError):
        resolve_maintenance_mode(
            {
                "MAINTENANCE_MODE": "true",
                "K_SERVICE": "kanade-orchestra-test",
            }
        )


def _build_app(
    *,
    enabled: bool,
    static_dir,
    endpoint_called: Mock | None = None,
    audit_logger: Mock | None = None,
) -> FastAPI:
    app = FastAPI()

    if audit_logger is not None:
        app.middleware("http")(create_audit_log_middleware(audit_logger))

    @app.get("/")
    async def root():
        return {"page": "root"}

    @app.api_route("/api/items", methods=["GET", "POST"])
    async def items():
        if endpoint_called is not None:
            endpoint_called()
        return {"items": []}

    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    app.include_router(meta.router)
    configure_middlewares(
        app,
        environ={
            "MAINTENANCE_MODE": "true" if enabled else "false",
            "APP_ENV": "test",
            "K_SERVICE": "kanade-orchestra-test",
        },
    )
    return app


def test_disabled_mode_preserves_normal_access(tmp_path):
    app = _build_app(enabled=False, static_dir=tmp_path)

    response = TestClient(app).get("/api/items", headers={"X-Tenant-Id": "org-a"})

    assert response.status_code == 200
    assert response.json() == {"items": []}
    assert response.headers["X-Tenant-Id"] == "org-a"
    assert app.state.maintenance_mode_enabled is False
    assert app.state.maintenance_mode_status == "disabled"


def test_enabled_mode_allows_health_and_reports_maintenance(tmp_path):
    app = _build_app(enabled=True, static_dir=tmp_path)

    response = TestClient(app).get("/api/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "healthy"
    assert payload["maintenance"] == "enabled"
    assert app.state.maintenance_mode_enabled is True
    assert app.state.maintenance_mode_status == "enabled"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/"),
        ("GET", "/api/items"),
        ("POST", "/api/items"),
        ("GET", "/static/app.js"),
        ("POST", "/api/health"),
    ],
)
def test_enabled_mode_rejects_everything_except_get_health(tmp_path, method: str, path: str):
    app = _build_app(enabled=True, static_dir=tmp_path)

    response = TestClient(app).request(method, path)

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "60"
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json() == {"detail": "Service temporarily unavailable"}
    for internal_detail in ("DB_NAME", "GCS_BUCKET", "operation_id", "K_SERVICE"):
        assert internal_detail not in response.text


def test_rejected_request_does_not_reach_endpoint_tenant_or_audit(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    endpoint_called = Mock()
    tenant_called = Mock(wraps=middleware_module.set_current_tenant_id)
    audit_called = Mock()
    monkeypatch.setattr(middleware_module, "set_current_tenant_id", tenant_called)
    monkeypatch.setattr(audit_service, "should_audit", lambda method, path: True)
    monkeypatch.setattr(audit_service, "write_audit_log", audit_called)
    app = _build_app(
        enabled=True,
        static_dir=tmp_path,
        endpoint_called=endpoint_called,
        audit_logger=Mock(),
    )

    response = TestClient(app).post("/api/items")

    assert response.status_code == 503
    endpoint_called.assert_not_called()
    tenant_called.assert_not_called()
    audit_called.assert_not_called()


def test_configure_middlewares_is_idempotent_and_keeps_startup_decision(tmp_path):
    app = _build_app(enabled=False, static_dir=tmp_path)
    middleware_count = len(app.user_middleware)

    configure_middlewares(
        app,
        environ={
            "MAINTENANCE_MODE": "invalid-after-startup",
            "APP_ENV": "production",
            "K_SERVICE": "kanade-orchestra",
        },
    )

    assert len(app.user_middleware) == middleware_count
    assert app.state.maintenance_mode_enabled is False
    assert TestClient(app).get("/api/items").status_code == 200
