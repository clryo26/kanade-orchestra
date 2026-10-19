from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from ..core.auth_dependencies import get_device_auth, get_system_admin_device_auth
from ..core.dependency import get_memory_cache
from ..core.compat_gateway import mutate_json_data
from ..core.storage_gateway import load_json_data
from ..db.database import db_data_enabled
from ..repositories.access_log_repository import insert_access_log, query_access_logs
from ..services import access_log_service
from ..services.extra_collection_helpers import read_json_body
from ..utils.collection_utils import next_id
from ..utils.datetime_utils import jst_date_range, next_updated_at, parse_calendar_date

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

    created: dict[str, Any] = {}

    def mutate(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        created.update(
            access_log_service.create_access_log_payload(
                body=body,
                device=device,
                x_device_id=x_device_id,
                user_agent=request.headers.get("user-agent", ""),
                now=now,
                next_id=next_id(items),
            )
        )
        return access_log_service.trim_access_logs([*items, dict(created)])

    mutate_json_data("access_logs", mutate)
    return created


def _search_range(
    date_from: datetime | None,
    date_to: datetime | None,
    from_date: str,
    to_date: str,
) -> tuple[datetime | None, datetime | None]:
    """JST calendar-day range, end exclusive (spec R04: start 00:00+09:00 <= t < day after end 00:00+09:00).

    ``from_date``/``to_date`` (YYYY-MM-DD) are the JST screen inputs. The
    older ``date_from``/``date_to`` instants stay accepted, but only with an
    explicit offset: a naive value would be interpreted by the DB session
    TimeZone.
    """
    for name, value in (("date_from", date_from), ("date_to", date_to)):
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise HTTPException(status_code=422, detail=f"{name}: timezone offset is required")
    start_day = parse_calendar_date(from_date, field="from_date") if from_date else None
    end_day = parse_calendar_date(to_date, field="to_date") if to_date else None
    day_start, day_end = jst_date_range(start_day, end_day)
    start = day_start if day_start is not None else date_from
    end = day_end if day_end is not None else date_to
    if start is not None and end is not None and start >= end:
        raise HTTPException(status_code=422, detail="date range: start must be before end")
    return start, end


@router.get("/api/system/access-logs")
async def list_access_logs(
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    member_id: int | None = None,
    member_part: str = "",
    page: int = 1,
    from_date: str = "",
    to_date: str = "",
    _system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, Any]:
    date_from, date_to = _search_range(date_from, date_to, from_date.strip(), to_date.strip())
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
