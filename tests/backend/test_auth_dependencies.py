from __future__ import annotations

import pytest
from fastapi import HTTPException

from src.backend.core.auth_dependencies import (
    get_admin_device_auth,
    get_device_auth,
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
