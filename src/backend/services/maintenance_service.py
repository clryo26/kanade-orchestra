from __future__ import annotations

from datetime import datetime
from typing import Any


def fk_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def find_orphans(
    relations: tuple[tuple[str, str, str], ...],
    load_json_data,
) -> dict[str, Any]:
    grouped_orphans: dict[str, list[dict[str, Any]]] = {}
    for child_name, fk_key, parent_name in relations:
        children = load_json_data(child_name)
        parents = load_json_data(parent_name)

        parent_ids = {fk_int(item.get("id")) for item in parents}
        parent_ids.discard(None)

        for item in children:
            fk_value = fk_int(item.get(fk_key))
            if fk_value is None:
                continue
            if fk_value not in parent_ids:
                grouped_orphans.setdefault(child_name, []).append(item)

    summary = {name: len(items) for name, items in grouped_orphans.items()}
    total = sum(summary.values())
    return {
        "total": total,
        "summary": summary,
        "orphans": grouped_orphans,
        "checked_at": datetime.now().isoformat(),
    }
