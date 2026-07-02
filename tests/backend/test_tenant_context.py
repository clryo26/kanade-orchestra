from __future__ import annotations

from src.backend.core.tenant_context import (
    get_current_tenant_id,
    normalize_tenant_id,
    reset_current_tenant_id,
    set_current_tenant_id,
)


def test_normalize_tenant_id_uses_default_for_blank_values():
    assert normalize_tenant_id("") == "default"
    assert normalize_tenant_id(None) == "default"


def test_tenant_context_set_and_reset_roundtrip():
    before = get_current_tenant_id()
    token = set_current_tenant_id("org-alpha")
    try:
        assert get_current_tenant_id() == "org-alpha"
    finally:
        reset_current_tenant_id(token)

    assert get_current_tenant_id() == before


def test_middleware_sets_tenant_from_organization_header(client):
    response = client.get("/api/health", headers={"X-Organization-Id": "org-team-a"})

    assert response.status_code == 200
    assert response.headers.get("X-Tenant-Id") == "org-team-a"


def test_middleware_uses_default_tenant_when_header_missing(client):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.headers.get("X-Tenant-Id") == "default"
