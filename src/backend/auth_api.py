from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol, cast

from fastapi import APIRouter, Header, HTTPException, Request

from .auth_helpers import (
    find_member_by_login_name,
    is_hidden_system_admin_login,
    member_access_expired,
    member_display_name,
    member_part,
)
from .models.schemas import MemberPasswordSetupRequest, PortalLoginRequest
from .services.auth_session_fallback import fallback_auth_device, forget_auth_device, remember_auth_device
from .services.auth_session_fallback import list_fallback_auth_devices
from .services.auth_service import normalized_permission
from .services.security_service import hash_password, is_hashed_password, is_password_placeholder, verify_password

router = APIRouter(prefix="/api/auth")


class AuthPersistenceGateway(Protocol):
    def db_data_enabled(self) -> bool: ...

    def db_load_json_data(self, name: str) -> list[dict[str, Any]]: ...

    def db_replace_collection(self, name: str, data: list[dict[str, Any]]) -> None: ...

    def load_json_data(self, name: str) -> list[dict[str, Any]]: ...

    def save_json_data(self, name: str, data: list[dict[str, Any]]) -> None: ...

    def next_id(self, items: list[dict[str, Any]]) -> int: ...

    async def list_auth_devices(self) -> list[dict[str, Any]]: ...

    def require_admin_device(self, device_id: str) -> dict[str, Any]: ...


def backend_api() -> AuthPersistenceGateway:
    # main is the public compatibility surface; tests and scripts patch it.
    from . import main

    return cast(AuthPersistenceGateway, main)


def persistence_api() -> AuthPersistenceGateway:
    # Keep patchability via main module for tests while isolating pure helpers in core_api.
    return backend_api()


def load_collection(name: str) -> list[dict[str, Any]]:
    api = persistence_api()
    if api.db_data_enabled():
        return api.db_load_json_data(name)
    return api.load_json_data(name)


def save_collection(name: str, data: list[dict[str, Any]]) -> None:
    api = persistence_api()
    # Route writes through the compatibility save layer so auth_devices cache is
    # refreshed immediately after login. Direct DB writes leave later device
    # checks reading a stale empty cache.
    api.save_json_data(name, data)


@router.post("/portal-login")
async def portal_login(login: PortalLoginRequest, request: Request) -> dict[str, Any]:
    if is_hidden_system_admin_login(login):
        member = {
            "id": None,
            "name": "Administrator",
            "part": "System",
            "permission": "システム管理者",
            "is_recording_manager": True,
            "is_sheet_manager": True,
            "hidden_user": True,
        }
    else:
        members = load_collection("members")
        _, member = find_member_by_login_name(members, login.name, login.part)
        if member_access_expired(member):
            raise HTTPException(status_code=403, detail="システム利用期限が終了しています")
        member_password = str(member.get("password") or "")
        if is_password_placeholder(member_password):
            return {
                "authenticated": False,
                "needs_password_setup": True,
                "member_id": member.get("id"),
            }
        if not verify_password(login.password, member_password):
            raise HTTPException(status_code=401, detail="Invalid member password")
        if not is_hashed_password(member_password):
            members = load_collection("members")
            for m in members:
                if m.get("id") == member.get("id"):
                    m["password"] = hash_password(login.password)
                    m["updated_at"] = datetime.now().isoformat()
                    break
            save_collection("members", members)

    device_id = login.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required")

    devices = load_collection("auth_devices")
    now = datetime.now().isoformat()
    existing = next((item for item in devices if item.get("device_id") == device_id), None)
    payload = {
        "device_id": device_id,
        "device_name": login.device_name or "Unknown device",
        "member_id": member.get("id"),
        "member_name": member_display_name(member),
        "member_part": member_part(member),
        "permission": normalized_permission(member),
        "system_access_until": member.get("system_access_until") or "",
        "is_recording_manager": bool(member.get("is_recording_manager")),
        "is_sheet_manager": bool(member.get("is_sheet_manager")),
        "hidden_user": bool(member.get("hidden_user")),
        "user_agent": login.user_agent or request.headers.get("user-agent", ""),
        "authenticated_at": now,
        "last_seen_at": now,
    }
    if existing:
        existing.update(payload)
    else:
        payload["id"] = persistence_api().next_id(devices)
        devices.append(payload)
    used_fallback_session = False
    try:
        save_collection("auth_devices", devices)
    except Exception:
        remember_auth_device(payload)
        used_fallback_session = True
    return {
        "authenticated": True,
        "device_id": device_id,
        "member_id": payload["member_id"],
        "member_name": payload["member_name"],
        "member_part": payload["member_part"],
        "permission": payload["permission"],
        "system_access_until": payload["system_access_until"],
        "is_recording_manager": payload["is_recording_manager"],
        "is_sheet_manager": payload["is_sheet_manager"],
        "hidden_user": payload["hidden_user"],
        "auth_device_fallback": used_fallback_session,
    }


@router.post("/member-password")
async def set_member_password(payload: MemberPasswordSetupRequest) -> dict[str, Any]:
    password = payload.password.strip()
    if not password:
        raise HTTPException(status_code=400, detail="password is required")
    members = load_collection("members")
    index, member = find_member_by_login_name(members, payload.name, payload.part)
    if member.get("password"):
        raise HTTPException(status_code=409, detail="Member password is already set")
    member["password"] = hash_password(password)
    member["updated_at"] = datetime.now().isoformat()
    members[index] = member
    save_collection("members", members)
    return {"password_registered": True, "member_id": member.get("id")}


@router.get("/devices/{device_id}")
async def get_auth_device(device_id: str) -> dict[str, Any]:
    try:
        devices = load_collection("auth_devices")
    except Exception:
        fallback = fallback_auth_device(device_id)
        if fallback:
            return {"authenticated": True, "device": fallback}
        raise
    item = next((device for device in devices if device.get("device_id") == device_id), None)
    if not item:
        fallback = fallback_auth_device(device_id)
        if fallback:
            return {"authenticated": True, "device": fallback}
        return {"authenticated": False}

    member_id = item.get("member_id")
    if member_id is not None:
        members = load_collection("members")
        member = next((value for value in members if value.get("id") == member_id), None)
        if member and member_access_expired(member):
            save_collection("auth_devices", [device for device in devices if device.get("device_id") != device_id])
            return {"authenticated": False}

    item["last_seen_at"] = datetime.now().isoformat()
    try:
        save_collection("auth_devices", devices)
    except Exception:
        remember_auth_device(item)
    return {"authenticated": True, "device": item}


@router.get("/devices")
async def get_auth_devices() -> list[dict[str, Any]]:
    persisted = await persistence_api().list_auth_devices()
    merged: dict[str, dict[str, Any]] = {
        str(item.get("device_id") or ""): dict(item)
        for item in persisted
        if str(item.get("device_id") or "").strip()
    }
    for fallback in list_fallback_auth_devices():
        key = str(fallback.get("device_id") or "").strip()
        if key:
            merged[key] = fallback
    return sorted(
        merged.values(),
        key=lambda item: str(item.get("authenticated_at") or item.get("last_seen_at") or ""),
        reverse=True,
    )


@router.delete("/devices/{device_id}")
async def delete_auth_device(device_id: str, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    persistence_api().require_admin_device(x_device_id)
    devices = load_collection("auth_devices")
    forget_auth_device(device_id)
    save_collection("auth_devices", [item for item in devices if item.get("device_id") != device_id])
    return {"message": "Deleted"}
