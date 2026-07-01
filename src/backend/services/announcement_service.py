from __future__ import annotations

from typing import Any

from ..repositories.announcement_repository import AnnouncementRepository

_repo = AnnouncementRepository()


def list_announcements() -> list[dict[str, Any]]:
    return _repo.list_all()


def get_announcement(announcement_id: int) -> dict[str, Any]:
    _, item = _repo.find_by_id(announcement_id)
    return item


def create_announcement(payload: dict[str, Any]) -> dict[str, Any]:
    return _repo.create(payload)


def update_announcement(announcement_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return _repo.update(announcement_id, lambda current: {**current, **payload})


def delete_announcement(announcement_id: int) -> None:
    _repo.delete(announcement_id)
