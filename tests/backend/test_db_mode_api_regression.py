from __future__ import annotations

import pytest

pytestmark = pytest.mark.db_profile


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


def test_db_mode_bootstrap_core_and_full_read_from_db(client, backend_env, monkeypatch):
    db_store = {
        "performances": [{"id": 1, "title": "Concert", "date": "2026-07-01", "open_time": "17:00", "start_time": "18:00", "venue": "Hall", "conductor": "Cond"}],
        "schedules": [{"id": 1, "date": "2026-06-30", "venue": "Studio"}],
        "announcements": [{"id": 1, "date": "2026-06-29", "content": "Notice"}],
        "events": [{"id": 1, "title": "Event-1"}],
        "members": [{"id": 1, "name": "Admin", "part": "Vn", "permission": "管理者"}],
        "auth_devices": [{"id": 1, "device_id": "dev-admin", "member_id": 1, "member_name": "Admin", "permission": "管理者", "authenticated_at": "2026-06-29T00:00:00", "last_seen_at": "2026-06-29T00:00:00"}],
        "absences": [{"id": 1, "schedule_id": 1, "member_id": 1, "name": "Admin", "status": "ng"}],
        "event_responses": [{"id": 1, "event_id": 1, "member_id": 1, "name": "Admin", "status": "ok"}],
        "date_adjustments": [],
        "date_adjustment_responses": [],
        "sheet_library": [],
        "payments": [{"id": 1, "member_id": 1, "paid_until_month": "2026-06"}],
        "castings": [],
        "piece_infos": [{"id": 1, "performance_id": 1, "piece": "Sym", "description": "desc"}],
        "practice_instructions": [],
        "albums": [],
        "part_settings": [{"id": 1, "name": "Vn", "sort_order": 1, "is_active": True}],
        "venue_settings": [],
        "flyer_distributions": [],
        "flyer_distribution_assignments": [],
        "org_settings": [{"id": 1, "name": "Kanade"}],
        "sns_settings": [],
        "connection_settings": [],
        "desired_pieces": [],
        "promotions": [{"id": 1, "title": "Promo"}],
        "drive_files": [],
        "recording_metadata": [],
    }
    _enable_db_mode(backend_env, monkeypatch, db_store)

    core = client.get("/api/bootstrap-core")
    assert core.status_code == 200
    core_payload = core.json()
    assert core_payload["extras"] == {}
    assert "events" not in core_payload
    assert "members" not in core_payload
    assert "auth_devices" not in core_payload

    full = client.get("/api/bootstrap")
    assert full.status_code == 200
    full_payload = full.json()
    assert full_payload["events"][0]["title"] == "Event-1"
    assert full_payload["extras"]["promotions"][0]["title"] == "Promo"


def test_db_mode_master_and_extra_crud_persist_to_db(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 1,
                "name": "Admin",
                "last_name": "",
                "first_name": "",
                "part": "Vn",
                "password": "pw-admin",
                "permission": "管理者",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "system_access_until": "",
            },
            {
                "id": 2,
                "name": "User",
                "last_name": "",
                "first_name": "",
                "part": "Va",
                "password": "pw-user",
                "permission": "一般",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "system_access_until": "",
            },
        ],
        "auth_devices": [
            {
                "id": 1,
                "device_id": "dev-admin",
                "member_id": 1,
                "member_name": "Admin",
                "member_part": "Vn",
                "permission": "管理者",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "authenticated_at": "2026-06-29T00:00:00",
                "last_seen_at": "2026-06-29T00:00:00",
            },
            {
                "id": 2,
                "device_id": "dev-user",
                "member_id": 2,
                "member_name": "User",
                "member_part": "Va",
                "permission": "一般",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "authenticated_at": "2026-06-29T00:00:00",
                "last_seen_at": "2026-06-29T00:00:00",
            },
        ],
        "performances": [],
        "schedules": [],
        "announcements": [],
        "events": [],
        "absences": [],
        "org_settings": [],
    }
    _enable_db_mode(backend_env, monkeypatch, db_store)

    admin_headers = {"X-Device-Id": "dev-admin"}
    user_headers = {"X-Device-Id": "dev-user"}

    created_perf = client.post(
        "/api/performances",
        headers=admin_headers,
        json={
            "title": "Perf-DB",
            "date": "2026-07-01",
            "open_time": "17:00",
            "start_time": "18:00",
            "venue": "Hall",
            "conductor": "Cond",
            "pieces": [],
        },
    )
    assert created_perf.status_code == 200
    perf_id = created_perf.json()["id"]
    assert any(item.get("id") == perf_id for item in db_store["performances"])

    updated_perf = client.put(
        f"/api/performances/{perf_id}",
        headers=admin_headers,
        json={
            "title": "Perf-DB-Updated",
            "date": "2026-07-02",
            "open_time": "17:30",
            "start_time": "18:30",
            "venue": "Hall-2",
            "conductor": "Cond-2",
            "pieces": [],
        },
    )
    assert updated_perf.status_code == 200
    assert updated_perf.json()["title"] == "Perf-DB-Updated"

    created_schedule = client.post(
        "/api/schedules",
        headers=admin_headers,
        json={
            "date": "2026-07-03",
            "venue": "Studio",
            "time": "",
            "open_time": "",
            "start_time": "10:00",
            "end_time": "12:00",
        },
    )
    assert created_schedule.status_code == 200

    created_announcement = client.post(
        "/api/announcements",
        headers=admin_headers,
        json={
            "date": "2026-07-04",
            "title": "Ann",
            "content": "Announcement",
        },
    )
    assert created_announcement.status_code == 200

    created_event = client.post(
        "/api/events",
        headers=admin_headers,
        json={
            "title": "Event-DB",
        },
    )
    assert created_event.status_code == 200

    created_org = client.post(
        "/api/extra/org_settings",
        headers=admin_headers,
        json={
            "name": "Kanade Orchestra",
            "short_name": "Kanade",
        },
    )
    assert created_org.status_code == 200
    org_id = created_org.json()["id"]

    updated_org = client.put(
        f"/api/extra/org_settings/{org_id}",
        headers=admin_headers,
        json={
            "name": "Kanade Orchestra Updated",
            "short_name": "Kanade",
        },
    )
    assert updated_org.status_code == 200

    created_performance_day = client.post(
        "/api/extra/performance_day_infos",
        headers=admin_headers,
        json={
            "performance_id": str(perf_id),
            "timeline": "09:00 集合",
            "timeline_rows": [{"start_time": "09:00", "content": "集合"}],
            "costume_detail": {"male": {"upper": "黒"}, "female": {"upper": "黒"}},
            "costume": "黒衣装",
            "assignments_rows": [{"role": "受付", "members": "田中"}],
            "assignments": "受付: 田中",
            "timetable": "09:00 集合",
            "duties": "受付: 田中",
        },
    )
    assert created_performance_day.status_code == 200
    assert db_store["performance_day_infos"][0]["assignments_rows"] == [{"role": "受付", "members": "田中"}]

    created_absence = client.post(
        "/api/extra/absences",
        headers=user_headers,
        json={
            "schedule_id": created_schedule.json()["id"],
            "member_id": 2,
            "name": "User",
            "status": "ng",
        },
    )
    assert created_absence.status_code == 200
    absence_id = created_absence.json()["id"]

    deleted_absence = client.delete(
        f"/api/extra/absences/{absence_id}",
        headers=user_headers,
    )
    assert deleted_absence.status_code == 200

    deleted_perf = client.delete(
        f"/api/performances/{perf_id}",
        headers=admin_headers,
    )
    assert deleted_perf.status_code == 200
    assert all(item.get("id") != perf_id for item in db_store["performances"])


def test_db_mode_admin_extra_save_endpoints_persist_to_db(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 1,
                "name": "Admin",
                "last_name": "",
                "first_name": "",
                "part": "Vn",
                "password": "pw-admin",
                "permission": "管理者",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "system_access_until": "",
            }
        ],
        "auth_devices": [
            {
                "id": 1,
                "device_id": "dev-admin",
                "member_id": 1,
                "member_name": "Admin",
                "member_part": "Vn",
                "permission": "管理者",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "authenticated_at": "2026-06-29T00:00:00",
                "last_seen_at": "2026-06-29T00:00:00",
            }
        ],
        "performances": [{"id": 10, "title": "Concert", "date": "2026-07-01"}],
        "schedules": [{"id": 20, "date": "2026-06-30", "venue": "Studio"}],
        "announcements": [],
        "events": [{"id": 30, "title": "Event"}],
        "absences": [],
        "event_responses": [],
        "date_adjustments": [],
        "date_adjustment_responses": [],
        "sheet_library": [],
        "payments": [],
        "castings": [],
        "piece_infos": [],
        "practice_instructions": [],
        "performance_day_infos": [],
        "albums": [],
        "part_settings": [],
        "venue_settings": [],
        "org_settings": [],
        "sns_settings": [],
        "connection_settings": [],
        "desired_pieces": [],
        "promotions": [],
        "drive_files": [],
        "recording_metadata": [],
    }
    _enable_db_mode(backend_env, monkeypatch, db_store)
    headers = {"X-Device-Id": "dev-admin"}

    payloads = {
        "absences": {"schedule_id": 20, "member_id": 1, "name": "Admin", "status": "ng", "note": "late"},
        "event_responses": {"event_id": 30, "member_id": 1, "name": "Admin", "status": "ok", "note": ""},
        "date_adjustments": {
            "title": "候補日",
            "candidates": [{"id": "cand-1", "date": "2026-07-10", "start_time": "18:00", "end_time": "21:00"}],
            "created_by": "Admin",
            "member_id": 1,
        },
        "date_adjustment_responses": {"adjustment_id": 1, "candidate_id": "cand-1", "member_id": 1, "name": "Admin", "status": "ok"},
        "sheet_library": {"performance_id": 10, "performance_title": "Concert", "piece": "Sym", "part": "Vn", "name": "sym.pdf"},
        "payments": {"member_id": 1, "name": "Admin", "paid_until_month": "2026-07", "performance_fees": {"10": True}},
        "castings": {"performance_id": 10, "piece": "Sym", "members": [{"member_id": 1, "part": "Vn"}], "extras": []},
        "piece_infos": {"performance_id": 10, "piece": "Sym", "description": "note"},
        "practice_instructions": {"performance_id": 10, "piece": "Sym", "practice_notes": "note"},
        "performance_day_infos": {"performance_id": 10, "timeline": "09:00 集合", "assignments_rows": [{"role": "受付", "members": "Admin"}]},
        "albums": {"event_name": "Concert Album", "created_by_member_id": 1, "created_by_member_name": "Admin"},
        "part_settings": {"name": "Violin", "display_order": 1, "is_active": True},
        "venue_settings": {"name": "Hall", "for_practice": True, "for_performance": True, "sort_order": 1},
        "org_settings": {"name": "Kanade Orchestra", "short_name": "Kanade", "membership_fee_amount": 1000},
        "sns_settings": {"x_url": "https://example.com/x", "extra_links": [{"label": "Web", "url": "https://example.com"}]},
        "connection_settings": {"google_cloud_storage_bucket": "bucket", "google_cloud_storage_data_prefix": "app-data"},
        "desired_pieces": {"title": "Request", "piece": "Sym", "member_id": 1, "registered_by": "Admin", "votes": []},
        "promotions": {"title": "Promo", "summary": "summary", "member_id": 1, "registered_by": "Admin"},
    }

    for collection, payload in payloads.items():
        created = client.post(f"/api/extra/{collection}", headers=headers, json=payload)
        assert created.status_code == 200, collection
        item = created.json()
        updated = client.put(f"/api/extra/{collection}/{item['id']}", headers=headers, json={**payload, "id": item["id"]})
        assert updated.status_code == 200, collection
        assert db_store[collection], collection
