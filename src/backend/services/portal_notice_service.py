from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from ..repositories.portal_notice_repository import PortalNoticeRepository

_repo = PortalNoticeRepository()

_REGISTER_PERMISSIONS = {"一般", "管理者", "システム管理者"}
_ADMIN_PERMISSIONS = {"管理者", "システム管理者"}


def _created_at_sort_key(item: dict[str, Any]) -> tuple[str, int]:
    return (str(item.get("created_at") or ""), int(item.get("id") or 0))


def list_notices() -> list[dict[str, Any]]:
    return sorted(_repo.list_all(), key=_created_at_sort_key, reverse=True)


def get_notice(notice_id: int) -> dict[str, Any]:
    return _repo.find_by_id(notice_id)


def _permission(device: dict[str, Any]) -> str:
    return str(device.get("permission") or "").strip()


def _member_id(device: dict[str, Any]) -> int:
    value = str(device.get("member_id") or "").strip()
    if not value.isdigit():
        raise HTTPException(status_code=403, detail="お知らせ登録者の団員IDを確認できません")
    return int(value)


def _require_register_permission(device: dict[str, Any]) -> None:
    if _permission(device) not in _REGISTER_PERMISSIONS:
        raise HTTPException(status_code=403, detail="お知らせを登録する権限がありません")


def _can_modify(notice: dict[str, Any], device: dict[str, Any]) -> bool:
    if _permission(device) in _ADMIN_PERMISSIONS:
        return True
    creator_id = str(notice.get("created_by_member_id") or "").strip()
    member_id = str(device.get("member_id") or "").strip()
    return bool(creator_id and member_id and creator_id == member_id)


def create_notice(payload: dict[str, Any], device: dict[str, Any]) -> dict[str, Any]:
    _require_register_permission(device)
    normalized = {
        "date": str(payload.get("date") or "").strip(),
        "title": str(payload.get("title") or "").strip(),
        "content": str(payload.get("content") or "").strip(),
        "created_by_member_id": _member_id(device),
    }
    return _repo.create(normalized)


def update_notice(notice_id: int, payload: dict[str, Any], device: dict[str, Any]) -> dict[str, Any]:
    current = _repo.find_by_id(notice_id)
    if not _can_modify(current, device):
        raise HTTPException(status_code=403, detail="このお知らせを編集する権限がありません")
    normalized = {
        "date": str(payload.get("date") or "").strip(),
        "title": str(payload.get("title") or "").strip(),
        "content": str(payload.get("content") or "").strip(),
    }
    return _repo.update(notice_id, normalized)


def delete_notice(notice_id: int, device: dict[str, Any]) -> None:
    current = _repo.find_by_id(notice_id)
    if not _can_modify(current, device):
        raise HTTPException(status_code=403, detail="このお知らせを削除する権限がありません")
    _repo.delete(notice_id)
