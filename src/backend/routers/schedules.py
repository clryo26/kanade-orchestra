from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header

from .. import app_core as core

router = APIRouter()


@router.get("/api/schedules", response_model=list[core.Schedule])
async def get_schedules() -> list[dict[str, Any]]:
    return core.load_json_data("schedules")


@router.post("/api/schedules", response_model=core.Schedule)
async def create_schedule(
    schedule: core.Schedule,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("schedules")
    now = core.datetime.now().isoformat()
    payload = core.model_dump(schedule)
    payload.update({"id": core.next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    core.save_json_data("schedules", items)
    return payload


@router.get("/api/schedules/{schedule_id}", response_model=core.Schedule)
async def get_schedule(schedule_id: int) -> dict[str, Any]:
    _, item = core.find_item(core.load_json_data("schedules"), schedule_id)
    return item


@router.put("/api/schedules/{schedule_id}", response_model=core.Schedule)
async def update_schedule(
    schedule_id: int,
    schedule: core.Schedule,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("schedules")
    index, current = core.find_item(items, schedule_id)
    payload = core.model_dump(schedule)
    payload.update(
        {
            "id": schedule_id,
            "created_at": current.get("created_at"),
            "updated_at": core.datetime.now().isoformat(),
        }
    )
    items[index] = payload
    core.save_json_data("schedules", items)
    return payload


@router.delete("/api/schedules/{schedule_id}")
async def delete_schedule(
    schedule_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("schedules")
    core.find_item(items, schedule_id)
    core.save_json_data("schedules", [item for item in items if item.get("id") != schedule_id])
    return {"message": "Deleted"}
