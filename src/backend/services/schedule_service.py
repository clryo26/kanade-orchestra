from __future__ import annotations

from typing import Any, cast

from ..repositories.schedule_repository import ScheduleRepository
from .notification_service import data_changed, emit

_repo = ScheduleRepository()


def list_schedules() -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], _repo.list_all())


def get_schedule(schedule_id: int) -> dict[str, Any]:
    _, item = _repo.find_by_id(schedule_id)
    return cast(dict[str, Any], item)


def create_schedule(payload: dict[str, Any]) -> dict[str, Any]:
    saved = cast(dict[str, Any], _repo.create(payload))
    emit('schedules', saved)
    return saved


def update_schedule(schedule_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    # Compare within the existing update operation, before it regenerates timestamps.
    changed = False
    def mutate(current):
        nonlocal changed
        updated = {**current, **payload}
        changed = data_changed(current, updated, 'schedules')
        return updated
    saved = cast(dict[str, Any], _repo.update(schedule_id, mutate))
    if changed:
        emit('schedules', saved, 'updated')
    return saved


def delete_schedule(schedule_id: int) -> None:
    _repo.delete(schedule_id)
