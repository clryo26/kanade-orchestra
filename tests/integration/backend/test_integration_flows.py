from __future__ import annotations


def _seed_member(backend_env, *, member_id: int, name: str, part: str, permission: str, password: str, is_recording_manager: bool = False, is_sheet_manager: bool = False):
    members = backend_env.load_json_data("members")
    members.append(
        {
            "id": member_id,
            "name": name,
            "part": part,
            "permission": permission,
            "password": password,
            "is_recording_manager": is_recording_manager,
            "is_sheet_manager": is_sheet_manager,
        }
    )
    backend_env.save_json_data("members", members)


def _portal_login(client, *, name: str, part: str, password: str, device_id: str):
    return client.post(
        "/api/auth/portal-login",
        json={
            "name": name,
            "part": part,
            "password": password,
            "device_id": device_id,
            "device_name": "test-device",
            "user_agent": "pytest",
        },
    )


def _performance_payload(title: str):
    return {
        "title": title,
        "date": "2026-06-18",
        "open_time": "17:00",
        "start_time": "18:00",
        "venue": "v",
        "conductor": "c",
        "pieces": [],
    }


def test_auth_to_admin_crud_chain(client, backend_env):
    _seed_member(
        backend_env,
        member_id=1,
        name="admin",
        part="Vn",
        permission="管理者",
        password="pw-admin",
    )

    login = _portal_login(client, name="admin", part="Vn", password="pw-admin", device_id="dev-admin")
    assert login.status_code == 200
    assert login.json()["authenticated"] is True

    auth_check = client.get("/api/auth/devices/dev-admin")
    assert auth_check.status_code == 200
    assert auth_check.json()["authenticated"] is True

    created = client.post(
        "/api/performances",
        headers={"X-Device-Id": "dev-admin"},
        json=_performance_payload("integration-performance"),
    )
    assert created.status_code == 200
    performance_id = created.json()["id"]

    listed = client.get("/api/performances")
    assert listed.status_code == 200
    assert any(item.get("id") == performance_id for item in listed.json())


def test_general_login_then_admin_api_forbidden_chain(client, backend_env):
    _seed_member(
        backend_env,
        member_id=2,
        name="member",
        part="Va",
        permission="一般",
        password="pw-member",
    )

    login = _portal_login(client, name="member", part="Va", password="pw-member", device_id="dev-general")
    assert login.status_code == 200

    denied = client.post(
        "/api/performances",
        headers={"X-Device-Id": "dev-general"},
        json=_performance_payload("denied-performance"),
    )
    assert denied.status_code == 403


def test_date_adjustment_owner_and_lock_chain(client, backend_env):
    _seed_member(
        backend_env,
        member_id=10,
        name="owner-a",
        part="Vc",
        permission="一般",
        password="pw-owner",
    )
    _seed_member(
        backend_env,
        member_id=11,
        name="owner-b",
        part="Cb",
        permission="一般",
        password="pw-other",
    )

    owner_login = _portal_login(client, name="owner-a", part="Vc", password="pw-owner", device_id="dev-owner")
    assert owner_login.status_code == 200
    other_login = _portal_login(client, name="owner-b", part="Cb", password="pw-other", device_id="dev-other")
    assert other_login.status_code == 200

    created = client.post(
        "/api/extra/date_adjustments",
        headers={"X-Device-Id": "dev-owner"},
        json={
            "title": "integration-lock",
            "deadline": "2026-07-01",
            "notes": "n",
            "created_by": "owner-a",
            "candidates": [
                {
                    "id": "cand-1",
                    "date": "2026-07-10",
                    "start_time": "18:00",
                    "end_time": "21:00",
                    "note": "candidate",
                }
            ],
        },
    )
    assert created.status_code == 200

    current = created.json()
    adjustment_id = current["id"]
    stale_updated_at = current["updated_at"]

    allowed_update = client.put(
        f"/api/extra/date_adjustments/{adjustment_id}",
        headers={"X-Device-Id": "dev-owner"},
        json={
            "payload": {
                "title": current["title"],
                "deadline": current.get("deadline", ""),
                "notes": "owner-update",
                "created_by": "owner-a",
                "candidates": current["candidates"],
            },
            "expected_updated_at": stale_updated_at,
        },
    )
    assert allowed_update.status_code == 200

    stale_update = client.put(
        f"/api/extra/date_adjustments/{adjustment_id}",
        headers={"X-Device-Id": "dev-owner"},
        json={
            "payload": {
                "title": current["title"],
                "deadline": current.get("deadline", ""),
                "notes": "stale-update",
                "created_by": "owner-a",
                "candidates": current["candidates"],
            },
            "expected_updated_at": stale_updated_at,
        },
    )
    assert stale_update.status_code == 409

    denied_other = client.put(
        f"/api/extra/date_adjustments/{adjustment_id}",
        headers={"X-Device-Id": "dev-other"},
        json={
            "payload": {
                "title": current["title"],
                "deadline": current.get("deadline", ""),
                "notes": "other-update",
                "created_by": "owner-a",
                "candidates": current["candidates"],
            },
        },
    )
    assert denied_other.status_code == 403


def test_bootstrap_lite_etag_chain(client):
    first = client.get("/api/bootstrap-lite")
    assert first.status_code == 200

    etag = first.headers.get("etag") or first.headers.get("ETag")
    assert etag

    second = client.get("/api/bootstrap-lite", headers={"If-None-Match": etag})
    assert second.status_code == 304
