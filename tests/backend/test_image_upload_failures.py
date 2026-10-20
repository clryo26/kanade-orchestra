"""Common image (member photo / performance flyer) file operations (JST spec R05-B, R06; T11/T12/T20).

The pre-JST contract deleted or overwrote fixed-name files immediately. The
approved contract (spec 1.6, R06): UUID keys, an operation key per change,
DB-confirmed references only, and reclamation after commit by ``cleanup``.
"""
from __future__ import annotations

import io
from PIL import Image


import asyncio
import uuid
from dataclasses import dataclass

import pytest
from fastapi import HTTPException

from src.backend.services import member_service, performance_service
from src.backend.services import portal_file_asset_service as file_assets
from src.backend.repositories import portal_file_repository as file_repo

def _portrait_bytes():
    output = io.BytesIO()
    Image.new("RGB", (32, 24), "blue").save(output, format="PNG")
    return output.getvalue()


ADMIN = {"member_id": 99, "member_name": "Admin", "permission": "管理者"}


@dataclass
class FakeUploadFile:
    filename: str
    content_type: str
    content: bytes

    async def read(self, size: int = -1) -> bytes:
        data, self.content = self.content, b""
        return data


def _member_payload(**overrides):
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
    payload.update(overrides)
    return payload


def _assets():
    with file_repo.local_transaction() as cur:
        cur.execute("SELECT asset_id, kind, owner_id, state, object_name FROM portal_file_assets ORDER BY created_at")
        return [dict(zip(("asset_id", "kind", "owner_id", "state", "object_name"), row)) for row in cur.fetchall()]


def test_photo_change_without_operation_key_is_428(backend_env):
    with pytest.raises(HTTPException) as error:
        asyncio.run(
            member_service.create_member(
                _member_payload(), photo_file=FakeUploadFile("photo.png", "image/png", b"img"), device=ADMIN
            )
        )
    assert error.value.status_code == 428
    assert backend_env.load_json_data("members") == []
    assert _assets() == []


def test_member_create_upload_failure_leaves_no_row_and_no_referenced_file(backend_env, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("upload failed")

    monkeypatch.setattr(file_assets, "upload", boom)
    response = asyncio.run(
        member_service.create_member(
            _member_payload(),
            photo_file=FakeUploadFile("photo.png", "image/png", _portrait_bytes()),
            device=ADMIN,
            idempotency_key=str(uuid.uuid4()),
        )
    )
    # Result unknown -> same key must be retried; nothing was committed.
    assert response.status_code == 503
    assert backend_env.load_json_data("members") == []
    assert [asset["state"] for asset in _assets()] == ["delete_pending"]


def test_member_update_db_failure_keeps_old_photo_and_reclaims_upload_after_commit(backend_env, monkeypatch):
    backend_env.save_json_data(
        "members",
        [{**_member_payload(), "id": 1, "created_at": "2026-08-01T00:00:00+09:00", "updated_at": "2026-08-01T00:00:00+09:00"}],
    )
    real_store = member_service._store

    class FailingStore:
        def __getattr__(self, name):
            return getattr(real_store(), name)

        def update(self, *args, **kwargs):
            raise RuntimeError("db update failed")

    monkeypatch.setattr(member_service, "_store", lambda: FailingStore())
    response = asyncio.run(
        member_service.update_member(
            1,
            _member_payload(),
            photo_file=FakeUploadFile("photo.png", "image/png", _portrait_bytes()),
            device=ADMIN,
            idempotency_key=str(uuid.uuid4()),
        )
    )
    assert response.status_code == 503
    assert backend_env.load_json_data("members")[0]["photo_url"] == ""
    [asset] = _assets()
    assert asset["state"] == "delete_pending"
    uploaded = backend_env.UPLOAD_DIR / asset["object_name"]
    assert uploaded.exists()  # never deleted before the DB decided
    result = file_assets.cleanup(execute=True)
    assert result["executed"] is True
    assert not uploaded.exists()
    assert _assets()[0]["state"] == "deleted"


def test_performance_flyer_replacement_serves_only_the_confirmed_asset(backend_env):
    legacy = backend_env.UPLOAD_DIR / "performance-flyers" / "1" / "flyer.jpg"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_bytes(b"old-image")
    backend_env.save_json_data(
        "performances",
        [
            {
                "id": 1, "title": "Concert", "date": "2026-08-01", "open_time": "18:00", "start_time": "19:00",
                "venue": "Hall", "conductor": "Cond", "flyer_image": "/api/performances/1/flyer-image?ext=jpg",
                "performance_fee_amount": 0, "pieces": [],
                "created_at": "2026-08-01T00:00:00+09:00", "updated_at": "2026-08-01T00:00:00+09:00",
            }
        ],
    )
    payload = {
        "title": "Concert", "date": "2026-08-01", "open_time": "18:00", "start_time": "19:00", "venue": "Hall",
        "conductor": "Cond", "flyer_image": "/api/performances/1/flyer-image?ext=jpg", "performance_fee_amount": 0,
        "pieces": [],
    }
    # Unmigrated legacy flyer: not DB-confirmed, so it is not served (spec 1.6).
    try:
        performance_service.flyer_response(1, None)
    except Exception as exc:  # HTTPException 404
        assert getattr(exc, "status_code", None) == 404
    response = asyncio.run(
        performance_service.update_performance(
            1, payload, flyer_file=FakeUploadFile("flyer.png", "image/png", b"new-image"),
            device=ADMIN, idempotency_key=str(uuid.uuid4()),
        )
    )
    assert response.status_code == 200
    stored = backend_env.load_json_data("performances")[0]["flyer_image"]
    assert stored.startswith("/api/performances/1/flyer-image?asset=") and stored.endswith("&ext=png")
    served = performance_service.flyer_response(1, None)
    assert served.body == b"new-image"
    assert served.headers["cache-control"] == "no-cache"
    pinned = performance_service.flyer_response(1, stored.split("asset=")[1].split("&")[0])
    assert pinned.headers["cache-control"] == "private, max-age=3600"
    # The legacy fixed-name file is never deleted by prefix/guess.
    assert legacy.exists()
