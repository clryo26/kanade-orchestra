from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request
from fastapi.responses import Response

from .image_asset_service import ensure_public_image_url


def _public_performances(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    public_items: list[dict[str, Any]] = []
    for item in items:
        payload = dict(item)
        performance_id = int(payload.get("id") or 0)
        if performance_id:
            payload["flyer_image"] = ensure_public_image_url(
                payload.get("flyer_image") or "",
                route_path=f"/api/performances/{performance_id}/flyer-image",
            )
        # 公開 bootstrap では一覧表示に使わない監査系タイムスタンプを返さない。
        payload.pop("created_at", None)
        payload.pop("updated_at", None)
        public_items.append(payload)
    return public_items


def _public_promotions(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    public_items: list[dict[str, Any]] = []
    for item in items:
        payload = dict(item)
        promotion_id = int(payload.get("id") or 0)
        if promotion_id:
            payload["image_url"] = ensure_public_image_url(
                payload.get("image_url") or "",
                route_path=f"/api/extra/promotions/{promotion_id}/image",
            )
        public_items.append(payload)
    return public_items


def _public_org_settings(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    public_items: list[dict[str, Any]] = []
    for item in items:
        payload = dict(item)
        setting_id = int(payload.get("id") or 0)
        if setting_id:
            payload["icon_url"] = ensure_public_image_url(
                payload.get("icon_url") or "",
                route_path=f"/api/extra/org_settings/{setting_id}/icon",
            )
        public_items.append(payload)
    return public_items


def combined_collection_etag(
    names: tuple[str, ...],
    load_json_data: Callable[[str], list[dict[str, Any]]],
    cache_etag: Callable[[str], str],
) -> str:
    parts: list[str] = []
    for name in dict.fromkeys(names):
        load_json_data(name)
        parts.append(f"{name}:{cache_etag(name) or ''}")
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
    personal_payment_list: Callable[[list[dict[str, Any]]], list[dict[str, Any]]],
    cloud_run_revision: Callable[[], str],
) -> dict[str, Any]:
    extra_names = (
        "payments",
        "part_settings",
        "org_settings",
        "sns_settings",
    )
    extras = {name: load_json_data(name) for name in extra_names}
    extras["org_settings"] = _public_org_settings(extras["org_settings"])
    extras["payments"] = personal_payment_list(extras["payments"])
    return {
        "performances": _public_performances(load_json_data("performances")),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "members": public_member_list(load_json_data("members")),
        "extras": extras,
        "cloudRunRevision": cloud_run_revision(),
    }


async def bootstrap_core_payload(
    *,
    cloud_run_revision: Callable[[], str],
) -> dict[str, Any]:
    return {
        "extras": {},
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
    )
    extras = {name: load_json_data(name) for name in extra_names}
    extras["org_settings"] = _public_org_settings(extras["org_settings"])
    return {
        "performances": _public_performances(load_json_data("performances")),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "events": load_json_data("events"),
        "members": public_member_list(load_json_data("members")),
        "recordings": recording_payload(),
        "sheets": {"files": sheet_payload()},
        "extras": {**extras, "promotions": _public_promotions(extras["promotions"])},
        "auth_devices": await list_auth_devices(),
        "cloudRunRevision": cloud_run_revision(),
    }
