from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException

from .config import app_env_for_production_operations, production_operations_allowed_env


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


def require_production_operation_authority(
    device_id: str,
    device_auth_record: Callable[[str], dict[str, Any]],
) -> dict[str, Any]:
    device = require_system_admin_device(device_id, device_auth_record=device_auth_record)
    if bool(device.get("hidden_user")):
        raise HTTPException(status_code=403, detail="隠しシステム管理者では本番リリース・本番同期を実行できません")

    app_env = app_env_for_production_operations()
    allowed_env = production_operations_allowed_env()
    if app_env != allowed_env:
        raise HTTPException(status_code=403, detail=f"本番操作は APP_ENV={allowed_env} でのみ実行できます")
    return device
