from __future__ import annotations

from typing import Any


def create_access_log_payload(
    *,
    body: dict[str, Any],
    device: dict[str, Any],
    x_device_id: str,
    user_agent: str,
    now: str,
    next_id: int,
) -> dict[str, Any]:
    return {
        "id": next_id,
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


def trim_access_logs(items: list[dict[str, Any]], max_items: int = 2000) -> list[dict[str, Any]]:
    return sorted(items, key=lambda item: str(item.get("accessed_at") or item.get("created_at") or ""))[-max_items:]


def list_access_logs(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    safe_limit = min(max(int(limit or 200), 1), 1000)
    return sorted(
        items,
        key=lambda item: str(item.get("accessed_at") or item.get("created_at") or ""),
        reverse=True,
    )[:safe_limit]
