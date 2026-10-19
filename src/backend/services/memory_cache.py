from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any, Callable

from ..core.tenant_context import get_current_tenant_id
from ..utils.datetime_utils import API_DATETIME_FORMAT_VERSION


class MemoryCache:
    """In-memory cache for JSON collections and frequently used indexes.

    Every entry (data, ETag, index) is keyed by ``(tenant_id, name)`` using the
    request's tenant context (JST spec R09/C05). A single-tenant database is
    not a reason to share entries: the tenant comes from a request header, so
    sharing would let one tenant's cached list answer another tenant's
    request. ``clear``/``invalidate`` affect the current tenant only;
    ``clear_all_tenants`` is the explicit operations path.

    ETags include the API date/time representation version so a payload
    cached in the old format is never revalidated with 304.
    """

    def __init__(self, member_login_names: Callable[[dict[str, Any]], Iterable[str]] | None = None):
        self._cache: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self._etags: dict[tuple[str, str], str] = {}
        self._indexes: dict[tuple[str, str], dict[str, dict[Any, Any]]] = {}
        self._member_login_names = member_login_names

    @staticmethod
    def _key(name: str) -> tuple[str, str]:
        return (get_current_tenant_id(), name)

    def invalidate(self, name: str | None = None) -> None:
        self.clear(name)

    def get(self, name: str) -> list[dict[str, Any]] | None:
        """Return cached collection data for the current tenant."""
        return self._cache.get(self._key(name))

    def set(self, name: str, data: list[dict[str, Any]]) -> None:
        """Cache collection data for the current tenant and update its ETag."""
        key = self._key(name)
        json_str = json.dumps(data, ensure_ascii=False, sort_keys=True)
        etag_source = f"{API_DATETIME_FORMAT_VERSION}\n{key[0]}\n{json_str}"
        self._cache[key] = data
        self._etags[key] = hashlib.sha256(etag_source.encode()).hexdigest()
        self._indexes.pop(key, None)

    def clear(self, name: str | None = None) -> None:
        """Clear one collection, or all collections, of the current tenant."""
        tenant_id = get_current_tenant_id()
        if name:
            key = (tenant_id, name)
            self._cache.pop(key, None)
            self._etags.pop(key, None)
            self._indexes.pop(key, None)
            return
        keys = set(self._cache) | set(self._etags) | set(self._indexes)
        for key in keys:
            if key[0] == tenant_id:
                self._cache.pop(key, None)
                self._etags.pop(key, None)
                self._indexes.pop(key, None)

    def clear_all_tenants(self) -> None:
        """Operations path (manual cache clear): drop every tenant's entries."""
        self._cache.clear()
        self._etags.clear()
        self._indexes.clear()

    def etag(self, name: str) -> str | None:
        """Return the cached ETag for a collection of the current tenant."""
        return self._etags.get(self._key(name))

    def get_index(self, name: str, index_type: str = "id") -> dict[str, Any] | None:
        """Return a cached index for a collection of the current tenant."""
        key = self._key(name)
        data = self._cache.get(key)
        if not data:
            return None

        per_name_indexes = self._indexes.setdefault(key, {})
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
