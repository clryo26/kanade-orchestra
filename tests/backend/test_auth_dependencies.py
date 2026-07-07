from __future__ import annotations

import pytest
from fastapi import HTTPException

from src.backend.core.auth_dependencies import (
    get_admin_device_auth,
    get_device_auth,
    get_production_operation_auth,
    get_recording_manager_device_auth,
    get_sheet_manager_device_auth,
    get_system_admin_device_auth,
)


def test_get_device_auth_requires_device_id():
    with pytest.raises(HTTPException) as exc:
        get_device_auth("")
    assert exc.value.status_code == 401
    assert exc.value.detail == "X-Device-Id is required"


def test_get_admin_device_auth_accepts_admin(seed_device_fn):
    seed_device_fn(device_id="dev-admin", permission="管理者")

    device = get_admin_device_auth("dev-admin")

    assert device["device_id"] == "dev-admin"
    assert device["permission"] == "管理者"


def test_get_admin_device_auth_rejects_general(seed_device_fn):
    seed_device_fn(device_id="dev-general", permission="一般")

    with pytest.raises(HTTPException) as exc:
        get_admin_device_auth("dev-general")
    assert exc.value.status_code == 403
    assert exc.value.detail == "Admin permission is required"


def test_get_system_admin_device_auth_requires_system_role(seed_device_fn):
    seed_device_fn(device_id="dev-admin", permission="管理者")

    with pytest.raises(HTTPException) as exc:
        get_system_admin_device_auth("dev-admin")
    assert exc.value.status_code == 403
    assert exc.value.detail == "System admin permission is required"


def test_get_recording_manager_device_auth_accepts_manager_flag(seed_device_fn):
    seed_device_fn(device_id="dev-rec", permission="一般", is_recording_manager=True)

    device = get_recording_manager_device_auth("dev-rec")

    assert device["device_id"] == "dev-rec"


def test_get_sheet_manager_device_auth_accepts_admin(seed_device_fn):
    seed_device_fn(device_id="dev-admin", permission="管理者")

    device = get_sheet_manager_device_auth("dev-admin")

    assert device["device_id"] == "dev-admin"


def test_get_production_operation_auth_accepts_system_admin_in_test_env(seed_device_fn, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    seed_device_fn(device_id="dev-system", permission="システム管理者")

    device = get_production_operation_auth("dev-system")

    assert device["device_id"] == "dev-system"


def test_get_production_operation_auth_rejects_hidden_user(seed_device_fn, backend_env, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    seed_device_fn(device_id="dev-hidden", permission="システム管理者")
    devices = backend_env.load_json_data("auth_devices")
    for item in devices:
        if item.get("device_id") == "dev-hidden":
            item["hidden_user"] = True
            break
    backend_env.save_json_data("auth_devices", devices)

    with pytest.raises(HTTPException) as exc:
        get_production_operation_auth("dev-hidden")
    assert exc.value.status_code == 403
    assert exc.value.detail == "隠しシステム管理者では本番リリース・本番同期を実行できません"


def test_get_production_operation_auth_rejects_non_test_env(seed_device_fn, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    seed_device_fn(device_id="dev-system", permission="システム管理者")

    with pytest.raises(HTTPException) as exc:
        get_production_operation_auth("dev-system")
    assert exc.value.status_code == 403
    assert "APP_ENV=test" in str(exc.value.detail)
