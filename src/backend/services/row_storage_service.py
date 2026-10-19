"""Row/list storage wiring behind the app_core compatibility facade.

Runtime callbacks are resolved lazily so existing path overrides and tests
patching app_core DB functions keep working. Business locking lives here,
not in the facade (JST R05 and the existing app_core size boundary).
"""
from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any, cast

from ..repositories.db_item_repository import ListRowStore, PostgresRowStore
from ..repositories.db_json_repository import mutate_collection_locked


_postgres = PostgresRowStore()
_local_list_locks: dict[str, Any] = {}


def bind_row_storage(runtime: Callable[[], Any]) -> tuple[Callable[..., Any], ...]:
    def local(api: Any) -> bool:
        return bool(api.effective_local_json_fallback_enabled(
            db_data_enabled=api.db_data_enabled,
            db_expected=api.db_expected,
            local_json_fallback_enabled=api.local_json_fallback_enabled,
        ))

    def db_row_store() -> PostgresRowStore:
        return _postgres

    def db_mutate_collection_locked(name: str, mutator: Any) -> list[dict[str, Any]]:
        return cast(list[dict[str, Any]], mutate_collection_locked(name, mutator))

    def mutate_json_data(name: str, mutator: Any) -> list[dict[str, Any]]:
        api = runtime()
        if not local(api):
            return cast(list[dict[str, Any]], api.db_mutate_collection_locked(name, mutator))
        lock = _local_list_locks.setdefault(name, threading.RLock())
        with lock:
            updated = list(mutator([dict(item) for item in api.load_json_data(name)]))
            api.save_json_data(name, updated)
            return updated

    def row_store() -> PostgresRowStore | ListRowStore:
        api = runtime()
        if local(api):
            return ListRowStore(load=api.load_json_data, save=api.save_json_data)
        return cast(PostgresRowStore | ListRowStore, api.db_row_store())

    return db_row_store, db_mutate_collection_locked, mutate_json_data, row_store
