from __future__ import annotations


def test_create_performance_requires_device_header(client):
    response = client.post(
        "/api/performances",
        json={
            "title": "t",
            "date": "2026-06-18",
            "open_time": "17:00",
            "start_time": "18:00",
            "venue": "v",
            "conductor": "c",
            "pieces": [],
        },
    )
    assert response.status_code == 401


def test_create_performance_forbidden_for_general(client, seed_device_fn):
    seed_device_fn(device_id="dev-general", permission="一般")
    response = client.post(
        "/api/performances",
        headers={"X-Device-Id": "dev-general"},
        json={
            "title": "t",
            "date": "2026-06-18",
            "open_time": "17:00",
            "start_time": "18:00",
            "venue": "v",
            "conductor": "c",
            "pieces": [],
        },
    )
    assert response.status_code == 403


def test_create_performance_allowed_for_admin(client, seed_device_fn, admin_headers_fixture):
    seed_device_fn(device_id="dev-admin", permission="管理者")
    response = client.post(
        "/api/performances",
        headers=admin_headers_fixture,
        json={
            "title": "t",
            "date": "2026-06-18",
            "open_time": "17:00",
            "start_time": "18:00",
            "venue": "v",
            "conductor": "c",
            "pieces": [],
        },
    )
    assert response.status_code == 200
    assert response.json()["id"] == 1


def test_recording_delete_forbidden_for_general(client, seed_device_fn):
    seed_device_fn(device_id="dev-general", permission="一般")
    response = client.request(
        "DELETE",
        "/api/recordings",
        headers={"X-Device-Id": "dev-general"},
        json={"source": "local", "path": "x.mp3"},
    )
    assert response.status_code == 403


def test_recording_delete_allowed_for_recording_manager(client, seed_device_fn):
    seed_device_fn(
        device_id="dev-rec",
        permission="一般",
        is_recording_manager=True,
    )
    response = client.request(
        "DELETE",
        "/api/recordings",
        headers={"X-Device-Id": "dev-rec"},
        json={"source": "local", "path": "missing.mp3"},
    )
    assert response.status_code == 404


def test_sheet_bulk_update_permission(client, seed_device_fn):
    seed_device_fn(device_id="dev-general", permission="一般")
    seed_device_fn(
        device_id="dev-sheet",
        permission="一般",
        is_sheet_manager=True,
    )

    denied = client.put(
        "/api/sheets/parts",
        headers={"X-Device-Id": "dev-general"},
        json={"sheet_ids": [], "part": "Vn"},
    )
    assert denied.status_code == 403

    allowed = client.put(
        "/api/sheets/parts",
        headers={"X-Device-Id": "dev-sheet"},
        json={"sheet_ids": [], "part": "Vn"},
    )
    assert allowed.status_code == 400
