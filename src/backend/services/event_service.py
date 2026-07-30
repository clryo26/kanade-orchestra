from __future__ import annotations

from typing import Any, cast

from fastapi import HTTPException

from ..repositories.event_repository import EventRepository

_repo = EventRepository()


def list_events() -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], _repo.list_all())


def get_event(event_id: int) -> dict[str, Any]:
    _, item = _repo.find_by_id(event_id)
    return cast(dict[str, Any], item)


def create_event(payload: dict[str, Any], device: dict[str, Any]) -> dict[str, Any]:
    member_id_text = str(device.get("member_id") or "").strip()
    if not member_id_text.isdigit():
        raise HTTPException(status_code=403, detail="Event creator member_id is required")
    normalized_payload = {
        **payload,
        "created_by_member_id": int(member_id_text),
    }
    return cast(dict[str, Any], _repo.create(normalized_payload))


def update_event(event_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], _repo.update(event_id, lambda current: {**current, **payload}))


def _is_event_creator(event: dict[str, Any], device: dict[str, Any]) -> bool:
    creator_member_id = str(event.get("created_by_member_id") or "").strip()
    device_member_id = str(device.get("member_id") or "").strip()
    return bool(creator_member_id and device_member_id and creator_member_id == device_member_id)


def delete_event(event_id: int, device: dict[str, Any]) -> None:
    _, event = _repo.find_by_id(event_id)
    if not _is_event_creator(event, device):
        raise HTTPException(status_code=403, detail="Only event creator can delete")
    _repo.delete(event_id)
