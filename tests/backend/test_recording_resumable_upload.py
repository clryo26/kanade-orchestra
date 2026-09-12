from __future__ import annotations

import pytest
from fastapi import HTTPException

from src.backend.services import recording_upload_service as service


def test_create_recording_upload_session_accepts_200mb(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(service, "storage_enabled", lambda: True)

    def fake_create(object_name: str, **kwargs: object) -> str:
        captured["object_name"] = object_name
        captured.update(kwargs)
        return "https://storage.googleapis.com/upload-session"

    monkeypatch.setattr(service, "create_resumable_upload_session", fake_create)

    result = service.create_recording_upload_session(
        "practice.m4a",
        "2026-09-12",
        "Symphony",
        200 * 1024 * 1024,
        "audio/mp4",
        "https://portal.example",
    )

    assert result["mode"] == "gcs_resumable"
    assert result["size"] == 200 * 1024 * 1024
    assert captured["size"] == 200 * 1024 * 1024
    assert captured["origin"] == "https://portal.example"


def test_create_recording_upload_session_rejects_over_configured_limit() -> None:
    with pytest.raises(HTTPException) as error:
        service.create_recording_upload_session(
            "practice.mp3",
            "2026-09-12",
            "Symphony",
            service.MAX_RECORDING_UPLOAD_BYTES + 1,
            "audio/mpeg",
        )

    assert getattr(error.value, "status_code", None) == 413