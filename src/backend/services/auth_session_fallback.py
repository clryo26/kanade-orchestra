from __future__ import annotations

import time
from copy import deepcopy
from datetime import timedelta
from typing import Any

from ..utils.datetime_utils import format_instant, jst_now

# Lifetime unchanged (8 hours). Measured on a monotonic clock so wall-clock
# or timezone changes never shorten/extend it (JST spec R08).
_FALLBACK_TTL = timedelta(hours=8)
_fallback_devices: dict[str, dict[str, Any]] = {}


def _now() -> float:
    return time.monotonic()


def _is_expired(device: dict[str, Any], now: float) -> bool:
    expires_at = device.get("_fallback_expires_at")
    if not isinstance(expires_at, (int, float)):
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
    stored["_fallback_expires_at"] = _now() + _FALLBACK_TTL.total_seconds()
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
    device["last_seen_at"] = format_instant(jst_now())
    return public_auth_device(device)


def list_fallback_auth_devices() -> list[dict[str, Any]]:
    now = _now()
    active: list[dict[str, Any]] = []
    expired_keys: list[str] = []
    for device_id, device in _fallback_devices.items():
        if _is_expired(device, now):
            expired_keys.append(device_id)
            continue
        active.append(public_auth_device(device))
    for key in expired_keys:
        _fallback_devices.pop(key, None)
    return active


def forget_auth_device(device_id: str) -> None:
    _fallback_devices.pop(str(device_id or "").strip(), None)
