from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..core.auth_dependencies import get_admin_device_auth
from ..models.schemas import Member
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


@router.delete("/api/members/{member_id}")
async def delete_member(
    member_id: int,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, str]:
    member_service.delete_member(member_id)
    return {"message": "Deleted"}
