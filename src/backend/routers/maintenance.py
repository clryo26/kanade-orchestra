from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header

from ..core import require_admin_device
from ..core.storage_gateway import load_json_data
from ..services.auth_service import device_auth_record
from ..services import maintenance_service

router = APIRouter()


@router.get("/api/maintenance/orphans")
async def get_maintenance_orphans(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id, device_auth_record)
    relations = (
        ("piece_infos", "performance_id", "performances"),
        ("practice_instructions", "performance_id", "performances"),
        ("castings", "performance_id", "performances"),
        ("absences", "schedule_id", "schedules"),
        ("absences", "member_id", "members"),
        ("event_responses", "event_id", "events"),
        ("event_responses", "member_id", "members"),
        ("payments", "member_id", "members"),
        ("desired_pieces", "member_id", "members"),
    )
    return maintenance_service.find_orphans(relations, load_json_data)
