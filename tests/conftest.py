from __future__ import annotations

from pathlib import Path
import sys

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture
def backend_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from src.backend import main as backend
    from src.backend.services import album_service

    data_dir = tmp_path / "data"
    upload_dir = tmp_path / "uploads"
    converted_dir = upload_dir / "converted"
    sheet_dir = upload_dir / "sheets"
    staging_dir = upload_dir / "drive-staging"

    for directory in (data_dir, upload_dir, converted_dir, sheet_dir, staging_dir):
        directory.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backend, "DATA_DIR", data_dir)
    monkeypatch.setattr(backend, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(backend, "CONVERTED_DIR", converted_dir)
    monkeypatch.setattr(backend, "SHEET_DIR", sheet_dir)
    monkeypatch.setattr(backend, "DRIVE_STAGING_DIR", staging_dir)
    # album_service imports UPLOAD_DIR directly; patch its module binding too so
    # album upload tests remain fully isolated under pytest's temporary directory.
    monkeypatch.setattr(album_service, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(backend, "storage_enabled", lambda: False)
    # Test fixtures operate on isolated JSON files and should not depend on the
    # caller shell's DB backend environment.
    monkeypatch.setenv("DATA_BACKEND", "local")
    monkeypatch.setenv("LOCAL_JSON_FALLBACK_ENABLED", "true")
    backend._memory_cache.clear()

    for name in backend.JSON_DATA_NAMES:
        backend.save_json_data(name, [])

    return backend


@pytest.fixture
def client(backend_env):
    from fastapi.testclient import TestClient

    return TestClient(backend_env.app)


def seed_device(
    backend_env,
    *,
    device_id: str,
    permission: str,
    member_name: str = "",
    member_id=None,
    is_recording_manager: bool = False,
    is_sheet_manager: bool = False,
):
    devices = backend_env.load_json_data("auth_devices")
    devices.append(
        {
            "id": backend_env.next_id(devices),
            "device_id": device_id,
            "member_id": member_id,
            "member_name": member_name,
            "permission": permission,
            "is_recording_manager": is_recording_manager,
            "is_sheet_manager": is_sheet_manager,
            "authenticated_at": "2026-06-18T00:00:00",
            "last_seen_at": "2026-06-18T00:00:00",
        }
    )
    backend_env.save_json_data("auth_devices", devices)


def admin_headers() -> dict[str, str]:
    return {"X-Device-Id": "dev-admin"}


@pytest.fixture
def seed_device_fn(backend_env):
    def _seed(**kwargs):
        return seed_device(backend_env, **kwargs)

    return _seed


@pytest.fixture
def admin_headers_fixture() -> dict[str, str]:
    return admin_headers()
