from __future__ import annotations

import json
import os
from pathlib import Path

import pytest


BEFORE = os.getenv("PORTAL_PERF_HTTP_PHASE") == "before"


@pytest.mark.parametrize("endpoint", ["performances", "schedules", "announcements", "events", "members"])
def test_list_revalidation_preserves_body_and_avoids_transfer(client, monkeypatch, endpoint):
    from src.backend.services import announcement_service, event_service, member_service, performance_service, schedule_service

    services = {
        "performances": (performance_service, "list_performances"),
        "schedules": (schedule_service, "list_schedules"),
        "announcements": (announcement_service, "list_announcements"),
        "events": (event_service, "list_events"),
        "members": (member_service, "list_members"),
    }
    module, name = services[endpoint]
    calls = []

    def build():
        calls.append(True)
        return []

    monkeypatch.setattr(module, name, build)
    url = f"/api/{endpoint}"
    first = client.get(url, headers={"X-Device-Id": "fixture-device", "Accept-Encoding": "identity"})
    second = client.get(url, headers={"X-Device-Id": "fixture-device", "If-None-Match": first.headers.get("ETag", '"unknown"'), "Accept-Encoding": "identity"})
    assert first.status_code == 200 and first.json() == []
    assert second.status_code == (200 if BEFORE else 304)
    assert len(calls) == 2  # body hashing does not remove data retrieval/building
    if not BEFORE:
        assert first.headers["Cache-Control"] == "private, no-cache"
        assert "X-Device-Id" in first.headers["Vary"]
        assert second.content == b""
    dest = os.getenv("PORTAL_PERF_HTTP_BACKEND_REPORT_DIR")
    if dest:
        target = Path(dest).resolve()
        root = Path(__file__).resolve().parents[2]
        assert target.is_relative_to(root / ".tmp")
        target.mkdir(parents=True, exist_ok=True)
        (target / f"{endpoint}.json").write_text(json.dumps({"endpoint": url, "phase": "before" if BEFORE else "after",
            "status": [first.status_code, second.status_code], "bytes": [len(first.content), len(second.content)],
            "service_builds": len(calls), "db_queries": None}), encoding="utf-8")


@pytest.mark.skipif(BEFORE, reason="after-contract test")
@pytest.mark.parametrize("candidate,expected", [
    ('"a"', True), ('W/"a"', True), ('"b", W/"a"', True),
    ('*', True), ('"b"', False), ('"a,b"', False), ('', False),
    ('W/ "a"', False), ('"a" trailing', False), ('"a", *', False),
])
def test_get_validator_weak_comparison(candidate, expected):
    from src.backend.core.http_cache import etag_matches

    assert etag_matches(candidate, 'W/"a"') is expected
    assert etag_matches('"other", W/"a,b"', '"a,b"')


@pytest.mark.skipif(BEFORE, reason="after-contract test")
def test_cache_scope_changed_body_and_gzip(client, monkeypatch):
    from src.backend.services import event_service

    # Keep the real response model/serialization; a long body exercises GZip.
    rows = [{"id": 1, "title": "event" * 400, "date": "2026-10-22"}]
    monkeypatch.setattr(event_service, "list_events", lambda: rows)
    first = client.get('/api/events', headers={'X-Device-Id': 'a', 'Accept-Encoding': 'identity'})
    assert first.status_code == 200
    compressed = client.get('/api/events', headers={'X-Device-Id': 'a', 'Accept-Encoding': 'gzip'})
    assert compressed.json() == first.json()
    assert compressed.headers['ETag'] == first.headers['ETag']
    assert compressed.headers['Content-Encoding'] == 'gzip'
    assert 'Accept-Encoding' in compressed.headers['Vary']
    tag = first.headers['ETag']
    for headers in [{'X-Device-Id': 'b'}, {'X-Device-Id': 'a', 'X-Tenant-Id': 'other'}]:
        result = client.get('/api/events', headers={**headers, 'If-None-Match': tag})
        assert result.status_code == 200
        assert result.headers['ETag'] != tag
    conditional = client.get('/api/events', headers={'X-Device-Id': 'a', 'If-None-Match': f'"other", {tag}'})
    assert conditional.status_code == 304 and not conditional.content
    assert conditional.headers['Cache-Control'] == 'private, no-cache'
    assert 'X-Device-Id' in conditional.headers['Vary']
    rows[0]['title'] = 'changed'
    assert client.get('/api/events', headers={'X-Device-Id': 'a', 'If-None-Match': tag}).status_code == 200


@pytest.mark.skipif(BEFORE, reason="after-contract test")
@pytest.mark.parametrize('url', [
    '/api/bootstrap', '/api/auth/devices/missing', '/api/portal-file-actor',
    '/api/portal-file-operations/missing', '/api/promotions/operations/missing',
])
def test_sensitive_gets_are_no_store_even_on_error(client, url):
    response = client.get(url)
    assert response.headers['Cache-Control'] == 'no-store'


@pytest.mark.skipif(BEFORE, reason="after-contract test")
def test_introduction_conditional_request_still_requires_auth(client, seed_device_fn):
    seed_device_fn(device_id='intro-http', permission='一般', member_name='fixture')
    headers = {'X-Device-Id': 'intro-http'}
    first = client.get('/api/member-introductions', headers=headers)
    tag = first.headers['ETag']
    response = client.get('/api/member-introductions', headers={**headers, 'If-None-Match': f'W/{tag}'})
    assert response.status_code == 304
    assert response.headers['Cache-Control'] == 'private, no-cache'
    assert client.get('/api/member-introductions', headers={'If-None-Match': '*'}).status_code == 401


@pytest.mark.skipif(BEFORE, reason="after-contract test")
def test_bootstrap_keeps_legacy_validator_and_private_headers(client):
    first = client.get('/api/bootstrap-core')
    tag = first.headers['ETag']
    assert first.status_code == 200
    assert first.headers['Cache-Control'] == 'private, no-cache'
    for candidate in (tag, f'W/"{tag}"', '*'):
        response = client.get('/api/bootstrap-core', headers={'If-None-Match': candidate})
        assert response.status_code == 304
        assert response.headers['Cache-Control'] == 'private, no-cache'
        assert 'X-Tenant-Id' in response.headers['Vary']
