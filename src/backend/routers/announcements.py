from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header

from ..core import require_admin_device
from ..models.schemas import Announcement
from ..services.auth_service import device_auth_record
from ..services import announcement_service
from ..utils.serialization import model_dump

router = APIRouter()


def _require_admin(device_id: str) -> None:
    require_admin_device(device_id, device_auth_record)


@router.get("/api/announcements", response_model=list[Announcement])
async def get_announcements() -> list[dict[str, Any]]:
    return announcement_service.list_announcements()


@router.post("/api/announcements", response_model=Announcement)
async def create_announcement(
    announcement: Announcement,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    _require_admin(x_device_id)
    return announcement_service.create_announcement(model_dump(announcement))


@router.get("/api/announcements/{announcement_id}", response_model=Announcement)
async def get_announcement(announcement_id: int) -> dict[str, Any]:
    return announcement_service.get_announcement(announcement_id)


@router.put("/api/announcements/{announcement_id}", response_model=Announcement)
async def update_announcement(
    announcement_id: int,
    announcement: Announcement,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    _require_admin(x_device_id)
    return announcement_service.update_announcement(announcement_id, model_dump(announcement))


@router.delete("/api/announcements/{announcement_id}")
async def delete_announcement(
    announcement_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    _require_admin(x_device_id)
    announcement_service.delete_announcement(announcement_id)
    return {"message": "Deleted"}
