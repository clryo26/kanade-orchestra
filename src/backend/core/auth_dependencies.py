from __future__ import annotations

import hmac
import os
from typing import Any, cast

from fastapi import Header, HTTPException

from .authorization import require_admin_device, require_device, require_system_admin_device
from ..services.auth_service import (
    device_auth_record,
    require_recording_manager_device,
    require_sheet_manager_device,
)


def get_device_auth(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    return require_device(x_device_id, device_auth_record=device_auth_record)


def get_admin_device_auth(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    return require_admin_device(x_device_id, device_auth_record=device_auth_record)


def get_system_admin_device_auth(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    return require_system_admin_device(x_device_id, device_auth_record=device_auth_record)


def get_recording_manager_device_auth(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    return cast(dict[str, Any], require_recording_manager_device(x_device_id))


def get_sheet_manager_device_auth(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    return cast(dict[str, Any], require_sheet_manager_device(x_device_id))


def get_diagnostic_admin_auth(
    x_device_id: str,
    authorization: str,
    *,
    require_bearer_token: bool,
) -> dict[str, Any]:
    """Authorize diagnostic endpoint access.

    In production this should require a dedicated bearer token. A device-auth
    fallback can be enabled only for temporary migration windows.
    """

    token = os.getenv("DIAGNOSTIC_CONFIG_ADMIN_TOKEN", "").strip()
    auth_header = (authorization or "").strip()
    if auth_header.lower().startswith("bearer "):
        candidate = auth_header[7:].strip()
        if not token:
            raise HTTPException(status_code=503, detail="Diagnostic bearer token is not configured")
        if hmac.compare_digest(candidate, token):
            return {
                "auth_type": "bearer",
                "permission": "diagnostic_admin",
            }
        raise HTTPException(status_code=401, detail="Invalid diagnostic bearer token")

    if require_bearer_token:
        # Production path: bearer token is mandatory.
        raise HTTPException(status_code=401, detail="Bearer token is required for diagnostic endpoint")

    if x_device_id:
        try:
            return get_admin_device_auth(x_device_id)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=401, detail="Device admin authentication failed")

    raise HTTPException(status_code=401, detail="Diagnostic admin authentication is required")
