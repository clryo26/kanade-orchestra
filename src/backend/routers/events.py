from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header

from ..core import require_admin_device
from ..models.schemas import EventAdjustment
from ..services.auth_service import device_auth_record
from ..services import event_service
from ..utils.serialization import model_dump

router = APIRouter()


def _require_admin(device_id: str) -> None:
    require_admin_device(device_id, device_auth_record)


@router.get("/api/events", response_model=list[EventAdjustment])
async def get_events() -> list[dict[str, Any]]:
    return event_service.list_events()


@router.post("/api/events", response_model=EventAdjustment)
async def create_event(
    event: EventAdjustment,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    _require_admin(x_device_id)
    return event_service.create_event(model_dump(event))


@router.put("/api/events/{event_id}", response_model=EventAdjustment)
async def update_event(
    event_id: int,
    event: EventAdjustment,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    _require_admin(x_device_id)
    return event_service.update_event(event_id, model_dump(event))


@router.delete("/api/events/{event_id}")
async def delete_event(
    event_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    _require_admin(x_device_id)
    event_service.delete_event(event_id)
    return {"message": "Deleted"}
