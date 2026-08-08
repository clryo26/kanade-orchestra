from __future__ import annotations

from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator

from ..core.auth_dependencies import get_device_auth, get_system_admin_device_auth
from ..services import improvement_suggestion_service

router = APIRouter()


class MemberSuggestionCreate(BaseModel):
    suggestion: str

    @field_validator("suggestion")
    @classmethod
    def validate_suggestion(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("改善案を入力してください")
        return value


class AdminSuggestionUpsert(BaseModel):
    suggestion: str
    status: Literal["未対応", "修正中", "対応済"] = "未対応"
    resolution: str = ""
    responded_at: date | None = None

    @field_validator("suggestion")
    @classmethod
    def validate_suggestion(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("改善案を入力してください")
        return value


@router.get("/api/improvement-suggestions")
async def list_improvement_suggestions(
    _device: dict[str, Any] = Depends(get_device_auth),
) -> list[dict[str, Any]]:
    return improvement_suggestion_service.list_suggestions()


@router.post("/api/improvement-suggestions")
async def create_improvement_suggestion(
    body: MemberSuggestionCreate,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    return improvement_suggestion_service.create_member_suggestion(body.suggestion, device)


@router.post("/api/system/improvement-suggestions")
async def create_system_improvement_suggestion(
    body: AdminSuggestionUpsert,
    device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, Any]:
    return improvement_suggestion_service.create_admin_suggestion(
        body.suggestion,
        body.status,
        body.resolution,
        body.responded_at,
        device,
    )


@router.put("/api/system/improvement-suggestions/{item_id}")
async def update_system_improvement_suggestion(
    item_id: int,
    body: AdminSuggestionUpsert,
    _device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, Any]:
    return improvement_suggestion_service.update_admin_suggestion(
        item_id,
        body.suggestion,
        body.status,
        body.resolution,
        body.responded_at,
    )


@router.delete("/api/system/improvement-suggestions/{item_id}")
async def delete_system_improvement_suggestion(
    item_id: int,
    _device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, str]:
    improvement_suggestion_service.delete_admin_suggestion(item_id)
    return {"message": "Deleted"}
