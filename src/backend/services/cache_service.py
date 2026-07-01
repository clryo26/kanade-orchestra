from __future__ import annotations

from ..services.memory_cache import MemoryCache


class CacheService:
    def __init__(self, cache: MemoryCache) -> None:
        self._cache = cache

    def get(self, key: str):
        return self._cache.get(key)

    def set(self, key: str, value) -> None:
        self._cache.set(key, value)

    def clear(self) -> None:
        self._cache.clear()
