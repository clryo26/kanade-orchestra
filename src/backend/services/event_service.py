from __future__ import annotations

from typing import Any, cast

from fastapi import HTTPException

from ..repositories.event_repository import EventRepository
from ..utils.datetime_utils import require_input_dates
from .notification_service import emit

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
    require_input_dates(payload, ("date", "deadline"))
    normalized_payload = {
        **payload,
        "created_by_member_id": int(member_id_text),
    }
    saved = cast(dict[str, Any], _repo.create(normalized_payload))
    emit('events', saved)
    return saved


def update_event(event_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    require_input_dates(payload, ("date", "deadline"))

    def mutate(current: dict[str, Any]) -> dict[str, Any]:
        updated = {**current, **payload}
        # A stored deadline that is not a UTC-midnight date is reported as ""
        # (unknown, never guessed). An edit screen cannot show it, so an empty
        # value in the request must not erase it silently (JST spec R04/R10).
        if not str(payload.get("deadline") or "") and current.get("deadline_raw"):
            updated["deadline"] = current["deadline_raw"]
        return updated

    return cast(dict[str, Any], _repo.update(event_id, mutate))


def _is_event_creator(event: dict[str, Any], device: dict[str, Any]) -> bool:
    creator_member_id = str(event.get("created_by_member_id") or "").strip()
    device_member_id = str(device.get("member_id") or "").strip()
    return bool(creator_member_id and device_member_id and creator_member_id == device_member_id)


def delete_event(event_id: int, device: dict[str, Any]) -> None:
    def authorize(event: dict[str, Any]) -> None:
        # Checked on the locked current row inside the delete transaction.
        if not _is_event_creator(event, device):
            raise HTTPException(status_code=403, detail="Only event creator can delete")

    _repo.delete(event_id, authorize)
