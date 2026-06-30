from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse

from .. import app_core as core

router = APIRouter()


@router.get("/api/performances", response_model=list[core.Performance])
async def get_performances() -> list[dict[str, Any]]:
    return core.load_json_data("performances")


@router.post("/api/performances", response_model=core.Performance)
async def create_performance(
    performance: core.Performance,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("performances")
    now = core.datetime.now().isoformat()
    payload = core.model_dump(performance)
    payload.update({"id": core.next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    core.save_json_data("performances", items)
    return payload


@router.get("/api/performances/{performance_id}", response_model=core.Performance)
async def get_performance(performance_id: int) -> dict[str, Any]:
    _, item = core.find_item(core.load_json_data("performances"), performance_id)
    return item


@router.get("/api/reports/performance-timetable/{performance_id}/xlsx")
async def download_performance_timetable_xlsx(
    performance_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> StreamingResponse:
    core.require_admin_device(x_device_id)
    _, performance = core.find_item(core.load_json_data("performances"), performance_id)
    info = core.performance_day_info_for_performance(performance_id)
    if not info:
        raise HTTPException(status_code=404, detail="performance_day_info not found")

    workbook_bytes = core.build_timetable_workbook_bytes(performance, info)
    date_text = str(performance.get("date") or "").strip()
    title_text = core.excel_safe_filename(performance.get("title") or "performance")
    filename = (
        f"{date_text}_{title_text}_本番タイムテーブル.xlsx"
        if date_text
        else f"{title_text}_本番タイムテーブル.xlsx"
    )
    quoted = core.quote(filename)
    return StreamingResponse(
        core.io.BytesIO(workbook_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quoted}",
            "Cache-Control": "no-store",
        },
    )


@router.put("/api/performances/{performance_id}", response_model=core.Performance)
async def update_performance(
    performance_id: int,
    performance: core.Performance,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("performances")
    index, current = core.find_item(items, performance_id)
    payload = core.model_dump(performance)
    payload.update(
        {
            "id": performance_id,
            "created_at": current.get("created_at"),
            "updated_at": core.datetime.now().isoformat(),
        }
    )
    items[index] = payload
    core.save_json_data("performances", items)
    return payload


@router.delete("/api/performances/{performance_id}")
async def delete_performance(
    performance_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    core.require_admin_device(x_device_id)
    items = core.load_json_data("performances")
    core.find_item(items, performance_id)
    core.save_json_data(
        "performances",
        [item for item in items if item.get("id") != performance_id],
    )
    return {"message": "Deleted"}
