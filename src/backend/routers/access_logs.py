from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Header, Request

from ..core.auth_dependencies import get_device_auth, get_system_admin_device_auth
from ..core.dependency import get_memory_cache
from ..core.storage_gateway import load_json_data, save_json_data
from ..db.database import db_data_enabled
from ..repositories.access_log_repository import insert_access_log, query_access_logs
from ..services import access_log_service
from ..services.extra_collection_helpers import read_json_body
from ..utils.collection_utils import next_id
from ..utils.datetime_utils import next_updated_at

router = APIRouter()


@router.post("/api/system/access-logs")
async def create_access_log(
    request: Request,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    body = await read_json_body(request)
    now = next_updated_at()

    if db_data_enabled():
        payload = access_log_service.create_access_log_payload(
            body=body,
            device=device,
            x_device_id=x_device_id,
            user_agent=request.headers.get("user-agent", ""),
            now=now,
            next_id=None,
        )
        stored = insert_access_log(payload)
        get_memory_cache().invalidate("access_logs")
        return stored

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
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    member_id: int | None = None,
    member_part: str = "",
    page: int = 1,
    _system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, Any]:
    if db_data_enabled():
        return query_access_logs(
            date_from=date_from,
            date_to=date_to,
            member_id=member_id,
            member_part=member_part,
            page=page,
        )

    items = load_json_data("access_logs")
    return access_log_service.search_access_logs(
        items,
        date_from=date_from,
        date_to=date_to,
        member_id=member_id,
        member_part=member_part,
        page=page,
    )
