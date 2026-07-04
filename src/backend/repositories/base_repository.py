from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any, cast

from ..core.storage_gateway import load_json_data, save_json_data
from ..utils.collection_utils import find_item, next_id


class BaseRepository:
    """Compatibility-first repository base backed by storage gateway wrappers."""

    collection_name: str = ""

    def __init__(self, collection_name: str | None = None) -> None:
        if collection_name:
            self.collection_name = collection_name
        if not self.collection_name:
            raise ValueError("collection_name is required")

    def list_all(self) -> list[dict[str, Any]]:
        return cast(list[dict[str, Any]], load_json_data(self.collection_name))

    def save_all(self, items: list[dict[str, Any]]) -> None:
        save_json_data(self.collection_name, items)

    def next_id(self) -> int:
        return cast(int, next_id(self.list_all()))

    def find_by_id(self, item_id: int) -> tuple[int, dict[str, Any]]:
        return cast(tuple[int, dict[str, Any]], find_item(self.list_all(), item_id))

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        items = self.list_all()
        now = datetime.now().isoformat()
        new_item = {**payload, "id": next_id(items), "created_at": now, "updated_at": now}
        items.append(new_item)
        self.save_all(items)
        return new_item

    def update(self, item_id: int, mutator: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]:
        items = self.list_all()
        index, current = find_item(items, item_id)
        now = datetime.now().isoformat()
        updated = mutator(current)
        updated["id"] = item_id
        # created_at is immutable. Request payloads may include null, so keep
        # the stored value instead of letting null flow into DB NOT NULL columns.
        updated["created_at"] = current.get("created_at") or now
        updated["updated_at"] = now
        items[index] = updated
        self.save_all(items)
        return updated

    def delete(self, item_id: int) -> None:
        items = self.list_all()
        find_item(items, item_id)
        self.save_all([item for item in items if item.get("id") != item_id])
