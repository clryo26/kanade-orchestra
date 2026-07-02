from __future__ import annotations

from typing import Any, Callable, cast

from fastapi import HTTPException

from ..auth_helpers import find_member_by_login_name, member_access_expired, member_display_name
from ..services.auth_session_fallback import fallback_auth_device
from ..services.security_service import hash_password, is_hashed_password, is_password_placeholder, verify_password
from .storage_service import load_json_data
from ..utils.serialization import model_dump


def validate_member_login(name: str, part: str, password: str) -> dict[str, Any]:
    members = load_json_data("members")
    _, member = find_member_by_login_name(members, name, part)
    if member_access_expired(member):
        raise HTTPException(status_code=403, detail="システム利用期限が終了しています")
    member_password = str(member.get("password") or "")
    if is_password_placeholder(member_password):
        raise HTTPException(status_code=401, detail="Member password is not set")
    if not verify_password(password, member_password):
        raise HTTPException(status_code=401, detail="Invalid member password")
    return member


def prepare_member_payload(member: Any, current: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = model_dump(member)
    raw_password = str(payload.get("password") or "")
    if raw_password:
        payload["password"] = raw_password if is_hashed_password(raw_password) else hash_password(raw_password)
    elif current is not None:
        payload["password"] = current.get("password") or ""
    else:
        payload["password"] = ""
    payload.pop("password_set", None)
    payload["name"] = member_display_name(payload)
    return payload


def public_member_payload(member: dict[str, Any]) -> dict[str, Any]:
    payload = dict(member)
    payload["password_set"] = bool(payload.get("password"))
    payload["password"] = ""
    return payload


def public_member_list(members: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [public_member_payload(member) for member in members]


def device_auth_record(device_id: str) -> dict[str, Any]:
    if not device_id:
        raise HTTPException(status_code=401, detail="X-Device-Id is required")
    try:
        devices = load_json_data("auth_devices")
    except Exception:
        fallback = fallback_auth_device(device_id)
        if fallback:
            return fallback
        raise
    device = next((item for item in devices if item.get("device_id") == device_id), None)
    if not device:
        fallback = fallback_auth_device(device_id)
        if fallback:
            return fallback
        raise HTTPException(status_code=401, detail="Device is not authenticated")
    member_id = device.get("member_id")
    if member_id is not None:
        members = load_json_data("members")
        member = next((value for value in members if value.get("id") == member_id), None)
        if member and member_access_expired(member):
            raise HTTPException(status_code=403, detail="Member access expired")
    return cast(dict[str, Any], device)


def _require_manager_device(
    device_id: str,
    manager_flag: str,
    required_message: str,
    *,
    resolver: Callable[[str], dict[str, Any]] = device_auth_record,
) -> dict[str, Any]:
    device = resolver(device_id)
    permission = str(device.get("permission") or "")
    if permission in {"管理者", "システム管理者"} or bool(device.get(manager_flag)):
        return device
    raise HTTPException(status_code=403, detail=required_message)


def require_recording_manager_device(device_id: str) -> dict[str, Any]:
    return _require_manager_device(
        device_id,
        "is_recording_manager",
        "Recording manager permission is required",
    )


def require_sheet_manager_device(device_id: str) -> dict[str, Any]:
    return _require_manager_device(
        device_id,
        "is_sheet_manager",
        "Sheet manager permission is required",
    )


def normalized_permission(member: dict[str, Any]) -> str:
    # role未設定データは既存互換として一般団員相当で扱う。
    permission = str(member.get("permission") or "").strip()
    if permission:
        return permission
    return "一般"


def issue_portal_session(member: dict[str, Any], remember_me: bool = False) -> dict[str, Any]:
    return {
        "member_id": member.get("id"),
        "remember_me": bool(remember_me),
    }
