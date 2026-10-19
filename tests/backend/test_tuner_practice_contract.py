"""Tuner practice history: contracts that run without a database."""
from __future__ import annotations

import math
from pathlib import Path

import pytest
from fastapi import HTTPException

from src.backend.services import tuner_service

ROOT = Path(__file__).resolve().parents[2]


def test_migration_defines_owner_generation_tombstones_and_member_triggers():
    sql = (ROOT / "db/migrations/017_tuner_practice.sql").read_text(encoding="utf-8")
    for table in ("tuner_owners", "tuner_preferences", "tuner_instruments", "tuner_presets", "tuner_sessions", "tuner_upload_parts", "tuner_note_events", "tuner_tombstones"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql
    # Owners carry the member generation and only one active owner per member id.
    assert "member_birth TIMESTAMPTZ NOT NULL" in sql
    assert "WHERE revoked_at IS NULL" in sql
    # Member deletion and id reuse revoke the owner in the database itself.
    assert "AFTER DELETE ON members" in sql
    assert "AFTER INSERT ON members" in sql
    # No audio / series storage in the DB.
    lowered = sql.lower()
    for forbidden in ("pcm", "audio_data", "series_chunks", "spectrogram", "bytea"):
        assert forbidden not in lowered
    assert "CHECK (event_count >= 0 AND event_count <= 10000" in sql


def test_router_uses_system_admin_scope_and_has_no_cross_owner_endpoint():
    source = (ROOT / "src/backend/routers/tuner.py").read_text(encoding="utf-8")
    assert "Depends(get_system_admin_device_auth)" in source
    assert 'APIRouter(prefix="/api/tuner")' in source
    assert "owner_id" not in source and "ownerId" not in source  # never chosen by the client
    registry = (ROOT / "src/backend/core/router_registry.py").read_text(encoding="utf-8")
    assert '_import_router("..routers.tuner", "routers.tuner")' in registry


def test_identity_without_database_or_member_reports_no_account_storage(monkeypatch):
    monkeypatch.setattr(tuner_service, "db_data_enabled", lambda: False)
    assert tuner_service.identity({"member_id": 1})["accountStorageAvailable"] is False
    monkeypatch.setattr(tuner_service, "db_data_enabled", lambda: True)
    assert tuner_service.identity({"member_id": None, "hidden_user": True})["accountStorageAvailable"] is False
    with pytest.raises(HTTPException) as exc:
        tuner_service.list_sessions({"member_id": None, "hidden_user": True}, {})
    assert exc.value.status_code == 403


def test_stale_device_is_refused_before_any_owner_is_created(monkeypatch):
    from datetime import datetime, timezone

    calls = []

    class Repo:
        def member_birth(self, org, member_id):
            return datetime(2026, 10, 1, tzinfo=timezone.utc)

        def resolve_owner(self, *args, **kwargs):
            calls.append(args)
            return {"id": "x", "history_epoch": 1}

    monkeypatch.setattr(tuner_service, "db_data_enabled", lambda: True)
    monkeypatch.setattr(tuner_service, "_repository", lambda: Repo())
    with pytest.raises(HTTPException) as exc:
        tuner_service.resolve_owner({"member_id": 5, "authenticated_at": "2026-09-30T00:00:00+00:00"})
    assert exc.value.detail["code"] == "REAUTH_REQUIRED"
    assert calls == []
    with pytest.raises(HTTPException):
        tuner_service.resolve_owner({"member_id": 5})  # no authentication time at all
    assert tuner_service.resolve_owner({"member_id": 5, "authenticated_at": "2026-10-02T00:00:00Z"})["ownerId"] == "x"


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_non_finite_numbers_are_rejected(value):
    with pytest.raises(HTTPException) as exc:
        tuner_service._check_json({"a": [1, {"b": value}]}, max_bytes=1000)
    assert exc.value.status_code == 400


def test_json_limits_text_and_depth():
    with pytest.raises(HTTPException):
        tuner_service._check_json("x" * 2001, max_bytes=10_000)
    deep: dict = {}
    node = deep
    for _ in range(10):
        node["n"] = {}
        node = node["n"]
    with pytest.raises(HTTPException):
        tuner_service._check_json(deep, max_bytes=10_000)
    with pytest.raises(HTTPException) as exc:
        tuner_service._object({"a": "x" * 1500, "b": "y" * 1500}, "summary", 2000)
    assert exc.value.status_code == 413


def test_csv_cells_never_start_a_formula():
    for raw in ("=SUM(A1)", "+1", "-1", "@x", "\tx", "\rx"):
        assert tuner_service._csv_cell(raw).startswith("'")
    assert tuner_service._csv_cell("C4") == "C4"
    assert tuner_service._csv_cell(math.nan) == ""


def test_member_deletion_calls_the_tuner_revoke_hook(monkeypatch):
    from src.backend.services import member_service

    import asyncio

    seen = []
    # A member without a confirmed photo is deleted row level (no file operation).
    monkeypatch.setattr(member_service.file_assets, "has_active_asset", lambda kind, owner_id: False)
    monkeypatch.setattr(member_service._repo, "delete", lambda member_id, authorize=None: None)
    monkeypatch.setattr(tuner_service, "revoke_member", lambda member_id: seen.append(member_id))
    asyncio.run(member_service.delete_member(42))
    assert seen == [42]


def test_revoke_hook_never_blocks_member_deletion(monkeypatch):
    class Broken:
        def revoke_member(self, *args):
            raise RuntimeError("tables missing")

    monkeypatch.setattr(tuner_service, "db_data_enabled", lambda: True)
    monkeypatch.setattr(tuner_service, "_repository", lambda: Broken())
    tuner_service.revoke_member(7)  # logs, does not raise
