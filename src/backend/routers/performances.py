from __future__ import annotations

import json
from typing import Any
from io import BytesIO
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request, UploadFile
from fastapi.responses import Response, StreamingResponse

from ..core.auth_dependencies import get_admin_device_auth
from ..models.schemas import Performance
from ..services import performance_service
from ..services.extra_collection_helpers import read_json_body

router = APIRouter()


async def _read_performance_payload(request: Request) -> tuple[dict[str, Any], UploadFile | None]:
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        form = await request.form()
        flyer_file = form.get("flyer_file")
        pieces_raw = str(form.get("pieces") or "[]").strip()
        try:
            pieces = json.loads(pieces_raw) if pieces_raw else []
        except Exception:
            pieces = []
        payload = {
            "expected_updated_at": str(form.get("expected_updated_at") or "").strip(),
            "title": str(form.get("title") or "").strip(),
            "date": str(form.get("date") or "").strip(),
            "open_time": str(form.get("open_time") or "").strip(),
            "start_time": str(form.get("start_time") or "").strip(),
            "venue": str(form.get("venue") or "").strip(),
            "conductor": str(form.get("conductor") or "").strip(),
            "flyer_image": str(form.get("flyer_image") or "").strip(),
            "performance_fee_amount": str(form.get("performance_fee_amount") or "").strip(),
            "pieces": pieces,
        }
        return payload, flyer_file if flyer_file and hasattr(flyer_file, "read") else None
    return await read_json_body(request), None


@router.get("/api/performances", response_model=list[Performance])
async def get_performances() -> list[dict[str, Any]]:
    return performance_service.list_performances()


@router.post("/api/performances", response_model=Performance)
async def create_performance(
    request: Request,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> Any:
    payload, flyer_file = await _read_performance_payload(request)
    return await performance_service.create_performance(
        payload, flyer_file, device=_admin_device, idempotency_key=request.headers.get("Idempotency-Key")
    )


@router.get("/api/performances/{performance_id}", response_model=Performance)
async def get_performance(performance_id: int) -> dict[str, Any]:
    return performance_service.get_performance(performance_id)


@router.get("/api/performances/{performance_id}/flyer-image")
async def get_performance_flyer_image(performance_id: int, asset: str = "") -> Response:
    # Only a DB-confirmed asset (or legacy inline data in the row) is served.
    return performance_service.flyer_response(performance_id, asset or None)


@router.get("/api/reports/performance-timetable/{performance_id}/xlsx")
async def download_performance_timetable_xlsx(
    performance_id: int,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> StreamingResponse:
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
    request: Request,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> Any:
    payload, flyer_file = await _read_performance_payload(request)
    return await performance_service.update_performance(
        performance_id, payload, flyer_file, device=_admin_device, idempotency_key=request.headers.get("Idempotency-Key")
    )


@router.delete("/api/performances/{performance_id}")
async def delete_performance(
    performance_id: int,
    request: Request,
    _admin_device: dict[str, Any] = Depends(get_admin_device_auth),
) -> Any:
    result = await performance_service.delete_performance(
        performance_id, device=_admin_device, idempotency_key=request.headers.get("Idempotency-Key")
    )
    if isinstance(result, Response):
        return result
    return {"message": "Deleted"}
