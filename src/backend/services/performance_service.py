from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException, UploadFile
from fastapi.responses import Response
try:
    from openpyxl import load_workbook
except Exception:  # pragma: no cover - optional dependency guard
    load_workbook = None

from ..core.runtime_paths import TIMETABLE_TEMPLATE_PATH
from ..models.schemas import Performance
from ..utils.concurrency import ensure_expected_updated_at
from ..repositories.performance_repository import PerformanceRepository
from . import portal_file_asset_service as file_assets
from .image_asset_service import ensure_public_image_url
from ..utils.datetime_utils import require_input_dates
from .storage_service import load_json_data
from .timetable_payload_helpers import build_timetable_workbook_bytes, excel_safe_filename, performance_day_info_for_performance

_repo = PerformanceRepository()
logger = logging.getLogger(__name__)
FLYER_KIND = "performance_flyer"


def _flyer_route(performance_id: int) -> str:
    return f"/api/performances/{performance_id}/flyer-image"


def _public_flyer_image(performance_id: int, flyer_image: str) -> str:
    return ensure_public_image_url(
        flyer_image,
        route_path=_flyer_route(performance_id),
    )


def flyer_response(performance_id: int, asset: str | None) -> Response:
    performance = get_performance_record(performance_id)
    return file_assets.deliver(FLYER_KIND, performance_id, asset, inline_value=str(performance.get("flyer_image") or ""))


def _store():
    from ..core.compat_gateway import row_store

    return row_store()


def _flyer_action(payload: dict[str, Any], flyer_file: UploadFile | None, current: dict[str, Any] | None, *, replayable: bool = False) -> tuple[Any, str]:
    flyer_source = str(payload.get("flyer_image") or "")
    if flyer_file is not None:
        return flyer_file, "replace"
    if file_assets.is_data_image(flyer_source):
        return flyer_source, "replace"
    if "flyer_image" in payload and not flyer_source and (replayable or (current is not None and str(current.get("flyer_image") or ""))):
        return None, "remove"
    return None, "keep"


async def _flyer_file(source: Any) -> Any:
    if source is None:
        return None
    if isinstance(source, str):
        return file_assets.read_data_image(source)
    return await file_assets.read_image_upload(source)


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
    items = [_normalize_performance(item) for item in _repo.list_all()]
    for item in items:
        performance_id = int(item.get("id") or 0)
        if performance_id:
            item["flyer_image"] = _public_flyer_image(performance_id, item.get("flyer_image") or "")
    return items


def get_performance(performance_id: int) -> dict[str, Any]:
    _, item = _repo.find_by_id(performance_id)
    normalized = _normalize_performance(item)
    normalized["flyer_image"] = _public_flyer_image(performance_id, normalized.get("flyer_image") or "")
    return normalized


def get_performance_record(performance_id: int) -> dict[str, Any]:
    _, item = _repo.find_by_id(performance_id)
    return item


async def create_performance(
    payload: dict[str, Any],
    flyer_file: UploadFile | None = None,
    *,
    device: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> Any:
    require_input_dates(payload, ("date",))
    normalized_payload = _normalize_performance(payload)
    source, action = _flyer_action(normalized_payload, flyer_file, None)
    # The flyer reference is server managed (a confirmed asset only).
    normalized_payload["flyer_image"] = ""
    if action == "keep" and not idempotency_key:
        try:
            return _normalize_performance(_repo.create(normalized_payload))
        except HTTPException:
            raise
        except Exception as exc:
            raise _save_error("create", exc) from exc
    file = await _flyer_file(source)

    def apply(tx: Any, applied: Any) -> tuple[int, dict[str, Any]]:
        saved = _store().insert("performances", lambda new_id: {**normalized_payload, "flyer_image": applied.url_for(new_id)}, ctx=tx.ctx)
        if applied.asset_id:
            applied.commit_reference(tx, int(saved["id"]))
        return 200, Performance.model_validate(_normalize_performance(saved)).model_dump()

    status, body = await file_assets.run(
        file_assets.FileOperation(
            kind=FLYER_KIND, method="POST", target_id=None, action=action, file=file,
            fingerprint=normalized_payload, validate=lambda tx: None, apply=apply, view_scope="admin",
        ),
        device or {},
        idempotency_key,
    )
    return file_assets.http_result(status, body)


async def update_performance(
    performance_id: int,
    payload: dict[str, Any],
    flyer_file: UploadFile | None = None,
    *,
    device: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> Any:
    require_input_dates(payload, ("date",))
    normalized_payload = _normalize_performance(payload)
    normalized_payload.pop("created_at", None)
    current = _store().get("performances", performance_id) if not idempotency_key else None
    if current is None and not idempotency_key:
        raise HTTPException(status_code=404, detail="Data not found")
    source, action = _flyer_action(payload, flyer_file, current, replayable=bool(idempotency_key))

    def merge(latest: dict[str, Any]) -> dict[str, Any]:
        merged = _normalize_performance({**latest, **normalized_payload})
        merged["flyer_image"] = latest.get("flyer_image") or ""
        return merged

    if action == "keep" and not idempotency_key:
        try:
            return _normalize_performance(_repo.update(performance_id, merge))
        except HTTPException:
            raise
        except Exception as exc:
            raise _save_error("update", exc) from exc
    file = await _flyer_file(source)

    def validate(tx: Any) -> None:
        latest = _store().get("performances", performance_id, ctx=tx.ctx, lock=True)
        if latest is None:
            raise HTTPException(status_code=404, detail="Data not found")
        ensure_expected_updated_at(latest, payload.get("expected_updated_at"))

    def apply(tx: Any, applied: Any) -> tuple[int, dict[str, Any]]:
        def with_flyer(latest: dict[str, Any]) -> dict[str, Any]:
            merged = merge(latest)
            if action == "replace":
                merged["flyer_image"] = applied.url_for(performance_id)
            elif action == "remove":
                merged["flyer_image"] = ""
            return merged

        saved = _store().update("performances", performance_id, with_flyer, expected_updated_at=payload.get("expected_updated_at"), ctx=tx.ctx)
        if action == "replace":
            applied.commit_reference(tx, performance_id)
        elif action == "remove":
            applied.retire_reference(tx, performance_id)
        return 200, Performance.model_validate(_normalize_performance(saved)).model_dump()

    status, body = await file_assets.run(
        file_assets.FileOperation(
            kind=FLYER_KIND, method="PUT", target_id=performance_id, action=action, file=file,
            fingerprint=normalized_payload, validate=validate, apply=apply, view_scope="admin",
        ),
        device or {},
        idempotency_key,
    )
    return file_assets.http_result(status, body)


async def delete_performance(performance_id: int, *, device: dict[str, Any] | None = None, idempotency_key: str | None = None) -> Any:
    if not idempotency_key and not file_assets.has_active_asset(FLYER_KIND, performance_id):
        _repo.delete(performance_id)
        return None

    def validate(tx: Any) -> None:
        if _store().get("performances", performance_id, ctx=tx.ctx, lock=True) is None:
            raise HTTPException(status_code=404, detail="Data not found")

    def apply(tx: Any, applied: Any) -> tuple[int, dict[str, Any]]:
        _store().delete("performances", performance_id, lambda current: None, ctx=tx.ctx)
        applied.retire_reference(tx, performance_id)
        return 200, {"message": "Deleted"}

    status, body = await file_assets.run(
        file_assets.FileOperation(
            kind=FLYER_KIND, method="DELETE", target_id=performance_id, action="delete", file=None,
            fingerprint={}, validate=validate, apply=apply, view_scope="admin",
        ),
        device or {},
        idempotency_key,
    )
    return file_assets.http_result(status, body)


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
