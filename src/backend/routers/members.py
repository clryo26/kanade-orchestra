from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from fastapi.responses import Response

from ..core.auth_dependencies import get_admin_device_auth, get_device_auth
from ..models.schemas import Member, MemberSummary
from ..services import member_service
from ..services.extra_collection_helpers import read_json_body
from ..services.image_asset_service import serve_stored_image

router = APIRouter()


def _as_bool(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


async def _read_member_payload(request: Request) -> tuple[dict[str, Any], UploadFile | None]:
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        form = await request.form()
        photo_file = form.get("photo_file")
        payload = {
            "name": str(form.get("name") or "").strip(),
            "last_name": str(form.get("last_name") or "").strip(),
            "first_name": str(form.get("first_name") or "").strip(),
            "maiden_name": str(form.get("maiden_name") or "").strip(),
            "last_name_kana": str(form.get("last_name_kana") or "").strip(),
            "first_name_kana": str(form.get("first_name_kana") or "").strip(),
            "maiden_name_kana": str(form.get("maiden_name_kana") or "").strip(),
            "part": str(form.get("part") or "").strip(),
            "photo_url": str(form.get("photo_url") or "").strip(),
            "is_founder": _as_bool(form.get("is_founder")),
            "is_recording_manager": _as_bool(form.get("is_recording_manager")),
            "is_sheet_manager": _as_bool(form.get("is_sheet_manager")),
            "password": str(form.get("password") or "").strip(),
            "permission": str(form.get("permission") or "").strip() or "一般",
            "joined_at": str(form.get("joined_at") or "").strip(),
            "system_access_until": str(form.get("system_access_until") or "").strip(),
            "introducer": str(form.get("introducer") or "").strip(),
            "role": str(form.get("role") or "").strip(),
            "instrument_history": str(form.get("instrument_history") or "").strip(),
            "past_orchestras": str(form.get("past_orchestras") or "").strip(),
            "comment": str(form.get("comment") or "").strip(),
        }
        return payload, photo_file if photo_file and hasattr(photo_file, "read") else None
    return await read_json_body(request), None


async def _read_member_profile_payload(request: Request) -> tuple[dict[str, Any], UploadFile | None]:
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        form = await request.form()
        photo_file = form.get("photo_file")
        payload = {
            "photo_url": str(form.get("photo_url") or "").strip(),
            "joined_at": str(form.get("joined_at") or "").strip(),
            "introducer": str(form.get("introducer") or "").strip(),
            "role": str(form.get("role") or "").strip(),
            "instrument_history": str(form.get("instrument_history") or "").strip(),
            "past_orchestras": str(form.get("past_orchestras") or "").strip(),
            "comment": str(form.get("comment") or "").strip(),
        }
        return payload, photo_file if photo_file and hasattr(photo_file, "read") else None
    return await read_json_body(request), None


@router.get("/api/members", response_model=list[MemberSummary])
async def get_members() -> list[dict[str, Any]]:
    return member_service.list_members()


@router.get("/api/members/{member_id}", response_model=None)
async def get_member(
    member_id: int,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    return member_service.get_member(member_id, device)


@router.post("/api/members", response_model=Member)
async def create_member(
    request: Request,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, Any]:
    payload, photo_file = await _read_member_payload(request)
    return await member_service.create_member(payload, photo_file)


@router.put("/api/members/{member_id}", response_model=Member)
async def update_member(
    member_id: int,
    request: Request,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, Any]:
    payload, photo_file = await _read_member_payload(request)
    return await member_service.update_member(member_id, payload, photo_file)


@router.put("/api/members/{member_id}/profile", response_model=Member)
async def update_own_member_profile(
    member_id: int,
    request: Request,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    authenticated_member_id = device.get("member_id")
    if authenticated_member_id is None or str(authenticated_member_id) != str(member_id):
        raise HTTPException(status_code=403, detail="Only the authenticated member can update this profile")
    payload, photo_file = await _read_member_profile_payload(request)
    return await member_service.update_member_profile(member_id, payload, photo_file)


@router.get("/api/members/{member_id}/photo")
async def get_member_photo(member_id: int) -> Response:
    member = member_service.get_member_record(member_id)
    return serve_stored_image(
        member.get("photo_url") or "",
        object_prefix=f"member-images/{member_id}/photo",
    )


@router.post("/api/members/{member_id}/reset-password", response_model=Member)
async def reset_member_password(
    member_id: int,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, Any]:
    return member_service.reset_member_password(member_id)


@router.delete("/api/members/{member_id}")
async def delete_member(
    member_id: int,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, str]:
    member_service.delete_member(member_id)
    return {"message": "Deleted"}
