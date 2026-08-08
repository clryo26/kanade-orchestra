from __future__ import annotations

import json
from urllib.error import HTTPError, URLError

import pytest
from fastapi.testclient import TestClient

from src.backend.services import desired_piece_asset_service, extra_service, youtube_validation_service


pytestmark = pytest.mark.db_profile


def _seed_owner(seed_device_fn) -> None:
    seed_device_fn(
        device_id="dev-owner",
        permission="荳闊ｬ",
        member_id="member-owner",
        member_name="owner-a",
    )


def _pdf_bytes(label: str = "sample") -> bytes:
    return (
        "%PDF-1.4\n"
        f"%{label}\n"
        "1 0 obj\n"
        "<<>>\n"
        "endobj\n"
        "trailer\n"
        "<<>>\n"
        "%%EOF\n"
    ).encode("ascii")


def _desired_piece_payload(**overrides):
    payload = {
        "title": "Wish",
        "composer": "Composer",
        "duration": "5:00",
        "genre": "クラシック",
        "formation": "Orchestra",
        "reference_audio_url": "",
        "reference_score_url": "",
        "notes": "memo",
        "votes": [],
    }
    payload.update(overrides)
    return payload


def test_desired_piece_reference_audio_validation(client, seed_device_fn, monkeypatch):
    _seed_owner(seed_device_fn)
    headers = {"X-Device-Id": "dev-owner"}

    class FakeOEmbedResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b"{}"

    def fake_urlopen(request, timeout=5):
        return FakeOEmbedResponse()

    monkeypatch.setattr(youtube_validation_service, "urlopen", fake_urlopen)

    created = client.post(
        "/api/extra/desired_pieces",
        headers=headers,
        json=_desired_piece_payload(reference_audio_url="https://youtu.be/abcdefghijk"),
    )
    assert created.status_code == 200
    assert created.json()["reference_audio_url"] == "https://www.youtube.com/watch?v=abcdefghijk"

    invalid = client.post(
        "/api/extra/desired_pieces",
        headers=headers,
        json=_desired_piece_payload(reference_audio_url="https://example.com/watch?v=abcdefghijk"),
    )
    assert invalid.status_code == 400

    def fake_not_found(request, timeout=5):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        raise HTTPError(url, 404, "Not Found", hdrs=None, fp=None)

    monkeypatch.setattr(youtube_validation_service, "urlopen", fake_not_found)
    missing = client.post(
        "/api/extra/desired_pieces",
        headers=headers,
        json=_desired_piece_payload(reference_audio_url="https://www.youtube.com/watch?v=abcdefghijk"),
    )
    assert missing.status_code == 400

    def fake_unavailable(request, timeout=5):
        raise URLError("temporary")

    monkeypatch.setattr(youtube_validation_service, "urlopen", fake_unavailable)
    transient = client.post(
        "/api/extra/desired_pieces",
        headers=headers,
        json=_desired_piece_payload(reference_audio_url="https://www.youtube.com/watch?v=abcdefghijk"),
    )
    assert transient.status_code == 503


def test_desired_piece_owner_cannot_rename_after_vote(client, seed_device_fn):
    _seed_owner(seed_device_fn)
    headers = {"X-Device-Id": "dev-owner"}

    created = client.post(
        "/api/extra/desired_pieces",
        headers=headers,
        json=_desired_piece_payload(votes=[{"member_id": "member-owner", "name": "owner-a"}]),
    )
    assert created.status_code == 200
    body = created.json()

    blocked = client.put(
        f"/api/extra/desired_pieces/{body['id']}",
        headers=headers,
        json={
            "payload": {**body, "title": "Renamed wish"},
            "expected_updated_at": body["updated_at"],
        },
    )
    assert blocked.status_code == 403

    updated = client.put(
        f"/api/extra/desired_pieces/{body['id']}",
        headers=headers,
        json={
            "payload": {**body, "notes": "Updated notes"},
            "expected_updated_at": body["updated_at"],
        },
    )
    assert updated.status_code == 200
    assert updated.json()["notes"] == "Updated notes"


def test_desired_piece_reference_score_pdf_roundtrip_and_cleanup(
    client,
    backend_env,
    seed_device_fn,
    monkeypatch,
):
    _seed_owner(seed_device_fn)
    headers = {"X-Device-Id": "dev-owner"}

    monkeypatch.setattr(desired_piece_asset_service, "UPLOAD_DIR", backend_env.UPLOAD_DIR)
    monkeypatch.setattr(desired_piece_asset_service, "DRIVE_STAGING_DIR", backend_env.DRIVE_STAGING_DIR)
    monkeypatch.setattr(desired_piece_asset_service, "storage_enabled", lambda: False)

    created = client.post(
        "/api/extra/desired_pieces",
        headers=headers,
        data={"payload": json.dumps(_desired_piece_payload())},
        files={"reference_score_file": ("score.pdf", _pdf_bytes("first"), "application/pdf")},
    )
    assert created.status_code == 200
    body = created.json()
    assert body["reference_score_url"] == f"/api/extra/desired_pieces/{body['id']}/reference_score"

    score_dir = backend_env.UPLOAD_DIR / "desired_piece_reference_scores" / str(body["id"])
    stored_files = list(score_dir.glob("*.pdf"))
    assert len(stored_files) == 1

    response = client.get(body["reference_score_url"], headers=headers)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/pdf")
    assert "inline" in response.headers["content-disposition"].lower()

    updated = client.put(
        f"/api/extra/desired_pieces/{body['id']}",
        headers=headers,
        data={
            "payload": json.dumps({**body, "notes": "updated"}),
            "expected_updated_at": body["updated_at"],
        },
        files={"reference_score_file": ("score-updated.pdf", _pdf_bytes("second"), "application/pdf")},
    )
    assert updated.status_code == 200
    remaining_files = list(score_dir.glob("*.pdf"))
    assert len(remaining_files) == 1
    assert remaining_files[0].name != stored_files[0].name

    deleted = client.delete(
        f"/api/extra/desired_pieces/{body['id']}",
        headers=headers,
    )
    assert deleted.status_code == 200
    assert not list(score_dir.glob("*.pdf"))


def test_desired_piece_reference_score_rejects_non_pdf(client, backend_env, seed_device_fn, monkeypatch):
    _seed_owner(seed_device_fn)
    headers = {"X-Device-Id": "dev-owner"}

    monkeypatch.setattr(desired_piece_asset_service, "UPLOAD_DIR", backend_env.UPLOAD_DIR)
    monkeypatch.setattr(desired_piece_asset_service, "DRIVE_STAGING_DIR", backend_env.DRIVE_STAGING_DIR)
    monkeypatch.setattr(desired_piece_asset_service, "storage_enabled", lambda: False)

    response = client.post(
        "/api/extra/desired_pieces",
        headers=headers,
        data={"payload": json.dumps(_desired_piece_payload())},
        files={"reference_score_file": ("score.txt", b"not-a-pdf", "text/plain")},
    )
    assert response.status_code == 400


def test_desired_piece_reference_score_rolls_back_on_save_failure(
    backend_env,
    seed_device_fn,
    monkeypatch,
):
    _seed_owner(seed_device_fn)
    headers = {"X-Device-Id": "dev-owner"}

    monkeypatch.setattr(desired_piece_asset_service, "UPLOAD_DIR", backend_env.UPLOAD_DIR)
    monkeypatch.setattr(desired_piece_asset_service, "DRIVE_STAGING_DIR", backend_env.DRIVE_STAGING_DIR)
    monkeypatch.setattr(desired_piece_asset_service, "storage_enabled", lambda: False)

    def fail_save_json_data(name, items):
        raise RuntimeError("save failed")

    monkeypatch.setattr(extra_service, "save_json_data", fail_save_json_data)

    rollback_client = TestClient(backend_env.app, raise_server_exceptions=False)
    response = rollback_client.post(
        "/api/extra/desired_pieces",
        headers=headers,
        data={"payload": json.dumps(_desired_piece_payload())},
        files={"reference_score_file": ("rollback.pdf", _pdf_bytes("rollback"), "application/pdf")},
    )
    assert response.status_code == 500

    score_dir = backend_env.UPLOAD_DIR / "desired_piece_reference_scores" / "1"
    if score_dir.exists():
        assert not list(score_dir.glob("*.pdf"))
