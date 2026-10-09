from __future__ import annotations

from typing import Any, cast

from ..repositories.announcement_repository import AnnouncementRepository
from .notification_service import emit

_repo = AnnouncementRepository()


def list_announcements() -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], _repo.list_all())


def get_announcement(announcement_id: int) -> dict[str, Any]:
    _, item = _repo.find_by_id(announcement_id)
    return cast(dict[str, Any], item)


def create_announcement(payload: dict[str, Any]) -> dict[str, Any]:
    saved = cast(dict[str, Any], _repo.create(payload))
    emit('maintenance', saved)
    return saved


def update_announcement(announcement_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], _repo.update(announcement_id, lambda current: {**current, **payload}))


def delete_announcement(announcement_id: int) -> None:
    _repo.delete(announcement_id)
