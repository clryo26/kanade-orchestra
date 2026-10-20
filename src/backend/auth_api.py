from __future__ import annotations

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
from .utils.datetime_utils import format_instant, instant_sort_key, jst_now

router = APIRouter(prefix="/api/auth")


class AuthPersistenceGateway(Protocol):
    def db_data_enabled(self) -> bool: ...

    def db_load_json_data(self, name: str) -> list[dict[str, Any]]: ...

    def db_load_auth_device(self, device_id: str) -> dict[str, Any] | None: ...

    def db_load_member(self, member_id: Any) -> dict[str, Any] | None: ...

    def db_replace_collection(self, name: str, data: list[dict[str, Any]]) -> None: ...

    def db_upsert_auth_device(self, device: dict[str, Any]) -> dict[str, Any]: ...

    def db_record_login(self, device: dict[str, Any]) -> dict[str, Any]: ...

    def db_touch_auth_device(self, device_id: str, member_id: Any, member_fields: dict[str, Any]) -> dict[str, Any] | None: ...

    def row_store(self) -> Any: ...

    def db_delete_auth_device(self, device_id: str) -> None: ...

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


def save_auth_device(device: dict[str, Any], *, login: bool = False) -> dict[str, Any]:
    api = persistence_api()
    if api.db_data_enabled():
        if login:
            # authenticated_at/last_seen_at are taken from the DB clock.
            return api.db_record_login(device)
        return api.db_upsert_auth_device(device)

    devices = api.load_json_data("auth_devices")
    device_id = str(device.get("device_id") or "").strip()
    existing = next((item for item in devices if item.get("device_id") == device_id), None)
    payload = dict(device)
    if existing:
        existing.update(payload)
        saved = existing
    else:
        payload["id"] = api.next_id(devices)
        devices.append(payload)
        saved = payload
    api.save_json_data("auth_devices", devices)
    return saved


def delete_auth_device_record(device_id: str) -> None:
    api = persistence_api()
    if api.db_data_enabled():
        api.db_delete_auth_device(device_id)
        return

    devices = api.load_json_data("auth_devices")
    api.save_json_data("auth_devices", [item for item in devices if item.get("device_id") != device_id])


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
            # Row-level and conditional (JST spec R05/R08, N04): only this
            # member's password column, and only while it still holds the
            # value that was verified. Other members' rows are never rewritten.
            persistence_api().row_store().update_columns(
                "members",
                member.get("id"),
                {"password": hash_password(login.password)},
                where={"password": member_password},
            )

    device_id = login.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required")

    # Aware app time for the fallback path; the DB row is stamped from the DB clock.
    now = format_instant(jst_now())
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
    used_fallback_session = False
    try:
        payload = save_auth_device(payload, login=True)
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
    _, member = find_member_by_login_name(members, payload.name, payload.part)
    if member.get("password"):
        raise HTTPException(status_code=409, detail="Member password is already set")
    # Conditional row update: a password set concurrently is not overwritten.
    saved = persistence_api().row_store().update_columns(
        "members",
        member.get("id"),
        {"password": hash_password(password)},
        where={"password": member.get("password")},
    )
    if saved is None:
        raise HTTPException(status_code=409, detail="Member password is already set")
    return {"password_registered": True, "member_id": member.get("id")}


@router.get("/devices/{device_id}")
async def get_auth_device(device_id: str) -> dict[str, Any]:
    try:
        api = persistence_api()
        db_mode = api.db_data_enabled()
        if db_mode:
            item = api.db_load_auth_device(device_id)
        else:
            devices = load_collection("auth_devices")
    except Exception:
        fallback = fallback_auth_device(device_id)
        if fallback:
            return {"authenticated": True, "device": fallback}
        raise
    if not db_mode:
        item = next((device for device in devices if device.get("device_id") == device_id), None)
    if not item:
        fallback = fallback_auth_device(device_id)
        if fallback:
            return {"authenticated": True, "device": fallback}
        return {"authenticated": False}

    member_id = item.get("member_id")
    if member_id is not None:
        if api.db_data_enabled():
            member = api.db_load_member(member_id)
        else:
            members = load_collection("members")
            member = next((value for value in members if value.get("id") == member_id), None)
        if member and member_access_expired(member):
            delete_auth_device_record(device_id)
            return {"authenticated": False}
        if member:
            # Keep the browser session payload aligned with members, the
            # authorization source of truth for linked member accounts.
            item = {
                **item,
                "member_name": member_display_name(member),
                "member_part": member_part(member),
                "permission": normalized_permission(member),
                "system_access_until": member.get("system_access_until") or "",
                "is_recording_manager": bool(member.get("is_recording_manager")),
                "is_sheet_manager": bool(member.get("is_sheet_manager")),
            }

    api = persistence_api()
    if api.db_data_enabled():
        try:
            touched = api.db_touch_auth_device(device_id, item.get("member_id"), item)
        except Exception:
            remember_auth_device({**item, "last_seen_at": format_instant(jst_now())})
            return {"authenticated": True, "device": item}
        if touched is None:
            # A newer login or a logout changed this device meanwhile. Never
            # write this older snapshot back; answer from the current row.
            current = api.db_load_auth_device(device_id)
            if not current:
                return {"authenticated": False}
            return {"authenticated": True, "device": current}
        return {"authenticated": True, "device": {**touched, **{k: item[k] for k in ("member_name", "member_part", "permission", "system_access_until", "is_recording_manager", "is_sheet_manager") if k in item}}}

    item["last_seen_at"] = format_instant(jst_now())
    try:
        save_auth_device(item)
    except Exception:
        remember_auth_device(item)
    return {"authenticated": True, "device": item}


@router.get("/devices")
async def get_auth_devices() -> list[dict[str, Any]]:
    persisted = load_collection("auth_devices")
    merged: dict[str, dict[str, Any]] = {
        str(item.get("device_id") or ""): dict(item)
        for item in persisted
        if str(item.get("device_id") or "").strip()
    }
    for fallback in list_fallback_auth_devices():
        key = str(fallback.get("device_id") or "").strip()
        if key:
            merged[key] = fallback
    # Instants are ordered as instants (mixed notations sort wrong as text).
    return sorted(
        merged.values(),
        key=lambda item: instant_sort_key(item.get("authenticated_at") or item.get("last_seen_at")),
        reverse=True,
    )


@router.delete("/devices/{device_id}")
async def delete_auth_device(device_id: str, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    persistence_api().require_admin_device(x_device_id)
    forget_auth_device(device_id)
    delete_auth_device_record(device_id)
    return {"message": "Deleted"}
