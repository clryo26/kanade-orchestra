from __future__ import annotations

from datetime import datetime
from typing import Any


def _access_log_sort_key(item: dict[str, Any]) -> tuple[float, str]:
    value = str(item.get("accessed_at") or item.get("created_at") or "").strip()
    if not value:
        return (float("-inf"), "")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (parsed.timestamp(), value)
    except ValueError:
        return (float("-inf"), value)


def create_access_log_payload(
    *,
    body: dict[str, Any],
    device: dict[str, Any],
    x_device_id: str,
    user_agent: str,
    now: str,
    next_id: int | None,
) -> dict[str, Any]:
    payload = {
        "member_id": device.get("member_id"),
        "member_name": device.get("member_name") or "",
        "member_part": device.get("member_part") or "",
        "permission": device.get("permission") or "",
        "menu_key": str(body.get("menu_key") or "").strip(),
        "menu_label": str(body.get("menu_label") or "").strip(),
        "panel": str(body.get("panel") or "").strip(),
        "device_id": device.get("device_id") or x_device_id,
        "device_name": device.get("device_name") or "",
        "user_agent": device.get("user_agent") or user_agent,
        "accessed_at": now,
        "created_at": now,
        "updated_at": now,
    }
    if next_id is not None:
        payload["id"] = next_id
    return payload


def trim_access_logs(items: list[dict[str, Any]], max_items: int = 2000) -> list[dict[str, Any]]:
    return sorted(items, key=_access_log_sort_key)[-max_items:]


def list_access_logs(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    safe_limit = min(max(int(limit or 200), 1), 1000)
    return sorted(items, key=_access_log_sort_key, reverse=True)[:safe_limit]


def search_access_logs(
    items: list[dict[str, Any]],
    *,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    member_id: int | None = None,
    member_part: str = "",
    page: int = 1,
) -> dict[str, Any]:
    page_size = 100
    from_timestamp = date_from.timestamp() if date_from is not None else None
    to_timestamp = date_to.timestamp() if date_to is not None else None
    normalized_part = str(member_part or "").strip()
    normalized_member_id = str(member_id) if member_id is not None else ""

    filtered: list[dict[str, Any]] = []
    for item in items:
        timestamp = _access_log_sort_key(item)[0]
        if from_timestamp is not None and timestamp < from_timestamp:
            continue
        if to_timestamp is not None and timestamp >= to_timestamp:
            continue
        if normalized_member_id and str(item.get("member_id") or "") != normalized_member_id:
            continue
        if normalized_part and str(item.get("member_part") or "") != normalized_part:
            continue
        filtered.append(item)

    filtered.sort(
        key=lambda item: (*_access_log_sort_key(item), int(item.get("id") or 0)),
        reverse=True,
    )
    total = len(filtered)
    total_pages = max((total + page_size - 1) // page_size, 1)
    safe_page = min(max(int(page or 1), 1), total_pages)
    start = (safe_page - 1) * page_size
    end = start + page_size

    return {
        "items": filtered[start:end],
        "page": safe_page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages,
    }
