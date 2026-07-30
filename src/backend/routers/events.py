from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..core.auth_dependencies import get_admin_device_auth, get_device_auth
from ..models.schemas import EventAdjustment
from ..services import event_service
from ..utils.serialization import model_dump

router = APIRouter()


@router.get("/api/events", response_model=list[EventAdjustment])
async def get_events() -> list[dict[str, Any]]:
    return event_service.list_events()


@router.post("/api/events", response_model=EventAdjustment)
async def create_event(
    event: EventAdjustment,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    return event_service.create_event(model_dump(event), device)


@router.put("/api/events/{event_id}", response_model=EventAdjustment)
async def update_event(
    event_id: int,
    event: EventAdjustment,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> dict[str, Any]:
    return event_service.update_event(event_id, model_dump(event))


@router.delete("/api/events/{event_id}")
async def delete_event(
    event_id: int,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, str]:
    event_service.delete_event(event_id, device)
    return {"message": "Deleted"}
