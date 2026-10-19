"""JST spec R09/C05: per-tenant cache data, ETag, index and invalidation (T09/T14)."""
from __future__ import annotations

from contextlib import contextmanager

from src.backend.core.tenant_context import reset_current_tenant_id, set_current_tenant_id
from src.backend.services.memory_cache import MemoryCache


@contextmanager
def tenant(name: str):
    token = set_current_tenant_id(name)
    try:
        yield
    finally:
        reset_current_tenant_id(token)


def test_same_collection_name_is_isolated_per_tenant():
    cache = MemoryCache()
    with tenant("a"):
        cache.set("members", [{"id": 1, "name": "A"}])
    with tenant("b"):
        assert cache.get("members") is None
        assert cache.etag("members") is None
        assert cache.get_index("members") is None
        cache.set("members", [{"id": 1, "name": "B"}])
    with tenant("a"):
        assert cache.get("members") == [{"id": 1, "name": "A"}]
        assert cache.get_index("members")[1][1]["name"] == "A"
    with tenant("b"):
        assert cache.get_index("members")[1][1]["name"] == "B"


def test_same_data_has_different_etag_per_tenant():
    cache = MemoryCache()
    with tenant("a"):
        cache.set("events", [])
        etag_a = cache.etag("events")
    with tenant("b"):
        cache.set("events", [])
        etag_b = cache.etag("events")
    assert etag_a and etag_b and etag_a != etag_b


def test_invalidation_does_not_touch_other_tenants():
    cache = MemoryCache()
    for name in ("a", "b"):
        with tenant(name):
            cache.set("events", [{"id": 1}])
            cache.set("members", [{"id": 1}])
    with tenant("a"):
        cache.invalidate("events")
        assert cache.get("events") is None
        assert cache.get("members") is not None
        cache.clear()
        assert cache.get("members") is None
    with tenant("b"):
        assert cache.get("events") == [{"id": 1}]
        assert cache.get("members") == [{"id": 1}]


def test_explicit_all_tenant_clear_is_separate():
    cache = MemoryCache()
    for name in ("a", "b"):
        with tenant(name):
            cache.set("events", [{"id": 1}])
    cache.clear_all_tenants()
    for name in ("a", "b"):
        with tenant(name):
            assert cache.get("events") is None


def test_etag_changes_with_representation_version(monkeypatch):
    from src.backend.services import memory_cache as module

    cache = MemoryCache()
    cache.set("events", [{"id": 1}])
    before = cache.etag("events")
    monkeypatch.setattr(module, "API_DATETIME_FORMAT_VERSION", "next-format")
    cache.set("events", [{"id": 1}])
    assert cache.etag("events") != before
