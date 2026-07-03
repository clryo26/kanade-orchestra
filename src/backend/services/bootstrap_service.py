from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request
from fastapi.responses import Response

logger = logging.getLogger(__name__)


def _safe_load_extra(name: str, load_json_data: Callable[[str], list[dict[str, Any]]]) -> list[dict[str, Any]]:
    try:
        return load_json_data(name)
    except Exception:
        logger.exception("Failed to load bootstrap extra collection: %s", name)
        return []


def combined_collection_etag(
    names: tuple[str, ...],
    load_json_data: Callable[[str], list[dict[str, Any]]],
    cache_etag: Callable[[str], str],
) -> str:
    parts: list[str] = []
    for name in dict.fromkeys(names):
        try:
            load_json_data(name)
            parts.append(f"{name}:{cache_etag(name) or ''}")
        except Exception as exc:
            logger.exception("Failed to include collection in bootstrap ETag: %s", name)
            parts.append(f"{name}:error:{type(exc).__name__}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def bootstrap_response(request: Request, data: dict[str, Any], etag: str) -> dict[str, Any] | Response:
    if request.headers.get("if-none-match", "") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(
        content=json.dumps(data, ensure_ascii=False),
        media_type="application/json",
        headers={"ETag": etag},
    )


async def bootstrap_lite_payload(
    *,
    load_json_data: Callable[[str], list[dict[str, Any]]],
    public_member_list: Callable[[list[dict[str, Any]]], list[dict[str, Any]]],
    cloud_run_revision: Callable[[], str],
) -> dict[str, Any]:
    extra_names = ("payments", "flyer_places", "flyer_distributions", "part_settings", "org_settings", "sns_settings", "connection_settings")
    extras = {name: _safe_load_extra(name, load_json_data) for name in extra_names}
    return {
        "performances": load_json_data("performances"),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "members": public_member_list(load_json_data("members")),
        "extras": extras,
        "cloudRunRevision": cloud_run_revision(),
    }


async def bootstrap_core_payload(
    *,
    load_json_data: Callable[[str], list[dict[str, Any]]],
    public_member_list: Callable[[list[dict[str, Any]]], list[dict[str, Any]]],
    list_auth_devices: Callable[[], Awaitable[list[dict[str, Any]]]],
    cloud_run_revision: Callable[[], str],
) -> dict[str, Any]:
    extra_names = (
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
    )
    extras = {name: _safe_load_extra(name, load_json_data) for name in extra_names}
    return {
        "performances": load_json_data("performances"),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "events": load_json_data("events"),
        "members": public_member_list(load_json_data("members")),
        "extras": extras,
        "auth_devices": await list_auth_devices(),
        "cloudRunRevision": cloud_run_revision(),
    }


async def bootstrap_payload(
    *,
    load_json_data: Callable[[str], list[dict[str, Any]]],
    public_member_list: Callable[[list[dict[str, Any]]], list[dict[str, Any]]],
    recording_payload: Callable[[], dict[str, list[dict[str, Any]]]],
    sheet_payload: Callable[[], list[dict[str, Any]]],
    list_auth_devices: Callable[[], Awaitable[list[dict[str, Any]]]],
    cloud_run_revision: Callable[[], str],
) -> dict[str, Any]:
    extra_names = (
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
    )
    extras = {name: _safe_load_extra(name, load_json_data) for name in extra_names}
    return {
        "performances": load_json_data("performances"),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "events": load_json_data("events"),
        "members": public_member_list(load_json_data("members")),
        "recordings": recording_payload(),
        "sheets": {"files": sheet_payload()},
        "extras": extras,
        "auth_devices": await list_auth_devices(),
        "cloudRunRevision": cloud_run_revision(),
    }
