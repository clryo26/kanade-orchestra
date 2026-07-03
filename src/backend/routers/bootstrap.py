from __future__ import annotations

from fastapi import APIRouter, Request

from ..core.compat_gateway import get_memory_cache_instance
from ..core.storage_gateway import load_json_data
from ..services.auth_service import public_member_list
from ..services.file_service import format_duration
from ..services.json_collection_service import list_auth_devices
from ..services import bootstrap_service, meta_service
from ..services.recording_asset_service import recording_payload
from ..services.sheet_asset_service import sheet_payload

router = APIRouter()


async def _list_auth_devices() -> list[dict[str, object]]:
    return await list_auth_devices(load_json_data=load_json_data)


def _recording_payload() -> dict[str, list[dict[str, object]]]:
    return recording_payload(load_json_data=load_json_data, format_duration=format_duration)


def _sheet_payload() -> list[dict[str, object]]:
    return sheet_payload(load_json_data("sheet_library"))


@router.get("/api/bootstrap-lite", response_model=None)
async def get_bootstrap_lite_data(request: Request):
    etag = bootstrap_service.combined_collection_etag(
        ("performances", "schedules", "announcements", "members", "payments", "flyer_places", "flyer_distributions", "part_settings", "org_settings", "sns_settings", "connection_settings"),
        load_json_data,
        lambda name: get_memory_cache_instance().etag(name) or "",
    )
    data = await bootstrap_service.bootstrap_lite_payload(
        load_json_data=load_json_data,
        public_member_list=public_member_list,
        cloud_run_revision=meta_service.cloud_run_revision,
    )
    return bootstrap_service.bootstrap_response(request, data, etag)


@router.get("/api/bootstrap-core", response_model=None)
async def get_bootstrap_core_data(request: Request):
    etag = bootstrap_service.combined_collection_etag(
        (
            "performances",
            "schedules",
            "announcements",
            "events",
            "members",
            "auth_devices",
            "absences",
            "event_responses",
            "date_adjustments",
            "date_adjustment_responses",
            "payments",
            "castings",
            "piece_infos",
            "practice_instructions",
            "flyer_distributions",
            "performance_day_infos",
            "albums",
            "flyer_places",
            "part_settings",
            "venue_settings",
            "org_settings",
            "sns_settings",
            "connection_settings",
            "desired_pieces",
            "promotions",
        ),
        load_json_data,
        lambda name: get_memory_cache_instance().etag(name) or "",
    )
    data = await bootstrap_service.bootstrap_core_payload(
        load_json_data=load_json_data,
        public_member_list=public_member_list,
        list_auth_devices=_list_auth_devices,
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
            "flyer_distributions",
            "performance_day_infos",
            "albums",
            "flyer_places",
            "part_settings",
            "venue_settings",
            "org_settings",
            "sns_settings",
            "connection_settings",
            "desired_pieces",
            "promotions",
        ),
        load_json_data,
        lambda name: get_memory_cache_instance().etag(name) or "",
    )
    data = await bootstrap_service.bootstrap_payload(
        load_json_data=load_json_data,
        public_member_list=public_member_list,
        recording_payload=_recording_payload,
        sheet_payload=_sheet_payload,
        list_auth_devices=_list_auth_devices,
        cloud_run_revision=meta_service.cloud_run_revision,
    )
    return bootstrap_service.bootstrap_response(request, data, etag)
