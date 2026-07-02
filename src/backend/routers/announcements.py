from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..core.auth_dependencies import get_admin_device_auth
from ..models.schemas import Announcement
from ..services import announcement_service
from ..utils.serialization import model_dump

router = APIRouter()


@router.get("/api/announcements", response_model=list[Announcement])
async def get_announcements() -> list[dict[str, Any]]:
    return announcement_service.list_announcements()


@router.post("/api/announcements", response_model=Announcement)
async def create_announcement(
    announcement: Announcement,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, Any]:
    return announcement_service.create_announcement(model_dump(announcement))


@router.get("/api/announcements/{announcement_id}", response_model=Announcement)
async def get_announcement(announcement_id: int) -> dict[str, Any]:
    return announcement_service.get_announcement(announcement_id)


@router.put("/api/announcements/{announcement_id}", response_model=Announcement)
async def update_announcement(
    announcement_id: int,
    announcement: Announcement,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, Any]:
    return announcement_service.update_announcement(announcement_id, model_dump(announcement))


@router.delete("/api/announcements/{announcement_id}")
async def delete_announcement(
    announcement_id: int,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, str]:
    announcement_service.delete_announcement(announcement_id)
    return {"message": "Deleted"}
