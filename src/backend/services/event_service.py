from __future__ import annotations

from typing import Any, cast

from ..repositories.event_repository import EventRepository

_repo = EventRepository()


def list_events() -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], _repo.list_all())


def get_event(event_id: int) -> dict[str, Any]:
    _, item = _repo.find_by_id(event_id)
    return cast(dict[str, Any], item)


def create_event(payload: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], _repo.create(payload))


def update_event(event_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], _repo.update(event_id, lambda current: {**current, **payload}))


def delete_event(event_id: int) -> None:
    _repo.delete(event_id)
