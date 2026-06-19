from __future__ import annotations


def test_album_photo_local_serving_endpoint_returns_file(client, backend_env, seed_device_fn):
    seed_device_fn(device_id="dev-user", permission="一般", member_name="u")

    # 事前にアルバムを作成
    backend_env.save_json_data(
        "albums",
        [
            {
                "id": 1,
                "event_name": "event",
                "created_by_member_id": 1,
                "created_by_member_name": "u",
                "photos": [],
            }
        ],
    )

    upload = client.post(
        "/api/extra/albums/1/photos",
        headers={"X-Device-Id": "dev-user"},
        files={"file": ("sample.png", b"fake-image-bytes", "image/png")},
    )
    assert upload.status_code == 200
    photo = upload.json()

    get_photo = client.get(f"/api/albums/1/photos/{photo['id']}")
    assert get_photo.status_code == 200
    assert get_photo.content == b"fake-image-bytes"


def test_album_photo_url_is_api_route_on_upload(client, backend_env, seed_device_fn):
    seed_device_fn(device_id="dev-user", permission="一般", member_name="u")
    backend_env.save_json_data(
        "albums",
        [
            {
                "id": 2,
                "event_name": "event-2",
                "created_by_member_id": 1,
                "created_by_member_name": "u",
                "photos": [],
            }
        ],
    )

    upload = client.post(
        "/api/extra/albums/2/photos",
        headers={"X-Device-Id": "dev-user"},
        files={"file": ("sample.jpg", b"fake-jpg", "image/jpeg")},
    )
    assert upload.status_code == 200
    body = upload.json()
    assert body["url"] == f"/api/albums/2/photos/{body['id']}"
