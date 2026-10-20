from __future__ import annotations

import asyncio
import base64
import io
import uuid

import pytest
from PIL import Image

from src.backend.services import member_photo_service as portraits
from src.backend.services import portal_file_asset_service as assets
from scripts import normalize_member_photos as migration


def photo_bytes(size=(2400, 1600), mode="RGB", fmt="JPEG", **kwargs):
    stream = io.BytesIO()
    Image.new(mode, size, (20, 80, 150, 80) if mode == "RGBA" else "blue").save(stream, fmt, **kwargs)
    return stream.getvalue()


@pytest.mark.parametrize("fmt,mode,size", [("JPEG", "RGB", (2400, 1600)), ("PNG", "RGBA", (1200, 1600)), ("WEBP", "RGB", (100, 80)), ("MPO", "RGB", (1000, 1200))])
def test_portrait_formats_sizes_and_transparency(fmt, mode, size):
    raw = photo_bytes(size, mode, fmt)
    converted = portraits.normalize(assets.FileInput(raw, "image/unknown", ".unknown", "source"))
    assert converted.filename == portraits.FILENAME
    assert converted.content_type == "image/webp"
    assert len(converted.content) <= 200 * 1024
    with Image.open(io.BytesIO(converted.content)) as image:
        assert max(image.size) <= 800
        assert image.width <= size[0] and image.height <= size[1]
        assert abs(image.width / image.height - size[0] / size[1]) < .01
        assert not image.getexif()
        if mode == "RGBA":
            assert image.mode == "RGBA" and image.getpixel((0, 0))[3] == 80


def test_heic_primary_image_is_converted():
    from pillow_heif import from_pillow
    stream = io.BytesIO()
    from_pillow(Image.new("RGB", (1000, 800), "green")).save(stream, quality=80)
    converted = portraits.normalize(assets.FileInput(stream.getvalue(), "image/heic", ".heic", "iphone.heic"))
    with Image.open(io.BytesIO(converted.content)) as image:
        assert image.size == (800, 640)


def test_portrait_orientation_and_metadata():
    exif = Image.Exif()
    exif[274] = 6
    exif[315] = "private metadata"
    raw = photo_bytes((1600, 1000), exif=exif)
    converted = portraits.normalize(assets.FileInput(raw, "image/jpeg", ".jpg", "photo"))
    with Image.open(io.BytesIO(converted.content)) as image:
        assert image.size == (500, 800)
        assert not image.getexif() and not image.info.get("xmp")


def test_palette_png_with_icc_is_converted_and_profile_stripped():
    from PIL import ImageCms

    stream = io.BytesIO()
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    Image.new("RGB", (100, 80), "blue").convert("P").save(stream, "PNG", icc_profile=profile)
    converted = portraits.normalize(assets.FileInput(stream.getvalue(), "image/png", ".png", "palette.png"))
    with Image.open(io.BytesIO(converted.content)) as image:
        assert image.size == (100, 80) and not image.info.get("icc_profile")


@pytest.fixture
def admin(seed_device_fn):
    seed_device_fn(device_id="photo-admin", permission="管理者", member_id=99, member_name="admin")
    return {"X-Device-Id": "photo-admin", "Idempotency-Key": str(uuid.uuid4())}


def test_create_stores_only_resized_portrait_and_replays_original_input(client, backend_env, admin, monkeypatch):
    raw = photo_bytes()
    payload = {"name": "New", "part": "Vn", "permission": "一般"}
    def submit():
        return client.post("/api/members", headers=admin, data=payload, files={"photo_file": ("big.jpg", raw, "image/jpeg")})
    first = submit()
    assert first.status_code == 200, first.text
    url = first.json()["photo_url"]
    assert url.endswith("ext=webp")
    image_response = client.get(url)
    assert image_response.status_code == 200
    assert image_response.content != raw
    with Image.open(io.BytesIO(image_response.content)) as image:
        assert image.size == (800, 533)
    monkeypatch.setattr(portraits, "normalize", lambda _file: (_ for _ in ()).throw(AssertionError("replay must not decode")))
    assert submit().json() == first.json()
    assert len(backend_env.load_json_data("members")) == 1


def test_predeploy_success_replays_without_changing_digest(client, backend_env, admin, monkeypatch):
    raw = photo_bytes((100, 80))
    original_normalize = portraits.normalize
    monkeypatch.setattr(portraits, "normalize", lambda file: file)
    def submit():
        return client.post("/api/members", headers=admin, data={"name": "Old", "part": "Vn", "permission": "一般"},
                           files={"photo_file": ("old.jpg", raw, "image/jpeg")})
    first = submit()
    assert first.status_code == 200
    monkeypatch.setattr(portraits, "normalize", original_normalize)
    assert submit().json() == first.json()


def test_invalid_photo_finishes_operation_and_preserves_old_reference(client, backend_env, admin):
    backend_env.save_json_data("members", [{"id": 1, "name": "Keep", "permission": "一般", "photo_url": "/old", "comment": "preserve"}])
    before = backend_env.load_json_data("members")
    for _ in range(2):
        response = client.put("/api/members/1/profile", headers=admin, files={"photo_file": ("broken.jpg", b"broken", "image/jpeg")})
        # Admin is not the owner: the existing authorization boundary holds.
        assert response.status_code == 403
    response = client.put("/api/members/1", headers=admin, data={"name": "Keep", "permission": "一般"}, files={"photo_file": ("broken.jpg", b"broken", "image/jpeg")})
    assert response.status_code == 422
    assert backend_env.load_json_data("members") == before


def test_migration_inline_is_field_limited_reentrant_and_conflict_safe(backend_env):
    raw = photo_bytes()
    inline = "data:image/jpeg;base64," + base64.b64encode(raw).decode()
    original = {"id": 1, "name": "Keep", "permission": "一般", "photo_url": inline, "password": "unchanged", "comment": "old", "created_at": "2026-06-01T00:00:00+09:00"}
    backend_env.save_json_data("members", [original])
    plan = migration.build_plan()
    assert plan["entries"][0]["state"] == "ready"
    assert backend_env.load_json_data("members")[0] == original
    assert "base64" not in str(plan) and "unchanged" not in str(plan)
    current = {**original, "comment": "concurrent profile edit"}
    backend_env.save_json_data("members", [current])
    report = asyncio.run(migration.apply_plan(plan, "test-normalize"))
    assert report["results"][0]["state"] == "converted"
    after = backend_env.load_json_data("members")[0]
    for key, value in current.items():
        if key != "photo_url":
            assert after[key] == value
    assert after["photo_url"].endswith("ext=webp")
    assert migration.build_plan()["entries"][0]["state"] == "normalized"
    assert asyncio.run(migration.apply_plan(plan, "test-normalize"))["results"][0]["state"] == "normalized"
    backend_env.save_json_data("members", [{**current, "photo_url": "/new-user-photo"}])
    assert asyncio.run(migration.apply_plan(plan, "test-normalize"))["results"][0]["state"] == "conflict"
    assert backend_env.load_json_data("members")[0]["photo_url"] == "/new-user-photo"


def test_migration_does_not_guess_legacy_files_or_write_in_dry_run(backend_env):
    backend_env.save_json_data("members", [{"id": 1, "photo_url": "/api/members/1/photo?ext=png"}])
    registry = backend_env.DATA_DIR / "portal-files-local.sqlite3"
    assert not registry.exists()
    assert migration.build_plan()["entries"][0]["state"] == "missing_source"
    assert not registry.exists()


def test_other_file_kinds_keep_original_bytes(client, backend_env, admin, monkeypatch):
    monkeypatch.setattr(portraits, "normalize", lambda _file: (_ for _ in ()).throw(AssertionError("not a member portrait")))
    raw = b"legacy-flyer-bytes"
    response = client.post("/api/performances", headers=admin, data={"title": "Concert", "date": "2026-10-20"}, files={"flyer_file": ("x.png", raw, "image/png")})
    assert response.status_code == 200, response.text
    assert client.get(response.json()["flyer_image"]).content == raw


def test_own_profile_photo_and_text_only_update(client, backend_env, seed_device_fn, monkeypatch):
    backend_env.save_json_data("members", [{"id": 1, "name": "Owner", "permission": "一般", "is_recording_manager": True}])
    seed_device_fn(device_id="photo-owner", member_id=1, permission="一般", member_name="Owner")
    headers = {"X-Device-Id": "photo-owner", "Idempotency-Key": str(uuid.uuid4())}
    response = client.put("/api/members/1/profile", headers=headers, data={"comment": "updated"},
                          files={"photo_file": ("portrait.jpg", photo_bytes(), "image/jpeg")})
    assert response.status_code == 200, response.text
    url = response.json()["photo_url"]
    with Image.open(io.BytesIO(client.get(url).content)) as image:
        assert max(image.size) == 800
    monkeypatch.setattr(portraits, "normalize", lambda _: (_ for _ in ()).throw(AssertionError("no new photo")))
    response = client.put("/api/members/1/profile", headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
                          json={"comment": "text only", "photo_url": url})
    assert response.status_code == 200, response.text
    saved = backend_env.load_json_data("members")[0]
    assert saved["photo_url"] == url and saved["comment"] == "text only"
    assert saved["is_recording_manager"] is True


def test_plan_cannot_be_applied_to_another_environment(backend_env):
    plan = migration.build_plan()
    plan["environment_fingerprint"] = "another-environment"
    with pytest.raises(ValueError, match="mismatch"):
        asyncio.run(migration.apply_plan(plan, "wrong-environment"))
    assert not (backend_env.DATA_DIR / "portal-files-local.sqlite3").exists()


def test_preexisting_marker_filename_is_not_proof_of_normalization(client, backend_env, admin, monkeypatch):
    from dataclasses import replace

    raw = photo_bytes((100, 80), fmt="WEBP")
    run = assets.run

    async def predeploy_run(operation, *args, **kwargs):
        return await run(replace(operation, prepare_file=None), *args, **kwargs)

    monkeypatch.setattr(assets, "run", predeploy_run)
    response = client.post("/api/members", headers=admin, data={"name": "Old", "permission": "一般"},
                           files={"photo_file": (portraits.FILENAME, raw, "image/webp")})
    assert response.status_code == 200, response.text
    assert migration.build_plan()["entries"][0]["state"] == "ready"
