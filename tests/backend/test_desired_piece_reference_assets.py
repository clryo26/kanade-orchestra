from __future__ import annotations

import json
import uuid
from urllib.error import HTTPError, URLError

import pytest
from fastapi.testclient import TestClient

from src.backend.services import extra_service, youtube_validation_service


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


def _assets(backend_env):
    from src.backend.repositories import portal_file_repository as file_repo

    with file_repo.local_transaction() as cur:
        cur.execute("SELECT asset_id, owner_id, state, object_name FROM portal_file_assets ORDER BY created_at")
        return [dict(zip(("asset_id", "owner_id", "state", "object_name"), row)) for row in cur.fetchall()]


def test_desired_piece_reference_score_pdf_roundtrip_and_cleanup(client, backend_env, seed_device_fn):
    """JST spec R06: confirmed references, UUID keys, reclaim after commit (T11/T12)."""
    _seed_owner(seed_device_fn)
    key = str(uuid.uuid4())
    headers = {"X-Device-Id": "dev-owner", "Idempotency-Key": key}

    created = client.post(
        "/api/extra/desired_pieces",
        headers=headers,
        data={"payload": json.dumps(_desired_piece_payload())},
        files={"reference_score_file": ("score.pdf", _pdf_bytes("first"), "application/pdf")},
    )
    assert created.status_code == 200, created.text
    body = created.json()
    first_url = body["reference_score_url"]
    assert first_url.startswith(f"/api/extra/desired_pieces/{body['id']}/reference_score?asset=")
    [first] = _assets(backend_env)
    assert first["state"] == "active" and first["owner_id"] == body["id"]

    pinned = client.get(first_url, headers={"X-Device-Id": "dev-owner"})
    assert pinned.status_code == 200
    assert pinned.content == _pdf_bytes("first")
    assert pinned.headers["content-type"].startswith("application/pdf")
    assert "inline" in pinned.headers["content-disposition"].lower()
    assert pinned.headers["cache-control"] == "private, max-age=3600"
    current = client.get(f"/api/extra/desired_pieces/{body['id']}/reference_score")
    assert current.status_code == 200 and current.headers["cache-control"] == "no-cache"

    # Same key, same content: stored result, no second upload (T19).
    replay = client.post(
        "/api/extra/desired_pieces",
        headers=headers,
        data={"payload": json.dumps(_desired_piece_payload())},
        files={"reference_score_file": ("score.pdf", _pdf_bytes("first"), "application/pdf")},
    )
    assert replay.status_code == 200 and replay.json() == body
    assert len(_assets(backend_env)) == 1
    assert len(backend_env.load_json_data("desired_pieces")) == 1

    updated = client.put(
        f"/api/extra/desired_pieces/{body['id']}",
        headers={"X-Device-Id": "dev-owner", "Idempotency-Key": str(uuid.uuid4())},
        data={"payload": json.dumps({**body, "notes": "updated"}), "expected_updated_at": body["updated_at"]},
        files={"reference_score_file": ("score-updated.pdf", _pdf_bytes("second"), "application/pdf")},
    )
    assert updated.status_code == 200, updated.text
    states = {asset["asset_id"]: asset["state"] for asset in _assets(backend_env)}
    assert states[first["asset_id"]] == "retired"
    assert sorted(states.values()) == ["active", "retired"]
    # The old version stays readable during the grace period (version-pinned URL).
    assert client.get(first_url).content == _pdf_bytes("first")
    assert client.get(f"/api/extra/desired_pieces/{body['id']}/reference_score").content == _pdf_bytes("second")

    deleted = client.delete(
        f"/api/extra/desired_pieces/{body['id']}",
        headers={"X-Device-Id": "dev-owner", "Idempotency-Key": str(uuid.uuid4())},
    )
    assert deleted.status_code == 200
    assert backend_env.load_json_data("desired_pieces") == []
    assert sorted(asset["state"] for asset in _assets(backend_env)) == ["retired", "retired"]
    # Files are only removed by the reconciliation after the grace period.
    for asset in _assets(backend_env):
        assert (backend_env.UPLOAD_DIR / asset["object_name"]).exists()


def test_desired_piece_reference_score_rejects_non_pdf(client, backend_env, seed_device_fn):
    _seed_owner(seed_device_fn)
    response = client.post(
        "/api/extra/desired_pieces",
        headers={"X-Device-Id": "dev-owner", "Idempotency-Key": str(uuid.uuid4())},
        data={"payload": json.dumps(_desired_piece_payload())},
        files={"reference_score_file": ("score.txt", b"not-a-pdf", "text/plain")},
    )
    assert response.status_code == 400
    assert _assets(backend_env) == []


def test_desired_piece_reference_score_requires_operation_key(client, backend_env, seed_device_fn):
    _seed_owner(seed_device_fn)
    response = client.post(
        "/api/extra/desired_pieces",
        headers={"X-Device-Id": "dev-owner"},
        data={"payload": json.dumps(_desired_piece_payload())},
        files={"reference_score_file": ("score.pdf", _pdf_bytes(), "application/pdf")},
    )
    assert response.status_code == 428
    assert backend_env.load_json_data("desired_pieces") == []


def test_desired_piece_reference_score_save_failure_never_publishes_the_upload(backend_env, seed_device_fn, monkeypatch):
    _seed_owner(seed_device_fn)
    real_store = extra_service._store

    class FailingStore:
        def __getattr__(self, name):
            return getattr(real_store(), name)

        def insert(self, *args, **kwargs):
            raise RuntimeError("save failed")

    monkeypatch.setattr(extra_service, "_store", lambda: FailingStore())
    rollback_client = TestClient(backend_env.app, raise_server_exceptions=False)
    key = str(uuid.uuid4())
    response = rollback_client.post(
        "/api/extra/desired_pieces",
        headers={"X-Device-Id": "dev-owner", "Idempotency-Key": key},
        data={"payload": json.dumps(_desired_piece_payload())},
        files={"reference_score_file": ("rollback.pdf", _pdf_bytes("rollback"), "application/pdf")},
    )
    # Outcome unknown to the client: retry the same key; nothing was published.
    assert response.status_code == 503
    assert backend_env.load_json_data("desired_pieces") == []
    [asset] = _assets(backend_env)
    assert asset["state"] == "delete_pending"
    status = rollback_client.get(f"/api/portal-file-operations/{key}", headers={"X-Device-Id": "dev-owner"})
    assert status.status_code == 202  # lease released, may resume with the same key
