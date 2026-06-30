from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header

from .. import app_core as core

router = APIRouter()


@router.get("/api/members", response_model=list[core.Member])
async def get_members() -> list[dict[str, Any]]:
    return core.public_member_list(core.load_json_data("members"))


@router.post("/api/members", response_model=core.Member)
async def create_member(
    member: core.Member,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("members")
    now = core.datetime.now().isoformat()
    payload = core.prepare_member_payload(member)
    payload.update({"id": core.next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    core.save_json_data("members", items)
    return core.public_member_payload(payload)


@router.put("/api/members/{member_id}", response_model=core.Member)
async def update_member(
    member_id: int,
    member: core.Member,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("members")
    index, current = core.find_item(items, member_id)
    payload = core.prepare_member_payload(member, current)
    payload.update(
        {
            "id": member_id,
            "created_at": current.get("created_at"),
            "updated_at": core.datetime.now().isoformat(),
        }
    )
    items[index] = payload
    core.save_json_data("members", items)
    return core.public_member_payload(payload)


@router.delete("/api/members/{member_id}")
async def delete_member(
    member_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("members")
    core.find_item(items, member_id)
    core.save_json_data("members", [item for item in items if item.get("id") != member_id])
    return {"message": "Deleted"}
