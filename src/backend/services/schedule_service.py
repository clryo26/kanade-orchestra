from __future__ import annotations

from typing import Any, cast

from ..repositories.schedule_repository import ScheduleRepository

_repo = ScheduleRepository()


def list_schedules() -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], _repo.list_all())


def get_schedule(schedule_id: int) -> dict[str, Any]:
    _, item = _repo.find_by_id(schedule_id)
    return cast(dict[str, Any], item)


def create_schedule(payload: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], _repo.create(payload))


def update_schedule(schedule_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], _repo.update(schedule_id, lambda current: {**current, **payload}))


def delete_schedule(schedule_id: int) -> None:
    _repo.delete(schedule_id)
