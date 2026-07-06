from __future__ import annotations

import hashlib

from src.backend.services import auth_service


def _setup_db_only_auth_env(backend_env, monkeypatch, db_store):
    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_load_json_data", lambda name: [dict(item) for item in db_store.get(name, [])])
    monkeypatch.setattr(backend_env, "db_replace_collection", lambda name, data: db_store.__setitem__(name, [dict(item) for item in data]))
    monkeypatch.setattr(backend_env, "db_delete_auth_device", lambda device_id: db_store.__setitem__(
        "auth_devices",
        [dict(item) for item in db_store.get("auth_devices", []) if item.get("device_id") != device_id],
    ))

    def fake_upsert_auth_device(device):
        devices = db_store.setdefault("auth_devices", [])
        payload = dict(device)
        existing = next((item for item in devices if item.get("device_id") == payload.get("device_id")), None)
        if existing:
            existing.update(payload)
            return dict(existing)
        payload["id"] = max([int(item.get("id") or 0) for item in devices] + [0]) + 1
        devices.append(payload)
        return dict(payload)

    monkeypatch.setattr(backend_env, "db_upsert_auth_device", fake_upsert_auth_device)
    backend_env._memory_cache.clear()


def _login(client, *, name: str, part: str, password: str, device_id: str):
    return client.post(
        "/api/auth/portal-login",
        json={
            "name": name,
            "part": part,
            "password": password,
            "device_id": device_id,
            "device_name": "Test Browser",
        },
    )


def test_member_login_success_db_only(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 101,
                "name": "Member User",
                "part": "Vn",
                "password": backend_env.hash_password("member-pass"),
                "permission": "一般",
                "is_recording_manager": False,
                "is_sheet_manager": False,
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    response = _login(client, name="Member User", part="Vn", password="member-pass", device_id="device-member")

    assert response.status_code == 200
    payload = response.json()
    assert payload["authenticated"] is True
    assert payload["member_id"] == 101
    assert payload["permission"] == "一般"


def test_admin_login_success_db_only(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 201,
                "name": "Admin User",
                "part": "Vc",
                "password": backend_env.hash_password("admin-pass"),
                "permission": "管理者",
                "is_recording_manager": True,
                "is_sheet_manager": True,
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    response = _login(client, name="Admin User", part="Vc", password="admin-pass", device_id="device-admin")

    assert response.status_code == 200
    payload = response.json()
    assert payload["authenticated"] is True
    assert payload["permission"] == "管理者"


def test_login_accepts_legacy_sha256_password_and_migrates(client, backend_env, monkeypatch):
    salt = "legacy-salt"
    digest = hashlib.sha256(f"{salt}:legacy-pass".encode("utf-8")).hexdigest()
    db_store = {
        "members": [
            {
                "id": 301,
                "name": "Legacy Sha",
                "part": "Va",
                "password": f"sha256${salt}${digest}",
                "permission": "一般",
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    response = _login(client, name="Legacy Sha", part="Va", password="legacy-pass", device_id="device-legacy-sha")

    assert response.status_code == 200
    stored_password = db_store["members"][0]["password"]
    assert stored_password.startswith("sha256$")
    assert backend_env.verify_password("legacy-pass", stored_password)


def test_login_accepts_pbkdf2_password(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 302,
                "name": "PBKDF2 User",
                "part": "Cb",
                "password": backend_env.hash_password("pbkdf2-pass"),
                "permission": "一般",
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    response = _login(client, name="PBKDF2 User", part="Cb", password="pbkdf2-pass", device_id="device-pbkdf2")

    assert response.status_code == 200
    assert response.json()["authenticated"] is True


def test_login_accepts_plaintext_password_and_migrates(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 303,
                "name": "Plain User",
                "part": "Fl",
                "password": "plain-pass",
                "permission": "一般",
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    response = _login(client, name="Plain User", part="Fl", password="plain-pass", device_id="device-plain")

    assert response.status_code == 200
    stored_password = db_store["members"][0]["password"]
    assert stored_password.startswith("pbkdf2$")
    assert backend_env.verify_password("plain-pass", stored_password)


def test_login_normalizes_iphone_like_inputs(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 304,
                "name": "Kana Vn",
                "part": "Vn",
                "password": backend_env.hash_password("mobile-pass"),
                "permission": "一般",
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    response = _login(
        client,
        name="　Ｋａｎａ\u200b Ｖｎ　",
        part="　Ｖｎ　",
        password="　mobile-pass\u200b　",
        device_id="device-mobile",
    )

    assert response.status_code == 200
    assert response.json()["authenticated"] is True


def test_login_treats_missing_permission_as_member_equivalent(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 305,
                "name": "No Permission",
                "part": "Ob",
                "password": backend_env.hash_password("no-perm"),
                "role": "",
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    response = _login(client, name="No Permission", part="Ob", password="no-perm", device_id="device-no-perm")

    assert response.status_code == 200
    assert response.json()["permission"] == "一般"


def test_login_handles_invalid_password_placeholders(client, backend_env, monkeypatch):
    for index, invalid in enumerate([None, "", "設定済み"], start=1):
        db_store = {
            "members": [
                {
                    "id": 400 + index,
                    "name": f"Placeholder {index}",
                    "part": "Vn",
                    "password": invalid,
                    "permission": "一般",
                    "system_access_until": "",
                }
            ],
            "auth_devices": [],
        }
        _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

        response = _login(
            client,
            name=f"Placeholder {index}",
            part="Vn",
            password="any-pass",
            device_id=f"device-placeholder-{index}",
        )

        assert response.status_code == 200
        body = response.json()
        assert body["authenticated"] is False
        assert body["needs_password_setup"] is True


def test_db_only_login_does_not_fallback_to_local_json(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 501,
                "name": "Db Strict",
                "part": "Vn",
                "password": backend_env.hash_password("db-only-pass"),
                "permission": "一般",
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)
    monkeypatch.setattr(backend_env, "load_local_json_data", lambda _name: (_ for _ in ()).throw(RuntimeError("local fallback called")))

    response = _login(client, name="Db Strict", part="Vn", password="db-only-pass", device_id="device-db-only")

    assert response.status_code == 200
    assert response.json()["authenticated"] is True


def test_login_refreshes_cached_auth_devices_after_db_write(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 601,
                "name": "Cached Login",
                "part": "Vn",
                "password": backend_env.hash_password("cached-pass"),
                "permission": "荳闊ｬ",
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    # A startup/bootstrap read can cache an empty auth_devices collection before
    # login. The login write must refresh that cache immediately.
    assert backend_env.load_json_data("auth_devices") == []

    login_response = _login(
        client,
        name="Cached Login",
        part="Vn",
        password="cached-pass",
        device_id="device-cached-login",
    )
    assert login_response.status_code == 200

    device_response = client.get("/api/auth/devices/device-cached-login")
    assert device_response.status_code == 200
    assert device_response.json()["authenticated"] is True


def test_hidden_administrator_login_refreshes_cached_auth_devices(client, backend_env, monkeypatch):
    db_store = {
        "members": [],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    assert backend_env.load_json_data("auth_devices") == []

    response = _login(
        client,
        name="Administrator",
        part="",
        password="systemadminadmin",
        device_id="device-hidden-admin",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["authenticated"] is True
    assert payload["hidden_user"] is True

    device_response = client.get("/api/auth/devices/device-hidden-admin")
    assert device_response.status_code == 200
    assert device_response.json()["authenticated"] is True


def test_login_accepts_fullwidth_ascii_password_input(client, backend_env, monkeypatch):
    db_store = {
        "members": [
            {
                "id": 701,
                "name": "Fullwidth Password",
                "part": "Vn",
                "password": backend_env.hash_password("abc-123"),
                "permission": "荳闊ｬ",
                "system_access_until": "",
            }
        ],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    response = _login(
        client,
        name="Fullwidth Password",
        part="Vn",
        password="ａｂｃ－１２３",
        device_id="device-fullwidth-password",
    )

    assert response.status_code == 200
    assert response.json()["authenticated"] is True


def test_hidden_administrator_login_accepts_fullwidth_ascii_password(client, backend_env, monkeypatch):
    db_store = {
        "members": [],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    response = _login(
        client,
        name="Administrator",
        part="",
        password="ｓｙｓｔｅｍａｄｍｉｎａｄｍｉｎ",
        device_id="device-hidden-admin-fullwidth",
    )

    assert response.status_code == 200
    assert response.json()["authenticated"] is True


def test_hidden_administrator_login_survives_auth_device_persistence_failure(client, backend_env, monkeypatch):
    db_store = {
        "members": [],
        "auth_devices": [],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)

    def failing_auth_device_upsert(device):
        raise RuntimeError("auth_devices write failed")

    monkeypatch.setattr(backend_env, "db_upsert_auth_device", failing_auth_device_upsert)

    response = _login(
        client,
        name="Administrator",
        part="",
        password="systemadminadmin",
        device_id="device-hidden-admin-fallback",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["authenticated"] is True
    assert payload["hidden_user"] is True
    assert payload["auth_device_fallback"] is True

    device_response = client.get("/api/auth/devices/device-hidden-admin-fallback")
    assert device_response.status_code == 200
    assert device_response.json()["authenticated"] is True

    devices_response = client.get("/api/auth/devices")
    assert devices_response.status_code == 200
    device_ids = {str(item.get("device_id") or "") for item in devices_response.json()}
    assert "device-hidden-admin-fallback" in device_ids

    admin_response = client.post(
        "/api/performances",
        headers={"X-Device-Id": "device-hidden-admin-fallback"},
        json={
            "title": "Fallback Login Concert",
            "date": "2026-06-18",
            "open_time": "17:00",
            "start_time": "18:00",
            "venue": "Hall",
            "conductor": "Cond",
            "pieces": [],
        },
    )
    assert admin_response.status_code == 200


def test_device_auth_record_reads_auth_devices_from_db_when_cache_is_stale(backend_env, monkeypatch):
    db_devices = [
        {
            "id": 1,
            "device_id": "device-db-live",
            "member_id": None,
            "member_name": "DB Live",
            "permission": "管理者",
            "authenticated_at": "2026-07-06T00:00:00",
            "last_seen_at": "2026-07-06T00:00:00",
        }
    ]
    backend_env._memory_cache.set("auth_devices", [])
    monkeypatch.setattr(auth_service, "db_data_enabled", lambda: True)
    monkeypatch.setattr(auth_service, "db_load_json_data", lambda name: [dict(item) for item in db_devices])

    device = auth_service.device_auth_record("device-db-live")

    assert device["device_id"] == "device-db-live"


def test_auth_device_management_list_reads_db_instead_of_stale_cache(client, backend_env, monkeypatch):
    db_store = {
        "members": [],
        "auth_devices": [
            {
                "id": 1,
                "device_id": "device-db-visible",
                "member_id": None,
                "member_name": "DB Visible",
                "permission": "管理者",
                "authenticated_at": "2026-07-06T00:00:00",
                "last_seen_at": "2026-07-06T00:00:00",
            }
        ],
    }
    _setup_db_only_auth_env(backend_env, monkeypatch, db_store)
    backend_env._memory_cache.set(
        "auth_devices",
        [{"device_id": "stale-cache-device", "authenticated_at": "2026-01-01T00:00:00"}],
    )

    response = client.get("/api/auth/devices")

    assert response.status_code == 200
    device_ids = {item["device_id"] for item in response.json()}
    assert "device-db-visible" in device_ids
    assert "stale-cache-device" not in device_ids
