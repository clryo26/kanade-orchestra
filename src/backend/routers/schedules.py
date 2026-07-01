from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header

from ..core import require_admin_device
from ..models.schemas import Schedule
from ..services.auth_service import device_auth_record
from ..services import schedule_service
from ..utils.serialization import model_dump

router = APIRouter()


def _require_admin(device_id: str) -> None:
    require_admin_device(device_id, device_auth_record)


@router.get("/api/schedules", response_model=list[Schedule])
async def get_schedules() -> list[dict[str, Any]]:
    return schedule_service.list_schedules()


@router.post("/api/schedules", response_model=Schedule)
async def create_schedule(
    schedule: Schedule,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    _require_admin(x_device_id)
    return schedule_service.create_schedule(model_dump(schedule))


@router.get("/api/schedules/{schedule_id}", response_model=Schedule)
async def get_schedule(schedule_id: int) -> dict[str, Any]:
    return schedule_service.get_schedule(schedule_id)


@router.put("/api/schedules/{schedule_id}", response_model=Schedule)
async def update_schedule(
    schedule_id: int,
    schedule: Schedule,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    _require_admin(x_device_id)
    return schedule_service.update_schedule(schedule_id, model_dump(schedule))


@router.delete("/api/schedules/{schedule_id}")
async def delete_schedule(
    schedule_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    _require_admin(x_device_id)
    schedule_service.delete_schedule(schedule_id)
    return {"message": "Deleted"}
