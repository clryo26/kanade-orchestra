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


def test_recording_list_deduplicates_cloud_mirrored_local_file(client, backend_env):
    recording_dir = backend_env.CONVERTED_DIR / "2026-06-18" / "Symphony"
    recording_dir.mkdir(parents=True, exist_ok=True)
    (recording_dir / "take1.mp3").write_bytes(b"dummy audio")
    backend_env.save_json_data(
        "drive_files",
        [
            {
                "id": "2026-06-18/Symphony/take1.mp3",
                "name": "take1.mp3",
                "date": "2026-06-18",
                "piece": "Symphony",
                "object_name": "2026-06-18/Symphony/take1.mp3",
                "source": "google_cloud_storage",
            }
        ],
    )

    response = client.get("/api/recordings")

    assert response.status_code == 200
    files = response.json()["files"]
    assert len(files) == 1
    assert files[0]["source"] == "google_cloud_storage"


def test_piece_info_crud_allowed_for_authenticated_member(client, seed_device_fn):
    seed_device_fn(device_id="dev-member", permission="一般")

    created = client.post(
        "/api/extra/piece_infos",
        headers={"X-Device-Id": "dev-member"},
        json={"performance_id": "1", "piece": "Symphony", "description": "初稿"},
    )
    assert created.status_code == 200
    item_id = created.json()["id"]

    updated = client.put(
        f"/api/extra/piece_infos/{item_id}",
        headers={"X-Device-Id": "dev-member"},
        json={"performance_id": "1", "piece": "Symphony", "description": "更新後"},
    )
    assert updated.status_code == 200
    assert updated.json()["description"] == "更新後"

    deleted = client.delete(
        f"/api/extra/piece_infos/{item_id}",
        headers={"X-Device-Id": "dev-member"},
    )
    assert deleted.status_code == 200


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
