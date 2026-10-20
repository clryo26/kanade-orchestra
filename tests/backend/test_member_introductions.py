from __future__ import annotations


def test_introductions_require_auth_and_whitelist_fields(client, backend_env, seed_device_fn):
    backend_env.save_json_data("members", [
        {"id": 1, "name": "Public", "permission": "一般", "password": "private", "maiden_name_kana": "private", "is_recording_manager": True,
         "comment": "public comment", "photo_url": "data:image/png;base64,YQ=="},
        {"id": 2, "name": "Extra", "permission": "エキストラ"},
    ])
    assert client.get("/api/member-introductions").status_code == 401
    seed_device_fn(device_id="intro-viewer", permission="一般", member_name="viewer")
    headers = {"X-Device-Id": "intro-viewer"}
    response = client.get("/api/member-introductions", headers=headers)
    assert response.status_code == 200
    assert len(response.json()) == 1
    item = response.json()[0]
    assert item["comment"] == "public comment"
    assert item["photo_url"].startswith("/api/members/1/photo")
    assert not any(k in item for k in ("password", "password_set", "permission", "maiden_name_kana", "is_recording_manager", "organization_id"))
    assert "base64" not in response.text
    assert "private" in response.headers["cache-control"]
    assert client.get("/api/member-introductions", headers={**headers, "If-None-Match": response.headers["etag"]}).status_code == 304
    backend_env.save_json_data("members", [{"id": 1, "name": "Updated", "permission": "一般"}])
    refreshed = client.get("/api/member-introductions", headers={**headers, "If-None-Match": response.headers["etag"]})
    assert refreshed.status_code == 200 and refreshed.json()[0]["name"] == "Updated"


def test_intro_never_replaces_private_member_detail(client, backend_env, seed_device_fn):
    backend_env.save_json_data("members", [{"id": 1, "name": "Public", "permission": "一般", "is_recording_manager": True, "comment": "hello"}])
    seed_device_fn(device_id="owner", member_id=1, permission="一般", member_name="Public")
    headers = {"X-Device-Id": "owner"}
    assert "is_recording_manager" not in client.get("/api/member-introductions", headers=headers).json()[0]
    assert client.get("/api/members/1", headers=headers).json()["is_recording_manager"] is True
