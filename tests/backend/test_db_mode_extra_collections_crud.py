from __future__ import annotations

import pytest


pytestmark = pytest.mark.db_profile


TARGET_COLLECTIONS = (
    "performance_day_infos",
    "piece_infos",
    "practice_instructions",
    "part_settings",
    "venue_settings",
    "flyer_distributions",
    "flyer_distribution_assignments",
    "org_settings",
    "sns_settings",
    "connection_settings",
    "desired_pieces",
    "promotions",
    "albums",
)


def _copy_rows(rows):
    return [dict(item) for item in rows]


def _enable_db_mode(backend_env, monkeypatch, db_store):
    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_load_json_data", lambda name: _copy_rows(db_store.get(name, [])))

    def fake_replace(name, data):
        db_store[name] = _copy_rows(data)

    monkeypatch.setattr(backend_env, "db_replace_collection", fake_replace)
    monkeypatch.setattr(backend_env, "storage_enabled", lambda: False)
    backend_env._memory_cache.clear()


def _seed_admin(db_store):
    db_store["members"] = [
        {
            "id": 1,
            "name": "Admin",
            "part": "Vn",
            "password": "pw-admin",
            "permission": "管理者",
            "is_recording_manager": True,
            "is_sheet_manager": True,
            "system_access_until": "",
        }
    ]
    db_store["auth_devices"] = [
        {
            "id": 1,
            "device_id": "dev-admin",
            "member_id": 1,
            "member_name": "Admin",
            "member_part": "Vn",
            "permission": "管理者",
            "is_recording_manager": True,
            "is_sheet_manager": True,
            "authenticated_at": "2026-07-01T00:00:00",
            "last_seen_at": "2026-07-01T00:00:00",
        }
    ]


def _create_payload(collection_name: str) -> dict:
    if collection_name == "performance_day_infos":
        return {
            "performance_id": 1,
            "timeline": "10:00-11:00 リハーサル",
            "timeline_rows": [{"sort_order": 1, "start_time": "10:00", "end_time": "11:00", "content": "リハーサル"}],
            "costume_detail": {"male": {"upper": "黒", "lower": "黒", "other": ""}, "female": {"upper": "黒", "lower": "黒", "other": ""}},
            "assignments_rows": [{"role": "受付", "members": "山田"}],
            "assignments": "受付: 山田",
        }
    if collection_name == "piece_infos":
        return {"performance_id": 1, "piece": "Symphony", "description": "desc"}
    if collection_name == "practice_instructions":
        return {"performance_id": 1, "piece": "Symphony", "practice_notes": "notes"}
    if collection_name == "part_settings":
        return {"name": "Violin", "display_order": 1, "is_active": True}
    if collection_name == "venue_settings":
        return {"name": "Hall A", "for_practice": True, "for_performance": False, "notes": "memo", "display_order": 1}
    if collection_name == "flyer_distributions":
        return {"facility_name": "Store A", "area_address": "Fukuoka", "note": "memo"}
    if collection_name == "flyer_distribution_assignments":
        return {
            "performance_id": 1,
            "flyer_distribution_id": 1,
            "distributed_member_id": 1,
            "distributed_member_name": "Admin",
            "distributed_date": "2026-07-07",
            "note": "初回配布\n入口付近",
        }
    if collection_name == "org_settings":
        return {"name": "Kanade", "short_name": "K", "organization_name": "Kanade", "organization_abbreviation": "K"}
    if collection_name == "sns_settings":
        return {
            "line_url": "https://line.example",
            "x_url": "https://x.example",
            "instagram_url": "https://ig.example",
            "youtube_url": "https://yt.example",
            "facebook_url": "https://fb.example",
            "website_url": "https://site.example",
            "extra_links": [{"label": "blog", "url": "https://blog.example"}],
        }
    if collection_name == "connection_settings":
        return {
            "google_project_id": "proj",
            "google_cloud_storage_bucket": "bucket",
            "google_cloud_storage_data_prefix": "app-data",
            "google_cloud_storage_public": "false",
            "google_service_account_file": "",
            "google_service_account_json": "",
        }
    if collection_name == "desired_pieces":
        return {
            "title": "Wish",
            "piece": "Symphony No.5",
            "composer": "Beethoven",
            "duration": "30",
            "genre": "Classic",
            "formation": "Orchestra",
            "notes": "memo",
            "member_id": 1,
            "registered_by": "Admin",
        }
    if collection_name == "promotions":
        return {"title": "Promo", "summary": "summary", "image_url": "https://img.example/a.png", "member_id": 1, "registered_by": "Admin"}
    if collection_name == "albums":
        return {"event_name": "Concert 2026", "created_by_member_id": 1, "created_by_member_name": "Admin"}
    raise AssertionError(f"Unsupported collection for test: {collection_name}")


@pytest.mark.parametrize("collection_name", TARGET_COLLECTIONS)
def test_db_mode_extra_collection_crud_roundtrip(client, backend_env, monkeypatch, collection_name):
    db_store = {name: [] for name in backend_env.JSON_COLLECTION_TABLES.keys()}
    _seed_admin(db_store)
    _enable_db_mode(backend_env, monkeypatch, db_store)

    headers = {"X-Device-Id": "dev-admin"}
    create_payload = _create_payload(collection_name)

    created = client.post(f"/api/extra/{collection_name}", headers=headers, json=create_payload)
    assert created.status_code == 200
    created_item = created.json()
    item_id = created_item["id"]
    if collection_name == "flyer_distribution_assignments":
        assert created_item.get("note") == "初回配布\n入口付近"

    updated_payload = dict(create_payload)
    if collection_name == "piece_infos":
        updated_payload["description"] = "updated desc"
    elif collection_name == "practice_instructions":
        updated_payload["practice_notes"] = "updated notes"
    elif collection_name == "part_settings":
        updated_payload["name"] = "Viola"
    elif collection_name == "venue_settings":
        updated_payload["name"] = "Hall B"
    elif collection_name == "flyer_distributions":
        updated_payload["facility_name"] = "Store B"
    elif collection_name == "flyer_distribution_assignments":
        updated_payload["note"] = ""
    elif collection_name == "org_settings":
        updated_payload["name"] = "Kanade Updated"
        updated_payload["organization_name"] = "Kanade Updated"
    elif collection_name == "sns_settings":
        updated_payload["website_url"] = "https://site.example/updated"
    elif collection_name == "connection_settings":
        updated_payload["google_cloud_storage_bucket"] = "bucket-updated"
    elif collection_name == "desired_pieces":
        updated_payload["notes"] = "updated"
    elif collection_name == "promotions":
        updated_payload["summary"] = "updated summary"
    elif collection_name == "albums":
        updated_payload["event_name"] = "Concert 2026 Updated"
    elif collection_name == "performance_day_infos":
        updated_payload["assignments"] = "受付: 佐藤"

    updated = client.put(f"/api/extra/{collection_name}/{item_id}", headers=headers, json=updated_payload)
    assert updated.status_code == 200

    listed = client.get(f"/api/extra/{collection_name}", headers=headers)
    assert listed.status_code == 200
    listed_rows = listed.json()
    assert any(str(item.get("id")) == str(item_id) for item in listed_rows)
    if collection_name == "flyer_distribution_assignments":
        assignment = next(item for item in listed_rows if str(item.get("id")) == str(item_id))
        assert "note" in assignment
        assert assignment.get("note") == ""

    deleted = client.delete(f"/api/extra/{collection_name}/{item_id}", headers=headers)
    assert deleted.status_code == 200

    listed_after_delete = client.get(f"/api/extra/{collection_name}", headers=headers)
    assert listed_after_delete.status_code == 200
    assert all(str(item.get("id")) != str(item_id) for item in listed_after_delete.json())
