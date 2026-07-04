from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any, Callable


class MemoryCache:
    """In-memory cache for JSON collections and frequently used indexes."""

    def __init__(self, member_login_names: Callable[[dict[str, Any]], Iterable[str]] | None = None):
        self._cache: dict[str, list[dict[str, Any]]] = {}
        self._etags: dict[str, str] = {}
        self._indexes: dict[str, dict[str, dict[Any, Any]]] = {}
        self._member_login_names = member_login_names

    def invalidate(self, name: str | None = None) -> None:
        self.clear(name)

    def get(self, name: str) -> list[dict[str, Any]] | None:
        """Return cached collection data."""
        return self._cache.get(name)

    def set(self, name: str, data: list[dict[str, Any]]) -> None:
        """Cache collection data and update its ETag."""
        self._cache[name] = data
        json_str = json.dumps(data, ensure_ascii=False, sort_keys=True)
        self._etags[name] = hashlib.sha256(json_str.encode()).hexdigest()
        self._indexes.pop(name, None)

    def clear(self, name: str | None = None) -> None:
        """Clear one collection cache or all cached collections."""
        if name:
            self._cache.pop(name, None)
            self._etags.pop(name, None)
            self._indexes.pop(name, None)
            return
        self._cache.clear()
        self._etags.clear()
        self._indexes.clear()

    def etag(self, name: str) -> str | None:
        """Return the cached ETag for a collection."""
        return self._etags.get(name)

    def get_index(self, name: str, index_type: str = "id") -> dict[str, Any] | None:
        """Return a cached index for a collection."""
        data = self._cache.get(name)
        if not data:
            return None

        per_name_indexes = self._indexes.setdefault(name, {})
        if index_type not in per_name_indexes:
            if index_type == "id":
                per_name_indexes[index_type] = {
                    item.get("id"): (idx, item) for idx, item in enumerate(data)
                }
            elif index_type == "member_login" and self._member_login_names is not None:
                member_index: dict[str, Any] = {}
                for idx, item in enumerate(data):
                    for name_variant in self._member_login_names(item):
                        member_index[name_variant] = (idx, item)
                per_name_indexes[index_type] = member_index
            else:
                return None

        return per_name_indexes.get(index_type)
