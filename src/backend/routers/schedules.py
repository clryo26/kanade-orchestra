from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..core.auth_dependencies import get_admin_device_auth
from ..models.schemas import Schedule
from ..services import schedule_service
from ..utils.serialization import model_dump

router = APIRouter()


@router.get("/api/schedules", response_model=list[Schedule])
async def get_schedules() -> list[dict[str, Any]]:
    return schedule_service.list_schedules()


@router.post("/api/schedules", response_model=Schedule)
async def create_schedule(
    schedule: Schedule,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, Any]:
    return schedule_service.create_schedule(model_dump(schedule))


@router.get("/api/schedules/{schedule_id}", response_model=Schedule)
async def get_schedule(schedule_id: int) -> dict[str, Any]:
    return schedule_service.get_schedule(schedule_id)


@router.put("/api/schedules/{schedule_id}", response_model=Schedule)
async def update_schedule(
    schedule_id: int,
    schedule: Schedule,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, Any]:
    return schedule_service.update_schedule(schedule_id, model_dump(schedule))


@router.delete("/api/schedules/{schedule_id}")
async def delete_schedule(
    schedule_id: int,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, str]:
    schedule_service.delete_schedule(schedule_id)
    return {"message": "Deleted"}
