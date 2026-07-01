from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header

from ..core import require_admin_device
from ..models.schemas import Member
from ..services.auth_service import device_auth_record
from ..services import member_service
from ..utils.serialization import model_dump

router = APIRouter()


def _require_admin(device_id: str) -> None:
    require_admin_device(device_id, device_auth_record)


@router.get("/api/members", response_model=list[Member])
async def get_members() -> list[dict[str, Any]]:
    return member_service.list_members()


@router.post("/api/members", response_model=Member)
async def create_member(
    member: Member,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    _require_admin(x_device_id)
    return member_service.create_member(model_dump(member))


@router.put("/api/members/{member_id}", response_model=Member)
async def update_member(
    member_id: int,
    member: Member,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    _require_admin(x_device_id)
    return member_service.update_member(member_id, model_dump(member))


@router.delete("/api/members/{member_id}")
async def delete_member(
    member_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    _require_admin(x_device_id)
    member_service.delete_member(member_id)
    return {"message": "Deleted"}
