from __future__ import annotations

from pathlib import Path
from typing import Any
import os

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, StrictBool

from ..core.auth_dependencies import get_device_auth
from ..repositories.notification_repository import NotificationRepository
from ..services import notification_service as service
from ..services.notification_types import NOTIFICATION_TYPES


def no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(dependencies=[Depends(no_store)])
_repo = NotificationRepository()


class PreferencesInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preferences: dict[str, StrictBool]


class SubscriptionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: str
    keys: dict[str, str]
    permission: str
    expirationTime: float | None = None


@router.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(
        Path(__file__).resolve().parents[2] / "static" / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-store", "Service-Worker-Allowed": "/"},
    )


@router.get("/api/notifications/settings")
def settings(device: dict[str, Any] = Depends(get_device_auth)):
    org, member_id, device_id = service.member_identity(device)
    preferences = _repo.preferences(org, member_id)
    categories = dict(NOTIFICATION_TYPES)
    if device.get("permission") != "システム管理者":
        categories.pop("improvements")
    service.schedule_retry_scan()
    return {
        "preferences": {key: preferences[key] for key in categories},
        "categories": {key: value[0] for key, value in categories.items()},
        "configured": service.configured(),
        "public_key": os.getenv("VAPID_PUBLIC_KEY", "") if service.configured() else "",
        "subscribed": _repo.subscribed(org, member_id, device_id),
    }


@router.put("/api/notifications/settings")
def save_settings(body: PreferencesInput, device: dict[str, Any] = Depends(get_device_auth)):
    org, member_id, _ = service.member_identity(device)
    if set(body.preferences) - set(NOTIFICATION_TYPES):
        raise HTTPException(422, "通知種別が不正です")
    if "improvements" in body.preferences and device.get("permission") != "システム管理者":
        raise HTTPException(403, "システム管理者権限が必要です")
    _repo.preferences(org, member_id)
    result = _repo.save_preferences(org, member_id, body.preferences)
    if device.get("permission") != "システム管理者":
        result = {key: value for key, value in result.items() if key != "improvements"}
    return {"preferences": result}


@router.post("/api/notifications/subscriptions")
def subscribe(body: SubscriptionInput, device: dict[str, Any] = Depends(get_device_auth)):
    org, member_id, device_id = service.member_identity(device)
    if not service.configured():
        raise HTTPException(503, "プッシュ通知はまだ有効化されていません")
    if body.permission != "granted":
        raise HTTPException(403, "端末で通知を許可してください")
    subscription = {"endpoint": body.endpoint, "keys": body.keys}
    service.validate_subscription(subscription)
    _repo.preferences(org, member_id)
    return {"id": _repo.subscribe(org, member_id, device_id, subscription)}


@router.delete("/api/notifications/subscriptions")
def unsubscribe(device: dict[str, Any] = Depends(get_device_auth)):
    org, member_id, device_id = service.member_identity(device)
    _repo.unsubscribe(org, member_id, device_id)
    return {"ok": True}
