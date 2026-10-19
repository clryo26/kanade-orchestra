from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

if importlib.util.find_spec("fastapi") is not None:
    from fastapi.testclient import TestClient
    from src.backend import main as backend
    from src.backend.services import album_service
else:
    TestClient = None
    backend = None
    album_service = None


@pytest.fixture
def backend_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    if backend is None or album_service is None:
        pytest.fail("backend test dependencies are unavailable")

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
    # Tests that simulate DB mode patch db_load_json_data/db_replace_collection
    # with an in-memory store. Give them the matching simulated row store so
    # row-level writes go to the same fake (looked up lazily, after patches).
    # The real PostgreSQL row semantics are covered by the opt-in
    # test_db_item_repository_postgres.py suite.
    from src.backend.repositories.db_item_repository import ListRowStore

    simulated_row_store = ListRowStore(
        load=lambda name: backend.db_load_json_data(name),
        save=lambda name, data: backend.db_replace_collection(name, data),
    )
    monkeypatch.setattr(backend, "db_row_store", lambda: simulated_row_store)

    # Session writes in simulated DB mode: same contracts as the real
    # repository (login stamped by the store; the session check touches only
    # while the device still belongs to the same member), built on the
    # possibly patched db_load_json_data/db_upsert_auth_device.
    from src.backend.utils.datetime_utils import format_instant, jst_now

    def simulated_record_login(device):
        now = format_instant(jst_now())
        return backend.db_upsert_auth_device({**device, "authenticated_at": now, "last_seen_at": now})

    def simulated_touch(device_id, member_id, member_fields):
        current = next((d for d in backend.db_load_json_data("auth_devices") if d.get("device_id") == device_id), None)
        if not current or current.get("member_id") != member_id:
            return None
        generation = "authenticated_at" if member_fields.get("authenticated_at") else "created_at"
        if member_fields.get(generation) and current.get(generation) != member_fields[generation]:
            return None
        allowed = ("member_name", "member_part", "permission", "system_access_until", "is_recording_manager", "is_sheet_manager")
        updated = {**current, **{k: member_fields[k] for k in allowed if k in member_fields}, "last_seen_at": format_instant(jst_now())}
        return backend.db_upsert_auth_device(updated)

    def simulated_mutate(name, mutator):
        # Locked read-modify-write over the same (possibly patched) DB fakes.
        if name in backend.JSON_COLLECTION_TABLES:
            load, save = backend.db_load_json_data, backend.db_replace_collection
        else:
            load, save = backend.db_load_generic_json_collection, backend.db_save_generic_json_collection
        updated = list(mutator([dict(item) for item in load(name)]))
        save(name, updated)
        backend._memory_cache.invalidate(name)
        return updated

    monkeypatch.setattr(backend, "db_mutate_collection_locked", simulated_mutate)
    monkeypatch.setattr(backend, "db_record_login", simulated_record_login)
    monkeypatch.setattr(backend, "db_touch_auth_device", simulated_touch)
    backend._memory_cache.clear_all_tenants()

    for name in backend.JSON_DATA_NAMES:
        backend.save_json_data(name, [])

    return backend


@pytest.fixture
def client(backend_env):
    if TestClient is None:
        pytest.fail("FastAPI test client is unavailable")

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
