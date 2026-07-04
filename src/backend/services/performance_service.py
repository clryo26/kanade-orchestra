from __future__ import annotations

import logging
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
logger = logging.getLogger(__name__)


def _safe_fee_amount(value: Any) -> float:
    if value in (None, ""):
        return 0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0


def _normalize_piece(piece: Any) -> Any | None:
    if isinstance(piece, dict):
        title = str(piece.get("title") or piece.get("piece") or piece.get("name") or "").strip()
        if not title:
            return None
        normalized = dict(piece)
        normalized["title"] = title
        return normalized
    title = str(piece or "").strip()
    if not title:
        return None
    return title


def _normalize_performance(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(payload)
    for key in ("title", "date", "open_time", "start_time", "venue", "conductor", "flyer_image"):
        normalized[key] = "" if normalized.get(key) is None else str(normalized.get(key, ""))
    normalized["performance_fee_amount"] = _safe_fee_amount(normalized.get("performance_fee_amount"))

    raw_pieces = normalized.get("pieces")
    pieces = raw_pieces if isinstance(raw_pieces, list) else []
    normalized["pieces"] = [
        piece
        for raw_piece in pieces
        if (piece := _normalize_piece(raw_piece)) is not None
    ]
    return normalized


def _save_error(operation: str, exc: Exception) -> HTTPException:
    logger.exception("Performance %s failed", operation)
    return HTTPException(status_code=500, detail=f"Performance {operation} failed: {exc}")


def list_performances() -> list[dict[str, Any]]:
    return [_normalize_performance(item) for item in _repo.list_all()]


def get_performance(performance_id: int) -> dict[str, Any]:
    _, item = _repo.find_by_id(performance_id)
    return _normalize_performance(item)


def create_performance(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return _normalize_performance(_repo.create(_normalize_performance(payload)))
    except HTTPException:
        raise
    except Exception as exc:
        raise _save_error("create", exc) from exc


def update_performance(performance_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    normalized_payload = _normalize_performance(payload)
    normalized_payload.pop("created_at", None)
    try:
        return _normalize_performance(_repo.update(performance_id, lambda current: {**current, **normalized_payload}))
    except HTTPException:
        raise
    except Exception as exc:
        raise _save_error("update", exc) from exc


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
