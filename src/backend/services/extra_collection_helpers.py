from __future__ import annotations

from typing import Any, Callable

from fastapi import HTTPException, Request

from ..models.schemas import ExtraUpsertRequest

EXTRA_COLLECTIONS = {
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
}

ADMIN_ONLY_EXTRA_COLLECTIONS = {
    "sheet_library",
    "payments",
    "castings",
    "performance_day_infos",
    "albums",
    "part_settings",
    "venue_settings",
    "flyer_distributions",
    "org_settings",
    "sns_settings",
    "connection_settings",
    "desired_pieces",
    "promotions",
}


def parse_extra_upsert_request(raw_body: dict[str, Any]) -> ExtraUpsertRequest:
    payload = raw_body
    expected_updated_at = ""
    if isinstance(raw_body.get("payload"), dict):
        payload = dict(raw_body.get("payload") or {})
        expected_updated_at = str(raw_body.get("expected_updated_at") or "")
    else:
        payload = dict(raw_body or {})
        expected_updated_at = str(raw_body.get("expected_updated_at") or "")
        payload.pop("expected_updated_at", None)
    return ExtraUpsertRequest(payload=payload, expected_updated_at=expected_updated_at)


def assert_extra_collection_permission(
    name: str,
    device: dict[str, Any],
    payload: dict[str, Any] | None = None,
    current: dict[str, Any] | None = None,
) -> None:
    if name in ADMIN_ONLY_EXTRA_COLLECTIONS:
        permission = str(device.get("permission") or "")
        if permission not in {"管理者", "システム管理者"}:
            raise HTTPException(status_code=403, detail="Admin permission is required")
        return

    if name == "date_adjustments":
        if str(device.get("permission") or "") in {"管理者", "システム管理者"}:
            return
        member_id = str(device.get("member_id") or "")
        member_name = str(device.get("member_name") or "")
        target = current or payload or {}
        owner_id = str(target.get("member_id") or "")
        owner_name = str(target.get("created_by") or "")
        if member_id and owner_id and member_id == owner_id:
            return
        if member_name and owner_name and member_name == owner_name:
            return
        raise HTTPException(status_code=403, detail="Only owner can modify date adjustment")

    if name == "date_adjustment_responses":
        if str(device.get("permission") or "") in {"管理者", "システム管理者"}:
            return
        member_id = str(device.get("member_id") or "")
        member_name = str(device.get("member_name") or "")
        target = current or payload or {}
        owner_id = str(target.get("member_id") or "")
        owner_name = str(target.get("name") or "")
        if member_id and owner_id and member_id == owner_id:
            return
        if member_name and owner_name and member_name == owner_name:
            return
        raise HTTPException(status_code=403, detail="Only owner can modify response")

    if name in {"absences", "event_responses"}:
        if str(device.get("permission") or "") in {"管理者", "システム管理者"}:
            return
        member_id = str(device.get("member_id") or "")
        member_name = str(device.get("member_name") or "")
        target = current or payload or {}
        owner_id = str(target.get("member_id") or "")
        owner_name = str(target.get("name") or "")
        if member_id and owner_id and member_id == owner_id:
            return
        if member_name and owner_name and member_name == owner_name:
            return
        raise HTTPException(status_code=403, detail="Only owner can modify this record")


def normalize_extra_payload(
    payload: dict[str, Any],
    *,
    next_updated_at_func: Callable[[Any], str],
    item_id: int | None = None,
    current: dict[str, Any] | None = None,
) -> dict[str, Any]:
    now = next_updated_at_func((current or {}).get("updated_at"))
    data = dict(payload or {})
    data.update(
        {
            "id": item_id if item_id is not None else data.get("id"),
            "created_at": (current or {}).get("created_at") or data.get("created_at") or now,
            "updated_at": now,
        }
    )
    return data


async def read_json_body(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        data = {}
    return data if isinstance(data, dict) else {}


def collection_items(name: str, load_json_data_func: Callable[[str], list[dict[str, Any]]]) -> list[dict[str, Any]]:
    if name not in EXTRA_COLLECTIONS:
        raise HTTPException(status_code=404, detail="Collection not found")
    return load_json_data_func(name)
