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


def test_portal_login_reads_members_from_database_after_json_migration(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 1,
                "name": "Db Member",
                "last_name": "Db",
                "first_name": "Member",
                "part": "Vn",
                "password": "secret",
                "permission": "一般",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }

    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_load_json_data", lambda name: [dict(item) for item in db_store.get(name, [])])

    def fake_replace(name, data):
        db_store[name] = [dict(item) for item in data]

    monkeypatch.setattr(backend_env, "db_replace_collection", fake_replace)
    backend_env._memory_cache.clear()

    response = client.post(
        "/api/auth/portal-login",
        json={
            "name": "Db Member",
            "part": "Vn",
            "password": "secret",
            "device_id": "db-device",
            "device_name": "Browser",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["authenticated"] is True
    assert payload["member_id"] == 1
    assert db_store["auth_devices"][0]["device_id"] == "db-device"


def test_portal_login_allows_unique_member_when_part_label_differs(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 11,
                "name": "Db Member",
                "part": "Violin",
                "password": "secret",
                "permission": "一般",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }

    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_load_json_data", lambda name: [dict(item) for item in db_store.get(name, [])])

    def fake_replace(name, data):
        db_store[name] = [dict(item) for item in data]

    monkeypatch.setattr(backend_env, "db_replace_collection", fake_replace)
    backend_env._memory_cache.clear()

    response = client.post(
        "/api/auth/portal-login",
        json={
            "name": "Db Member",
            "part": "Vn",
            "password": "secret",
            "device_id": "db-device-2",
            "device_name": "Browser",
        },
    )

    assert response.status_code == 200
    assert response.json()["member_id"] == 11


def test_portal_login_rejects_part_mismatch_when_same_name_is_duplicated(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 21,
                "name": "Same Name",
                "part": "Vn",
                "password": "secret1",
                "permission": "一般",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "system_access_until": "",
            },
            {
                "id": 22,
                "name": "Same Name",
                "part": "Va",
                "password": "secret2",
                "permission": "一般",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "system_access_until": "",
            },
        ],
        "auth_devices": [],
    }

    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_load_json_data", lambda name: [dict(item) for item in db_store.get(name, [])])
    monkeypatch.setattr(backend_env, "db_replace_collection", lambda name, data: db_store.__setitem__(name, [dict(item) for item in data]))
    backend_env._memory_cache.clear()

    response = client.post(
        "/api/auth/portal-login",
        json={
            "name": "Same Name",
            "part": "Cello",
            "password": "secret1",
            "device_id": "db-device-3",
            "device_name": "Browser",
        },
    )

    assert response.status_code == 404


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
