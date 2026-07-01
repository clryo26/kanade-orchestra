from __future__ import annotations

from typing import Any
from io import BytesIO
from urllib.parse import quote

from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse

from ..core import require_admin_device
from ..models.schemas import Performance
from ..services.auth_service import device_auth_record
from ..services import performance_service
from ..utils.serialization import model_dump

router = APIRouter()


def _require_admin(device_id: str) -> None:
    require_admin_device(device_id, device_auth_record)


@router.get("/api/performances", response_model=list[Performance])
async def get_performances() -> list[dict[str, Any]]:
    return performance_service.list_performances()


@router.post("/api/performances", response_model=Performance)
async def create_performance(
    performance: Performance,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    _require_admin(x_device_id)
    return performance_service.create_performance(model_dump(performance))


@router.get("/api/performances/{performance_id}", response_model=Performance)
async def get_performance(performance_id: int) -> dict[str, Any]:
    return performance_service.get_performance(performance_id)


@router.get("/api/reports/performance-timetable/{performance_id}/xlsx")
async def download_performance_timetable_xlsx(
    performance_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> StreamingResponse:
    _require_admin(x_device_id)
    workbook_bytes, filename = performance_service.build_timetable_report(performance_id)
    quoted = quote(filename)
    return StreamingResponse(
        BytesIO(workbook_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quoted}",
            "Cache-Control": "no-store",
        },
    )


@router.put("/api/performances/{performance_id}", response_model=Performance)
async def update_performance(
    performance_id: int,
    performance: Performance,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    _require_admin(x_device_id)
    return performance_service.update_performance(performance_id, model_dump(performance))


@router.delete("/api/performances/{performance_id}")
async def delete_performance(
    performance_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    _require_admin(x_device_id)
    performance_service.delete_performance(performance_id)
    return {"message": "Deleted"}
