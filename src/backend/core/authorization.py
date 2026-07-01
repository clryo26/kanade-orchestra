from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException


def require_device(device_id: str, device_auth_record: Callable[[str], dict[str, Any]]) -> dict[str, Any]:
    return device_auth_record(device_id)


def require_admin_device(device_id: str, device_auth_record: Callable[[str], dict[str, Any]]) -> dict[str, Any]:
    device = device_auth_record(device_id)
    permission = str(device.get("permission") or "")
    if permission not in {"管理者", "システム管理者"}:
        raise HTTPException(status_code=403, detail="Admin permission is required")
    return device


def require_system_admin_device(device_id: str, device_auth_record: Callable[[str], dict[str, Any]]) -> dict[str, Any]:
    device = device_auth_record(device_id)
    permission = str(device.get("permission") or "")
    if permission != "システム管理者":
        raise HTTPException(status_code=403, detail="System admin permission is required")
    return device
