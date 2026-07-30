from __future__ import annotations


def _seed_device(backend_env, device_id: str, member_id: int | None, member_name: str, permission: str = "一般") -> None:
    devices = backend_env.load_json_data("auth_devices")
    devices.append(
        {
            "id": backend_env.next_id(devices),
            "device_id": device_id,
            "member_id": member_id,
            "member_name": member_name,
            "permission": permission,
            "is_recording_manager": False,
            "is_sheet_manager": False,
            "authenticated_at": "2026-06-18T00:00:00",
            "last_seen_at": "2026-06-18T00:00:00",
        }
    )
    backend_env.save_json_data("auth_devices", devices)


def test_event_delete_is_limited_to_creator(client, backend_env):
    _seed_device(backend_env, "dev-creator", 101, "Creator")
    _seed_device(backend_env, "dev-other", 202, "Other")

    created = client.post(
        "/api/events",
        headers={"X-Device-Id": "dev-creator"},
        json={
            "title": "Creator Event",
            "date": "2026-07-30",
            "start_time": "18:00",
            "deadline": "2026-07-29",
            "url": "",
            "notes": "",
            "delete_phrase": "key",
            "fee": "",
        },
    )
    assert created.status_code == 200
    event_id = created.json()["id"]

    denied = client.delete(f"/api/events/{event_id}", headers={"X-Device-Id": "dev-other"})
    assert denied.status_code == 403

    allowed = client.delete(f"/api/events/{event_id}", headers={"X-Device-Id": "dev-creator"})
    assert allowed.status_code == 200


def test_event_without_creator_metadata_cannot_be_deleted_by_general_member(client, backend_env):
    _seed_device(backend_env, "dev-general", 301, "General")

    backend_env.save_json_data(
        "events",
        [
            {
                "id": 1,
                "title": "Legacy Event",
                "date": "2026-07-30",
                "start_time": "18:00",
                "deadline": "2026-07-29",
                "url": "",
                "notes": "",
                "delete_phrase": "k",
                "fee": "",
                "created_at": "2026-07-01T00:00:00",
                "updated_at": "2026-07-01T00:00:00",
            }
        ],
    )

    denied = client.delete("/api/events/1", headers={"X-Device-Id": "dev-general"})
    assert denied.status_code == 403


def test_album_event_delete_is_limited_to_creator_or_admin(client, backend_env):
    _seed_device(backend_env, "dev-creator", 401, "AlbumCreator")
    _seed_device(backend_env, "dev-other", 402, "OtherUser")
    _seed_device(backend_env, "dev-admin", 1, "Admin", permission="管理者")

    backend_env.save_json_data(
        "albums",
        [
            {
                "id": 1,
                "event_name": "Album Event",
                "created_by_member_id": 401,
                "created_by_member_name": "AlbumCreator",
                "created_at": "2026-07-01T00:00:00",
                "updated_at": "2026-07-01T00:00:00",
            }
        ],
    )

    denied = client.delete("/api/extra/albums/1", headers={"X-Device-Id": "dev-other"})
    assert denied.status_code == 403

    allowed = client.delete("/api/extra/albums/1", headers={"X-Device-Id": "dev-creator"})
    assert allowed.status_code == 200

    backend_env.save_json_data(
        "albums",
        [
            {
                "id": 2,
                "event_name": "Album Event 2",
                "created_by_member_id": 999,
                "created_by_member_name": "Someone",
                "created_at": "2026-07-01T00:00:00",
                "updated_at": "2026-07-01T00:00:00",
            }
        ],
    )
    admin_allowed = client.delete("/api/extra/albums/2", headers={"X-Device-Id": "dev-admin"})
    assert admin_allowed.status_code == 200


def test_album_photo_delete_is_limited_to_uploader_or_admin(client, backend_env):
    _seed_device(backend_env, "dev-uploader", 501, "Uploader")
    _seed_device(backend_env, "dev-other", 502, "Other")
    _seed_device(backend_env, "dev-admin", 1, "Admin", permission="管理者")

    backend_env.save_json_data(
        "albums",
        [
            {
                "id": 1,
                "event_name": "Photo Event",
                "created_by_member_id": 501,
                "created_by_member_name": "Uploader",
                "photos": [
                    {
                        "id": 10,
                        "filename": "photo.jpg",
                        "url": "/api/albums/1/photos/10",
                        "uploaded_by_member_id": 501,
                        "uploaded_by_member_name": "Uploader",
                        "uploaded_at": "2026-07-01T00:00:00",
                        "path": "albums/1/2026-07-01/10_photo.jpg",
                    },
                    {
                        "id": 11,
                        "filename": "legacy.jpg",
                        "url": "/api/albums/1/photos/11",
                        "uploaded_by_member_id": "",
                        "uploaded_by_member_name": "",
                        "uploaded_at": "2026-07-01T00:00:00",
                        "path": "albums/1/2026-07-01/11_legacy.jpg",
                    },
                ],
            }
        ],
    )

    denied = client.delete("/api/extra/albums/1/photos/10", headers={"X-Device-Id": "dev-other"})
    assert denied.status_code == 403

    uploader_allowed = client.delete("/api/extra/albums/1/photos/10", headers={"X-Device-Id": "dev-uploader"})
    assert uploader_allowed.status_code == 200

    legacy_denied = client.delete("/api/extra/albums/1/photos/11", headers={"X-Device-Id": "dev-other"})
    assert legacy_denied.status_code == 403

    admin_allowed = client.delete("/api/extra/albums/1/photos/11", headers={"X-Device-Id": "dev-admin"})
    assert admin_allowed.status_code == 200
