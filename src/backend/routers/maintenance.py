from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..core.auth_dependencies import get_admin_device_auth
from ..core.storage_gateway import load_json_data
from ..services import maintenance_service

router = APIRouter()


@router.get("/api/maintenance/orphans")
async def get_maintenance_orphans(_admin_device: dict[str, Any] = Depends(get_admin_device_auth)) -> dict[str, Any]:
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
