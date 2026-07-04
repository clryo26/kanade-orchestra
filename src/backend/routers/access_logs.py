from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, Request

from ..core.auth_dependencies import get_device_auth, get_system_admin_device_auth
from ..core.storage_gateway import load_json_data, save_json_data
from ..services import access_log_service
from ..services.extra_collection_helpers import read_json_body
from ..utils.datetime_utils import next_updated_at
from ..utils.collection_utils import next_id

router = APIRouter()


@router.post("/api/system/access-logs")
async def create_access_log(
    request: Request,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    body = await read_json_body(request)
    now = next_updated_at()
    items = load_json_data("access_logs")
    payload = access_log_service.create_access_log_payload(
        body=body,
        device=device,
        x_device_id=x_device_id,
        user_agent=request.headers.get("user-agent", ""),
        now=now,
        next_id=next_id(items),
    )
    items.append(payload)
    save_json_data("access_logs", access_log_service.trim_access_logs(items))
    return payload


@router.get("/api/system/access-logs")
async def list_access_logs(
    limit: int = 200,
    _system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> list[dict[str, Any]]:
    items = load_json_data("access_logs")
    return access_log_service.list_access_logs(items, limit)
