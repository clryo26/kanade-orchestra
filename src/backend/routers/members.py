from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..core.auth_dependencies import get_admin_device_auth, get_device_auth
from ..models.schemas import Member, MemberProfileUpdate
from ..services import member_service
from ..utils.serialization import model_dump

router = APIRouter()


@router.get("/api/members", response_model=list[Member])
async def get_members() -> list[dict[str, Any]]:
    return member_service.list_members()


@router.post("/api/members", response_model=Member)
async def create_member(
    member: Member,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, Any]:
    return member_service.create_member(model_dump(member))


@router.put("/api/members/{member_id}", response_model=Member)
async def update_member(
    member_id: int,
    member: Member,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, Any]:
    return member_service.update_member(member_id, model_dump(member))


@router.put("/api/members/{member_id}/profile", response_model=Member)
async def update_own_member_profile(
    member_id: int,
    profile: MemberProfileUpdate,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    authenticated_member_id = device.get("member_id")
    if authenticated_member_id is None or str(authenticated_member_id) != str(member_id):
        raise HTTPException(status_code=403, detail="Only the authenticated member can update this profile")
    return member_service.update_member_profile(member_id, profile.model_dump(exclude_unset=True))


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
