from __future__ import annotations

from collections.abc import Callable
from typing import Any, cast

from ..core.storage_gateway import load_json_data, save_json_data
from ..utils.collection_utils import find_item, next_id


def _row_store() -> Any:
    # Resolved per call: DB mode -> PostgreSQL row store, explicit local JSON
    # mode -> list adapter. Tests swap app_core.db_row_store.
    from ..core.compat_gateway import row_store

    return row_store()


def _allow_all(_current: dict[str, Any]) -> None:
    return None


class BaseRepository:
    """Compatibility-first repository base.

    Reads keep the cached collection API. Writes are row level (JST spec
    R05): only the target row and its children are written, the version is
    generated from the DB clock after the row lock, and a stale list can no
    longer overwrite other rows.
    """

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
        # id/created_at/updated_at are server managed (allocated in the store).
        return cast(dict[str, Any], _row_store().insert(self.collection_name, lambda _new_id: dict(payload)))

    def update(
        self,
        item_id: int,
        mutator: Callable[[dict[str, Any]], dict[str, Any]],
        *,
        expected_updated_at: str | None = None,
    ) -> dict[str, Any]:
        # created_at is immutable and updated_at comes from the store; values
        # in the mutator's result for these keys are ignored.
        return cast(
            dict[str, Any],
            _row_store().update(self.collection_name, item_id, mutator, expected_updated_at=expected_updated_at),
        )

    def delete(self, item_id: int, authorize: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        return cast(dict[str, Any], _row_store().delete(self.collection_name, item_id, authorize or _allow_all))
