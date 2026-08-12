from __future__ import annotations

from datetime import date as date_value
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator

from ..core.auth_dependencies import get_device_auth
from ..services import portal_notice_service
from ..utils.serialization import model_dump

router = APIRouter()


class PortalNoticeInput(BaseModel):
    date: str
    title: str
    content: str

    @field_validator("date")
    @classmethod
    def validate_date(cls, value: str) -> str:
        normalized = str(value or "").strip()
        try:
            date_value.fromisoformat(normalized)
        except ValueError as exc:
            raise ValueError("日付を入力してください") from exc
        return normalized

    @field_validator("title", "content")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        normalized = str(value or "").strip()
        if not normalized:
            raise ValueError("必須項目を入力してください")
        return normalized


@router.get("/api/notices")
async def list_notices(
    _device: dict[str, Any] = Depends(get_device_auth),
) -> list[dict[str, Any]]:
    return portal_notice_service.list_notices()


@router.get("/api/notices/{notice_id}")
async def get_notice(
    notice_id: int,
    _device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    return portal_notice_service.get_notice(notice_id)


@router.post("/api/notices")
async def create_notice(
    notice: PortalNoticeInput,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    return portal_notice_service.create_notice(model_dump(notice), device)


@router.put("/api/notices/{notice_id}")
async def update_notice(
    notice_id: int,
    notice: PortalNoticeInput,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    return portal_notice_service.update_notice(notice_id, model_dump(notice), device)


@router.delete("/api/notices/{notice_id}")
async def delete_notice(
    notice_id: int,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, bool]:
    portal_notice_service.delete_notice(notice_id, device)
    return {"ok": True}
