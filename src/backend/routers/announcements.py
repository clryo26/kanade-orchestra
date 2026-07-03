from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header

from .. import app_core as core

router = APIRouter()


@router.get("/api/announcements", response_model=list[core.Announcement])
async def get_announcements() -> list[dict[str, Any]]:
    return core.load_json_data("announcements")


@router.post("/api/announcements", response_model=core.Announcement)
async def create_announcement(
    announcement: core.Announcement,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("announcements")
    now = core.datetime.now().isoformat()
    payload = core.model_dump(announcement)
    payload.update({"id": core.next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    core.save_json_data("announcements", items)
    return payload


@router.get("/api/announcements/{announcement_id}", response_model=core.Announcement)
async def get_announcement(announcement_id: int) -> dict[str, Any]:
    _, item = core.find_item(core.load_json_data("announcements"), announcement_id)
    return item


@router.put("/api/announcements/{announcement_id}", response_model=core.Announcement)
async def update_announcement(
    announcement_id: int,
    announcement: core.Announcement,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("announcements")
    index, current = core.find_item(items, announcement_id)
    payload = core.model_dump(announcement)
    payload.update(
        {
            "id": announcement_id,
            "created_at": current.get("created_at"),
            "updated_at": core.datetime.now().isoformat(),
        }
    )
    items[index] = payload
    core.save_json_data("announcements", items)
    return payload


@router.delete("/api/announcements/{announcement_id}")
async def delete_announcement(
    announcement_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("announcements")
    core.find_item(items, announcement_id)
    core.save_json_data(
        "announcements",
        [item for item in items if item.get("id") != announcement_id],
    )
    return {"message": "Deleted"}
