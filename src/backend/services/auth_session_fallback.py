from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
from typing import Any


_FALLBACK_TTL = timedelta(hours=8)
_fallback_devices: dict[str, dict[str, Any]] = {}


def _now() -> datetime:
    return datetime.now()


def _is_expired(device: dict[str, Any], now: datetime) -> bool:
    expires_at = device.get("_fallback_expires_at")
    if not isinstance(expires_at, datetime):
        return True
    return expires_at <= now


def remember_auth_device(device: dict[str, Any]) -> dict[str, Any]:
    """Keep a temporary device session when auth_devices persistence fails.

    This is intentionally process-local and short-lived. It protects the login
    flow from a broken auth_devices table/write path without replacing normal
    DB-backed authentication.
    """

    device_id = str(device.get("device_id") or "").strip()
    if not device_id:
        return device
    stored = deepcopy(device)
    stored["_fallback_expires_at"] = _now() + _FALLBACK_TTL
    _fallback_devices[device_id] = stored
    return public_auth_device(stored)


def public_auth_device(device: dict[str, Any]) -> dict[str, Any]:
    payload = deepcopy(device)
    payload.pop("_fallback_expires_at", None)
    return payload


def fallback_auth_device(device_id: str) -> dict[str, Any] | None:
    key = str(device_id or "").strip()
    if not key:
        return None
    device = _fallback_devices.get(key)
    if not device:
        return None
    now = _now()
    if _is_expired(device, now):
        _fallback_devices.pop(key, None)
        return None
    device["last_seen_at"] = now.isoformat()
    return public_auth_device(device)


def forget_auth_device(device_id: str) -> None:
    _fallback_devices.pop(str(device_id or "").strip(), None)
