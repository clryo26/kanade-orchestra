from __future__ import annotations

import io
from PIL import Image


def _camera_image():
    output = io.BytesIO()
    Image.new("RGB", (4000, 3000), "blue").save(output, format="JPEG")
    return output.getvalue()


def test_gallery_thumbnail_is_small_cached_and_original_stays_intact(client, backend_env, seed_device_fn, monkeypatch):
    from src.backend.services import album_service

    seed_device_fn(device_id="dev-user", permission="一般", member_name="u")
    backend_env.save_json_data("albums", [{"id": 1, "photos": []}])
    original = _camera_image()
    upload = client.post("/api/extra/albums/1/photos", headers={"X-Device-Id": "dev-user"},
                         files={"file": ("camera.jpg", original, "image/jpeg")})
    assert upload.status_code == 200
    url = upload.json()["url"]
    preview = client.get(url + "/thumbnail")
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/webp"
    assert "private" in preview.headers["cache-control"]
    with Image.open(io.BytesIO(preview.content)) as image:
        assert image.size == (384, 288)
    assert len(preview.content) < len(original) / 10
    assert client.get(url).content == original
    monkeypatch.setattr(album_service, "_original_response", lambda _photo: (_ for _ in ()).throw(AssertionError("cached thumbnail must not read original")))
    assert client.get(url + "/thumbnail").content == preview.content


def test_invalid_thumbnail_never_returns_original(client, backend_env):
    path = backend_env.UPLOAD_DIR / "broken.jpg"
    path.write_bytes(b"broken-image")
    backend_env.save_json_data("albums", [{"id": 1, "photos": [{"id": 1, "path": "broken.jpg"}]}])
    assert client.get("/api/albums/1/photos/1/thumbnail").status_code == 422
    assert client.get("/api/albums/1/photos/1").content == b"broken-image"


def test_deleted_photo_cannot_be_served_from_thumbnail_cache(client, backend_env):
    path = backend_env.UPLOAD_DIR / "camera.jpg"
    path.write_bytes(_camera_image())
    backend_env.save_json_data("albums", [{"id": 1, "photos": [{"id": 1, "path": "camera.jpg"}]}])
    assert client.get("/api/albums/1/photos/1/thumbnail").status_code == 200
    backend_env.save_json_data("albums", [{"id": 1, "photos": []}])
    assert client.get("/api/albums/1/photos/1/thumbnail").status_code == 404


def test_cloud_thumbnail_cache_reads_original_only_once(backend_env, monkeypatch):
    from google.api_core.exceptions import NotFound
    from src.backend.services import album_service

    objects = {"albums/1/camera.jpg": _camera_image()}
    reads = []

    class Blob:
        def __init__(self, name):
            self.name = name

        def download_as_bytes(self, *, timeout):
            assert timeout == 30
            reads.append(self.name)
            if self.name not in objects:
                raise NotFound("missing")
            return objects[self.name]

        def upload_from_string(self, content, *, content_type, if_generation_match, timeout):
            assert content_type == "image/webp"
            assert if_generation_match == 0
            assert timeout == 30
            objects[self.name] = content

    class Bucket:
        def blob(self, name):
            return Blob(name)

    photo = {"id": 1, "object_name": "albums/1/camera.jpg"}
    backend_env.save_json_data("albums", [{"id": 1, "photos": [photo]}])
    monkeypatch.setattr(album_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(album_service, "get_storage_bucket", Bucket)
    first = album_service.get_album_photo_response(1, 1, thumbnail=True)
    second = album_service.get_album_photo_response(1, 1, thumbnail=True)
    assert first.body == second.body
    assert reads.count("albums/1/camera.jpg") == 1
    assert len(first.body) < len(objects["albums/1/camera.jpg"]) / 10


def test_thumbnail_preserves_camera_orientation():
    from src.backend.services import album_service

    output = io.BytesIO()
    image = Image.new("RGB", (1200, 800), "blue")
    exif = Image.Exif()
    exif[274] = 6
    image.save(output, format="JPEG", exif=exif)
    small = album_service._make_thumbnail(output.getvalue())
    with Image.open(io.BytesIO(small)) as thumbnail:
        assert thumbnail.size == (256, 384)


def test_db_album_list_ignores_stale_process_cache(tmp_path):
    from src.backend.services import json_collection_service
    from src.backend.services.memory_cache import MemoryCache

    cache = MemoryCache()
    cache.set("albums", [{"id": 1, "photos": []}])
    committed = [{"id": 1, "photos": [{"id": 9}]}]
    result = json_collection_service.load_json_data(
        "albums", cache=cache, local_json_fallback_enabled=lambda: False,
        ensure_db_expected_is_ready=lambda: None, db_load_json_data=lambda _name: committed,
        db_load_generic_json_collection=lambda _name: [], json_collection_tables={"albums"},
        json_data_names={"albums"}, extra_collections=set(), data_dir=tmp_path, logger=None,
    )
    assert result == committed


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
    # Regression guard: the test fixture must redirect writes away from src/uploads.
    assert (backend_env.UPLOAD_DIR / photo["path"]).is_file()


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
