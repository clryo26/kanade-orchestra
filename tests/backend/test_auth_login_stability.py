from __future__ import annotations

import hashlib


def _setup_db_only_auth_env(backend_env, monkeypatch, db_store):
    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_load_json_data", lambda name: [dict(item) for item in db_store.get(name, [])])
    monkeypatch.setattr(backend_env, "db_replace_collection", lambda name, data: db_store.__setitem__(name, [dict(item) for item in data]))
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
