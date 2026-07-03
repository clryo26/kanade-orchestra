from __future__ import annotations

import pytest

from src.backend.routers import bootstrap as bootstrap_router

pytestmark = pytest.mark.db_profile


def _find_payload_mismatches(expected, actual, path="$"):
    mismatches = []

    if type(expected) is not type(actual):
        mismatches.append(
            f"{path}: type mismatch expected={type(expected).__name__} actual={type(actual).__name__}"
        )
        return mismatches

    if isinstance(expected, dict):
        expected_keys = set(expected.keys())
        actual_keys = set(actual.keys())
        missing = sorted(expected_keys - actual_keys)
        extra = sorted(actual_keys - expected_keys)
        if missing:
            mismatches.append(f"{path}: missing keys {missing}")
        if extra:
            mismatches.append(f"{path}: extra keys {extra}")

        for key in sorted(expected_keys & actual_keys):
            mismatches.extend(_find_payload_mismatches(expected[key], actual[key], f"{path}.{key}"))
        return mismatches

    if isinstance(expected, list):
        if len(expected) != len(actual):
            mismatches.append(f"{path}: length mismatch expected={len(expected)} actual={len(actual)}")
            return mismatches

        for index, (exp_item, act_item) in enumerate(zip(expected, actual)):
            mismatches.extend(_find_payload_mismatches(exp_item, act_item, f"{path}[{index}]"))
        return mismatches

    if expected != actual:
        mismatches.append(f"{path}: value mismatch expected={expected!r} actual={actual!r}")

    return mismatches


def _assert_payloads_match(expected_payloads, actual_payloads):
    mismatches = _find_payload_mismatches(expected_payloads, actual_payloads)
    # Keep failure output concise while preserving first mismatch reasons.
    assert not mismatches, "JSON/DB response contract mismatch:\n" + "\n".join(mismatches[:20])


def _copy_rows(rows):
    return [dict(item) for item in rows]


def _snapshot_db_store(backend_env):
    return {
        name: _copy_rows(backend_env.load_json_data(name))
        for name in backend_env.JSON_COLLECTION_TABLES
    }


def _enable_db_mode(backend_env, monkeypatch, db_store):
    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_load_json_data", lambda name: _copy_rows(db_store.get(name, [])))

    def fake_replace(name, data):
        db_store[name] = _copy_rows(data)

    monkeypatch.setattr(backend_env, "db_replace_collection", fake_replace)
    monkeypatch.setattr(backend_env, "storage_enabled", lambda: False)
    backend_env._memory_cache.clear()


def _reset_collections(backend_env):
    backend_env._memory_cache.clear()
    for name in backend_env.JSON_DATA_NAMES:
        backend_env.save_json_data(name, [])


def _seed_minimum_data(backend_env):
    backend_env.save_json_data(
        "performances",
        [
            {
                "id": 1,
                "title": "Concert",
                "date": "2026-07-01",
                "open_time": "17:00",
                "start_time": "18:00",
                "venue": "Hall",
                "conductor": "Cond",
                "pieces": [],
            }
        ],
    )
    backend_env.save_json_data("schedules", [{"id": 1, "date": "2026-06-30", "venue": "Studio"}])
    backend_env.save_json_data("announcements", [{"id": 1, "date": "2026-06-29", "content": "Notice"}])
    backend_env.save_json_data("events", [{"id": 1, "title": "Event"}])
    backend_env.save_json_data(
        "members",
        [
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
    )
    backend_env.save_json_data(
        "auth_devices",
        [
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
    )
    backend_env.save_json_data("payments", [{"id": 1, "member_id": 1, "paid_until_month": "2026-06"}])
    backend_env.save_json_data("flyer_places", [])
    backend_env.save_json_data("flyer_distributions", [])
    backend_env.save_json_data("part_settings", [{"id": 1, "name": "Vn", "sort_order": 1, "is_active": True}])
    backend_env.save_json_data("org_settings", [{"id": 1, "name": "Kanade", "short_name": "Kanade"}])
    backend_env.save_json_data("sns_settings", [])
    backend_env.save_json_data("connection_settings", [])
    backend_env.save_json_data("absences", [])
    backend_env.save_json_data("event_responses", [])
    backend_env.save_json_data("date_adjustments", [])
    backend_env.save_json_data("date_adjustment_responses", [])
    backend_env.save_json_data("castings", [])
    backend_env.save_json_data("piece_infos", [])
    backend_env.save_json_data("practice_instructions", [])
    backend_env.save_json_data("albums", [])
    backend_env.save_json_data("venue_settings", [])
    backend_env.save_json_data("desired_pieces", [])
    backend_env.save_json_data("promotions", [])


def test_read_api_responses_are_equal_between_json_and_db_mode(client, backend_env, monkeypatch):
    _reset_collections(backend_env)
    _seed_minimum_data(backend_env)

    read_paths = [
        "/api/performances",
        "/api/members",
        "/api/extra/org_settings",
        "/api/bootstrap-lite",
        "/api/bootstrap-core",
        "/api/bootstrap",
    ]

    json_mode_payloads = {path: client.get(path).json() for path in read_paths}

    db_store = _snapshot_db_store(backend_env)
    _enable_db_mode(backend_env, monkeypatch, db_store)

    db_mode_payloads = {path: client.get(path).json() for path in read_paths}

    _assert_payloads_match(json_mode_payloads, db_mode_payloads)


def _run_write_scenario(client, backend_env, monkeypatch, *, db_mode: bool):
    _reset_collections(backend_env)
    _seed_minimum_data(backend_env)

    if db_mode:
        db_store = _snapshot_db_store(backend_env)
        _enable_db_mode(backend_env, monkeypatch, db_store)

    admin_headers = {"X-Device-Id": "dev-admin"}

    performance = client.post(
        "/api/performances",
        headers=admin_headers,
        json={
            "title": "Perf-New",
            "date": "2026-08-01",
            "open_time": "17:30",
            "start_time": "18:30",
            "venue": "Hall-2",
            "conductor": "Cond-2",
            "pieces": [],
        },
    )
    assert performance.status_code == 200

    org = client.post(
        "/api/extra/org_settings",
        headers=admin_headers,
        json={
            "name": "Kanade Updated",
            "short_name": "K",
        },
    )
    assert org.status_code == 200

    return {
        "performance": performance.json(),
        "org": org.json(),
    }


def test_write_api_response_shape_matches_between_json_and_db_mode(client, backend_env, monkeypatch):
    json_result = _run_write_scenario(client, backend_env, monkeypatch, db_mode=False)

    db_result = _run_write_scenario(client, backend_env, monkeypatch, db_mode=True)

    assert set(json_result["performance"].keys()) == set(db_result["performance"].keys())
    assert set(json_result["org"].keys()) == set(db_result["org"].keys())

    for key in ("title", "date", "open_time", "start_time", "venue", "conductor"):
        assert json_result["performance"][key] == db_result["performance"][key]

    for key in ("name", "short_name"):
        assert json_result["org"][key] == db_result["org"][key]

    assert isinstance(json_result["performance"]["id"], int)
    assert isinstance(db_result["performance"]["id"], int)
    assert isinstance(json_result["org"]["id"], int)
    assert isinstance(db_result["org"]["id"], int)


def test_bootstrap_core_keeps_existing_extras_when_one_extra_collection_fails(client, backend_env, monkeypatch):
    _reset_collections(backend_env)
    _seed_minimum_data(backend_env)
    backend_env.save_json_data("castings", [{"id": 1, "performance_id": 1, "piece": "Symphony", "members": [], "extras": []}])
    backend_env.save_json_data("venue_settings", [{"id": 1, "name": "Hall", "sort_order": 1}])

    original_load = backend_env.load_json_data

    def flaky_load(name):
        if name == "flyer_places":
            raise RuntimeError("flyer_places unavailable")
        return original_load(name)

    monkeypatch.setattr(bootstrap_router.bootstrap_service, "combined_collection_etag", lambda *args, **kwargs: "etag")
    monkeypatch.setattr(backend_env, "load_json_data", flaky_load)
    monkeypatch.setattr(bootstrap_router, "load_json_data", flaky_load)

    response = client.get("/api/bootstrap-core")

    assert response.status_code == 200
    extras = response.json()["extras"]
    assert extras["flyer_places"] == []
    assert extras["castings"][0]["piece"] == "Symphony"
    assert extras["venue_settings"][0]["name"] == "Hall"
