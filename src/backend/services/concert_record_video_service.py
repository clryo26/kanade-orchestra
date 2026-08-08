from __future__ import annotations

from typing import Any


CONCERT_RECORD_TITLE_PREFIX = "【福岡奏オーケストラ】"


def clean_concert_record_title(title: str) -> str:
    return str(title or "").replace(CONCERT_RECORD_TITLE_PREFIX, "").strip()


def sort_concert_record_videos(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        (item for item in items if isinstance(item, dict)),
        key=lambda item: (
            int(item.get("performance_id") or 0),
            int(item.get("sort_order") or 0),
            int(item.get("id") or 0),
        ),
    )


def performance_concert_record_videos(
    items: list[dict[str, Any]],
    performance_id: Any,
) -> list[dict[str, Any]]:
    normalized_performance_id = str(performance_id or "")
    return [
        item
        for item in sort_concert_record_videos(items)
        if str(item.get("performance_id") or "") == normalized_performance_id
    ]


def renumber_concert_record_sort_orders(
    items: list[dict[str, Any]],
    performance_id: Any,
) -> None:
    normalized_performance_id = str(performance_id or "")
    sort_order = 1
    for item in sort_concert_record_videos(items):
        if str(item.get("performance_id") or "") != normalized_performance_id:
            continue
        item["sort_order"] = sort_order
        sort_order += 1


def append_concert_record_sort_order(
    items: list[dict[str, Any]],
    performance_id: Any,
) -> int:
    normalized_performance_id = str(performance_id or "")
    max_sort_order = 0
    for item in items:
        if str(item.get("performance_id") or "") != normalized_performance_id:
            continue
        try:
            max_sort_order = max(max_sort_order, int(item.get("sort_order") or 0))
        except (TypeError, ValueError):
            continue
    return max_sort_order + 1
