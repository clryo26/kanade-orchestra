from __future__ import annotations

from typing import Any

from fastapi import HTTPException
try:
    from openpyxl import load_workbook
except Exception:  # pragma: no cover - optional dependency guard
    load_workbook = None

from ..core.runtime_paths import TIMETABLE_TEMPLATE_PATH
from ..repositories.performance_repository import PerformanceRepository
from .storage_service import load_json_data
from .timetable_payload_helpers import build_timetable_workbook_bytes, excel_safe_filename, performance_day_info_for_performance

_repo = PerformanceRepository()


def list_performances() -> list[dict[str, Any]]:
    return _repo.list_all()


def get_performance(performance_id: int) -> dict[str, Any]:
    _, item = _repo.find_by_id(performance_id)
    return item


def create_performance(payload: dict[str, Any]) -> dict[str, Any]:
    return _repo.create(payload)


def update_performance(performance_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return _repo.update(performance_id, lambda current: {**current, **payload})


def delete_performance(performance_id: int) -> None:
    _repo.delete(performance_id)


def build_timetable_report(performance_id: int) -> tuple[bytes, str]:
    performance = get_performance(performance_id)
    info = performance_day_info_for_performance(performance_id, load_json_data)
    if not info:
        raise HTTPException(status_code=404, detail="performance_day_info not found")

    workbook_bytes = build_timetable_workbook_bytes(
        performance,
        info,
        load_workbook_func=load_workbook,
        template_path=TIMETABLE_TEMPLATE_PATH,
    )
    date_text = str(performance.get("date") or "").strip()
    title_text = excel_safe_filename(performance.get("title") or "performance")
    filename = (
        f"{date_text}_{title_text}_本番タイムテーブル.xlsx"
        if date_text
        else f"{title_text}_本番タイムテーブル.xlsx"
    )
    return workbook_bytes, filename
