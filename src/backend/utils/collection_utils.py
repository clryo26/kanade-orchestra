from __future__ import annotations

from typing import Any, Iterable, cast

from fastapi import HTTPException, Request
from fastapi.responses import Response


def next_id(items: list[dict[str, Any]]) -> int:
    return max((int(item.get("id", 0)) for item in items), default=0) + 1


def find_item(
    items: list[dict[str, Any]],
    item_id: int,
    *,
    cache: Any | None = None,
    cache_names: Iterable[str] = (),
) -> tuple[int, dict[str, Any]]:
    # Reuse the prebuilt cache index when this list instance is already cached.
    if cache is not None:
        for data_name in cache_names:
            if cache.get(data_name) is items:
                index_map = cache.get_index(data_name, "id")
                if index_map and item_id in index_map:
                    return cast(tuple[int, dict[str, Any]], index_map[item_id])

    for index, item in enumerate(items):
        if item.get("id") == item_id:
            return index, item
    raise HTTPException(status_code=404, detail="Data not found")


def check_etag(request: Request, data_name: str, *, cache: Any) -> Response | None:
    etag = cache.etag(data_name)
    if not etag:
        return None

    if_none_match = request.headers.get("if-none-match", "")
    if if_none_match == etag:
        return Response(status_code=304)
    return None