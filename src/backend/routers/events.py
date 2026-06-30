from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header

from .. import app_core as core

router = APIRouter()


@router.get("/api/events", response_model=list[core.EventAdjustment])
async def get_events() -> list[dict[str, Any]]:
    return core.load_json_data("events")


@router.post("/api/events", response_model=core.EventAdjustment)
async def create_event(
    event: core.EventAdjustment,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("events")
    now = core.datetime.now().isoformat()
    payload = core.model_dump(event)
    payload.update({"id": core.next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    core.save_json_data("events", items)
    return payload


@router.put("/api/events/{event_id}", response_model=core.EventAdjustment)
async def update_event(
    event_id: int,
    event: core.EventAdjustment,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("events")
    index, current = core.find_item(items, event_id)
    payload = core.model_dump(event)
    payload.update(
        {
            "id": event_id,
            "created_at": current.get("created_at"),
            "updated_at": core.datetime.now().isoformat(),
        }
    )
    items[index] = payload
    core.save_json_data("events", items)
    return payload


@router.delete("/api/events/{event_id}")
async def delete_event(
    event_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("events")
    core.find_item(items, event_id)
    core.save_json_data("events", [item for item in items if item.get("id") != event_id])
    return {"message": "Deleted"}
