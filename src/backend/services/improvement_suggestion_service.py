from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import HTTPException

from ..core import db_connection_string
from ..core.tenant_context import get_current_tenant_id
from ..repositories.improvement_suggestion_repository import ImprovementSuggestionRepository

VALID_STATUSES = {"未対応", "修正中", "対応済"}


def _repository() -> ImprovementSuggestionRepository:
    return ImprovementSuggestionRepository(db_connection_string())


def _clean_suggestion(value: str) -> str:
    suggestion = str(value or "").strip()
    if not suggestion:
        raise HTTPException(status_code=400, detail="改善案を入力してください")
    return suggestion


def _clean_status(value: str) -> str:
    status = str(value or "").strip()
    if status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail="不正なステータスです")
    return status


def _member_id(device: dict[str, Any]) -> int | None:
    raw = device.get("member_id")
    try:
        return int(raw) if raw not in (None, "") else None
    except (TypeError, ValueError):
        return None


def list_suggestions() -> list[dict[str, Any]]:
    return _repository().list_all(get_current_tenant_id())


def create_member_suggestion(suggestion: str, device: dict[str, Any]) -> dict[str, Any]:
    return _repository().create(
        organization_id=get_current_tenant_id(),
        member_id=_member_id(device),
        registered_by=str(device.get("member_name") or ""),
        suggestion=_clean_suggestion(suggestion),
        status="未対応",
        resolution="",
        responded_at=None,
    )


def create_admin_suggestion(
    suggestion: str,
    status: str,
    resolution: str,
    responded_at: date | None,
    device: dict[str, Any],
) -> dict[str, Any]:
    return _repository().create(
        organization_id=get_current_tenant_id(),
        member_id=_member_id(device),
        registered_by=str(device.get("member_name") or ""),
        suggestion=_clean_suggestion(suggestion),
        status=_clean_status(status),
        resolution=str(resolution or "").strip(),
        responded_at=responded_at,
    )


def update_admin_suggestion(
    item_id: int,
    suggestion: str,
    status: str,
    resolution: str,
    responded_at: date | None,
) -> dict[str, Any]:
    updated = _repository().update(
        organization_id=get_current_tenant_id(),
        item_id=item_id,
        suggestion=_clean_suggestion(suggestion),
        status=_clean_status(status),
        resolution=str(resolution or "").strip(),
        responded_at=responded_at,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="改善案が見つかりません")
    return updated


def delete_admin_suggestion(item_id: int) -> None:
    if not _repository().delete(organization_id=get_current_tenant_id(), item_id=item_id):
        raise HTTPException(status_code=404, detail="改善案が見つかりません")
