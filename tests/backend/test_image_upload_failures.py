from __future__ import annotations

import asyncio
from dataclasses import dataclass

from src.backend.services import image_asset_service, member_service, performance_service


@dataclass
class FakeUploadFile:
    filename: str
    content_type: str
    content: bytes

    async def read(self) -> bytes:
        return self.content


def test_member_create_rolls_back_when_photo_upload_fails(backend_env, monkeypatch):
    async def _boom(*args, **kwargs):
        raise RuntimeError("upload failed")

    monkeypatch.setattr(member_service, "store_uploaded_image", _boom)

    payload = {
        "name": "Test Member",
        "last_name": "Test",
        "first_name": "Member",
        "part": "Vn",
        "permission": "一般",
        "password": "",
        "photo_url": "",
        "is_founder": False,
        "is_recording_manager": False,
        "is_sheet_manager": False,
        "joined_at": "",
        "system_access_until": "",
        "introducer": "",
        "role": "",
        "instrument_history": "",
        "past_orchestras": "",
        "comment": "",
    }

    try:
        asyncio.run(
            member_service.create_member(
                payload,
                photo_file=FakeUploadFile("photo.png", "image/png", b"image-bytes"),
            )
        )
    except RuntimeError as exc:
        assert "upload failed" in str(exc)
    else:  # pragma: no cover - defensive guard
        raise AssertionError("upload failure should bubble up")

    assert backend_env.load_json_data("members") == []


def test_member_update_deletes_uploaded_photo_when_db_update_fails(backend_env, monkeypatch):
    monkeypatch.setattr(image_asset_service, "UPLOAD_DIR", backend_env.UPLOAD_DIR)
    backend_env.save_json_data(
        "members",
        [
            {
                "id": 1,
                "name": "Test Member",
                "last_name": "Test",
                "first_name": "Member",
                "part": "Vn",
                "photo_url": "",
                "permission": "一般",
                "password": "",
                "created_at": "2026-08-01T00:00:00",
                "updated_at": "2026-08-01T00:00:00",
            }
        ],
    )

    async def _store_uploaded_image(*args, **kwargs):
        object_name = backend_env.UPLOAD_DIR / "member-images" / "1" / "photo.png"
        object_name.parent.mkdir(parents=True, exist_ok=True)
        object_name.write_bytes(b"uploaded-image")
        return "/api/members/1/photo?ext=png"

    def _fail_update(*args, **kwargs):
        raise RuntimeError("db update failed")

    monkeypatch.setattr(member_service, "store_uploaded_image", _store_uploaded_image)
    monkeypatch.setattr(member_service._repo, "update", _fail_update)

    payload = {
        "name": "Test Member",
        "last_name": "Test",
        "first_name": "Member",
        "part": "Vn",
        "permission": "一般",
        "password": "",
        "photo_url": "",
        "is_founder": False,
        "is_recording_manager": False,
        "is_sheet_manager": False,
        "joined_at": "",
        "system_access_until": "",
        "introducer": "",
        "role": "",
        "instrument_history": "",
        "past_orchestras": "",
        "comment": "",
    }

    try:
        asyncio.run(
            member_service.update_member(
                1,
                payload,
                photo_file=FakeUploadFile("photo.png", "image/png", b"image-bytes"),
            )
        )
    except RuntimeError as exc:
        assert "db update failed" in str(exc)
    else:  # pragma: no cover - defensive guard
        raise AssertionError("db failure should bubble up")

    assert not (backend_env.UPLOAD_DIR / "member-images" / "1" / "photo.png").exists()
    assert backend_env.load_json_data("members")[0]["photo_url"] == ""


def test_performance_update_replaces_old_flyer_image(backend_env, monkeypatch):
    monkeypatch.setattr(image_asset_service, "UPLOAD_DIR", backend_env.UPLOAD_DIR)
    old_image = backend_env.UPLOAD_DIR / "performance-flyers" / "1" / "flyer.jpg"
    old_image.parent.mkdir(parents=True, exist_ok=True)
    old_image.write_bytes(b"old-image")
    backend_env.save_json_data(
        "performances",
        [
            {
                "id": 1,
                "title": "Concert",
                "date": "2026-08-01",
                "open_time": "18:00",
                "start_time": "19:00",
                "venue": "Hall",
                "conductor": "Cond",
                "flyer_image": "/api/performances/1/flyer-image?ext=jpg",
                "performance_fee_amount": 0,
                "pieces": [],
                "created_at": "2026-08-01T00:00:00",
                "updated_at": "2026-08-01T00:00:00",
            }
        ],
    )

    payload = {
        "title": "Concert",
        "date": "2026-08-01",
        "open_time": "18:00",
        "start_time": "19:00",
        "venue": "Hall",
        "conductor": "Cond",
        "flyer_image": "/api/performances/1/flyer-image?ext=jpg",
        "performance_fee_amount": 0,
        "pieces": [],
    }

    updated = asyncio.run(
        performance_service.update_performance(
            1,
            payload,
            flyer_file=FakeUploadFile("flyer.png", "image/png", b"new-image"),
        )
    )

    assert updated["flyer_image"] == "/api/performances/1/flyer-image?ext=png"
    assert not old_image.exists()
    assert (backend_env.UPLOAD_DIR / "performance-flyers" / "1" / "flyer.png").exists()
