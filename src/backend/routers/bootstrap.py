from __future__ import annotations

import hashlib
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from ..core.compat_gateway import get_memory_cache_instance
from ..core.storage_gateway import load_json_data
from ..services.auth_service import (
    device_auth_record,
    personal_payment_list,
    public_member_list,
    public_member_payload,
)
from ..services.file_service import format_duration
from ..services.json_collection_service import list_auth_devices
from ..services import bootstrap_service, meta_service
from ..repositories.db_json_repository import load_collection_etag
from ..services.recording_asset_service import recording_payload
from ..services.sheet_asset_service import sheet_payload
from .notices import router as notices_router

router = APIRouter()
router.include_router(notices_router)


async def _list_auth_devices() -> list[dict[str, object]]:
    return await list_auth_devices(load_json_data=load_json_data)


def _recording_payload() -> dict[str, list[dict[str, object]]]:
    return recording_payload(load_json_data=load_json_data, format_duration=format_duration)


def _sheet_payload() -> list[dict[str, object]]:
    return sheet_payload(load_json_data("sheet_library"))


def _collection_etag(name: str) -> str:
    cached = get_memory_cache_instance().etag(name) or ""
    try:
        db_digest = load_collection_etag(name)
        if db_digest:
            return db_digest
    except Exception:
        pass

    if cached:
        return cached

    # In local-fallback mode no DB digest may be available on first request.
    # Hydrate the collection once so subsequent If-None-Match checks stay stable.
    try:
        load_json_data(name)
    except Exception:
        return ""
    return get_memory_cache_instance().etag(name) or ""


@router.get("/api/bootstrap-lite", response_model=None)
async def get_bootstrap_lite_data(
    request: Request,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
):
    # オプション認証: 401/403は未認証扱い、それ以外は再送出
    device: dict[str, Any] | None = None
    if x_device_id:
        try:
            device = device_auth_record(x_device_id)
        except HTTPException as exc:
            if exc.status_code in {401, 403}:
                pass
            else:
                raise

    etag = bootstrap_service.combined_collection_etag(
        (
            "performances",
            "schedules",
            "announcements",
            "members",
            "payments",
            "part_settings",
            "org_settings",
            "sns_settings",
        ),
        lambda name: get_memory_cache_instance().etag(name) or "",
        _collection_etag,
    )
    if bootstrap_service.request_not_modified(request, etag):
        return bootstrap_service.not_modified_response(etag)
    data = await bootstrap_service.bootstrap_lite_payload(
        load_json_data=load_json_data,
        public_member_list=public_member_list,
        personal_payment_list=lambda payments: personal_payment_list(payments, device),
        cloud_run_revision=meta_service.cloud_run_revision,
    )
    return bootstrap_service.bootstrap_response(request, data, etag)


@router.get("/api/bootstrap-core", response_model=None)
async def get_bootstrap_core_data(request: Request):
    revision = meta_service.cloud_run_revision()
    etag = hashlib.sha256(revision.encode("utf-8")).hexdigest()
    if bootstrap_service.request_not_modified(request, etag):
        return bootstrap_service.not_modified_response(etag)
    data = await bootstrap_service.bootstrap_core_payload(
        cloud_run_revision=meta_service.cloud_run_revision,
    )
    return bootstrap_service.bootstrap_response(request, data, etag)


@router.get("/api/bootstrap", response_model=None)
async def get_bootstrap_data(request: Request):
    etag = bootstrap_service.combined_collection_etag(
        (
            "performances",
            "schedules",
            "announcements",
            "events",
            "members",
            "drive_files",
            "recording_metadata",
            "auth_devices",
            "absences",
            "event_responses",
            "date_adjustments",
            "date_adjustment_responses",
            "sheet_library",
            "payments",
            "castings",
            "piece_infos",
            "practice_instructions",
            "performance_day_infos",
            "albums",
            "part_settings",
            "venue_settings",
            "flyer_distributions",
            "flyer_distribution_assignments",
            "org_settings",
            "sns_settings",
            "connection_settings",
            "desired_pieces",
            "promotions",
        ),
        lambda name: get_memory_cache_instance().etag(name) or "",
        _collection_etag,
    )
    if bootstrap_service.request_not_modified(request, etag):
        return bootstrap_service.not_modified_response(etag)
    data = await bootstrap_service.bootstrap_payload(
        load_json_data=load_json_data,
        public_member_payload=public_member_payload,
        recording_payload=_recording_payload,
        sheet_payload=_sheet_payload,
        list_auth_devices=_list_auth_devices,
        cloud_run_revision=meta_service.cloud_run_revision,
    )
    return bootstrap_service.bootstrap_response(request, data, etag)
