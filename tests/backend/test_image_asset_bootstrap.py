from __future__ import annotations

import pytest

pytestmark = pytest.mark.db_profile


def _copy_rows(rows):
    return [dict(item) for item in rows]


def _enable_db_mode(backend_env, monkeypatch, db_store):
    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_load_json_data", lambda name: _copy_rows(db_store.get(name, [])))
    monkeypatch.setattr(backend_env, "storage_enabled", lambda: False)
    backend_env._memory_cache.clear()


def test_bootstrap_rewrites_inline_image_fields(client, backend_env, monkeypatch):
    db_store = {
        "performances": [
            {
                "id": 1,
                "title": "Concert",
                "date": "2026-07-01",
                "open_time": "17:00",
                "start_time": "18:00",
                "venue": "Hall",
                "conductor": "Cond",
                "flyer_image": "data:image/png;base64,ZmFrZQ==",
            }
        ],
        "members": [
            {
                "id": 1,
                "name": "Admin",
                "part": "Vn",
                "photo_url": "data:image/png;base64,ZmFrZQ==",
                "permission": "邂｡逅・・",
            }
        ],
        "promotions": [
            {
                "id": 1,
                "title": "Promo",
                "summary": "summary",
                "image_url": "data:image/png;base64,ZmFrZQ==",
                "member_id": 1,
                "registered_by": "Admin",
            }
        ],
        "schedules": [],
        "announcements": [],
        "events": [],
        "auth_devices": [
            {
                "id": 1,
                "device_id": "dev-admin",
                "member_id": 1,
                "member_name": "Admin",
                "permission": "邂｡逅・・",
                "authenticated_at": "2026-06-29T00:00:00",
                "last_seen_at": "2026-06-29T00:00:00",
            }
        ],
        "absences": [],
        "event_responses": [],
        "date_adjustments": [],
        "date_adjustment_responses": [],
        "payments": [],
        "castings": [],
        "piece_infos": [],
        "practice_instructions": [],
        "performance_day_infos": [],
        "albums": [],
        "part_settings": [],
        "venue_settings": [],
        "flyer_distributions": [],
        "flyer_distribution_assignments": [],
        "org_settings": [],
        "sns_settings": [],
        "connection_settings": [],
        "desired_pieces": [],
    }
    _enable_db_mode(backend_env, monkeypatch, db_store)

    response = client.get("/api/bootstrap")
    assert response.status_code == 200
    payload = response.json()

    assert payload["members"][0]["photo_url"].startswith("/api/members/1/photo")
    assert payload["performances"][0]["flyer_image"].startswith("/api/performances/1/flyer-image")
    assert "created_at" not in payload["performances"][0]
    assert "updated_at" not in payload["performances"][0]
    assert payload["extras"]["promotions"][0]["image_url"].startswith("/api/extra/promotions/1/image")
    assert "data:image" not in response.text


def test_member_photo_route_serves_legacy_inline_data(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 1,
                "name": "Admin",
                "part": "Vn",
                "photo_url": "data:image/png;base64,ZmFrZQ==",
                "permission": "邂｡逅・・",
            }
        ]
    }
    _enable_db_mode(backend_env, monkeypatch, db_store)

    response = client.get("/api/members/1/photo")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")
    assert response.content == b"fake"
