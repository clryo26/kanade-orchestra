"""Metronome practice history: contracts that run without a database (MT-14 / MT-20)."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from src.backend.services import metronome_service

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "db/migrations/019_metronome_practice.sql"
TABLES = ("metronome_preferences", "metronome_sessions", "metronome_summary_groups", "metronome_upload_parts", "metronome_presets", "metronome_tombstones", "metronome_operations")


def test_migration_is_additive_summary_only_and_cleans_up_on_owner_revocation():
    sql = MIGRATION.read_text(encoding="utf-8")
    for table in TABLES:
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql
    # Individual observations are never stored on the account.
    assert "CHECK (event_count = 0)" in sql
    assert "metronome_timing_events" not in sql
    assert "CHECK (part_index = 0)" in sql
    assert "jsonb_array_length(groups) <= 256" in sql
    assert "duration_ms BETWEEN 0 AND 1800000" in sql
    # Owner revocation removes metronome data; 017 objects are not replaced.
    assert "AFTER UPDATE OF revoked_at ON tuner_owners" in sql
    assert "CREATE OR REPLACE FUNCTION tuner_" not in sql
    ddl = " ".join(line.split("--", 1)[0] for line in sql.splitlines()).lower()
    for forbidden in ("pcm", "audio", "bytea", "offset_ms", "device_id", "drop table"):
        assert forbidden not in ddl
    # The migration file is UTF-8 without BOM, LF only.
    raw = MIGRATION.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")
    assert b"\r\n" not in raw


def test_router_is_laboratory_scoped_personal_and_registered():
    source = (ROOT / "src/backend/routers/metronome.py").read_text(encoding="utf-8")
    assert "Depends(get_system_admin_device_auth)" in source
    assert 'APIRouter(prefix="/api/metronome"' in source
    assert "owner_id" not in source and "ownerId" not in source  # never chosen by the client
    assert '"Cache-Control"] = "no-store"' in source
    registry = (ROOT / "src/backend/core/router_registry.py").read_text(encoding="utf-8")
    assert '_import_router("..routers.metronome", "routers.metronome")' in registry


def test_metronome_tables_are_not_synchronised_from_production_to_test():
    from scripts.sync_prod_to_test_preflight import TARGET_DB_TABLES

    assert not [t for t in TARGET_DB_TABLES if t.startswith("metronome_")]
    assert "tuner_owners" not in TARGET_DB_TABLES


def test_identity_without_member_or_database_reports_device_only(monkeypatch):
    monkeypatch.setattr(metronome_service, "db_data_enabled", lambda: True)
    assert metronome_service.identity({"member_id": None, "hidden_user": True})["accountStorageAvailable"] is False
    monkeypatch.setattr(metronome_service, "db_data_enabled", lambda: False)
    with pytest.raises(HTTPException) as exc:
        metronome_service.identity({"member_id": 1})
    assert exc.value.status_code == 503
    assert exc.value.detail["code"] == "DATABASE_UNAVAILABLE"


def _code(fn, *args):
    with pytest.raises(HTTPException) as exc:
        fn(*args)
    return exc.value.status_code, exc.value.detail["code"]


def _session_body(**over):
    body = {
        "schemaVersion": 1, "historyEpoch": 1, "consentRevision": 1,
        "sessionId": "11111111-1111-4111-8111-111111111111", "attemptId": "22222222-2222-4222-8222-222222222222",
        "startedAt": "2026-10-18T00:00:00Z", "durationMs": 1000, "versions": {"statsVersion": "v1"},
        "scoreSummary": {"kind": "practice"}, "conditionKey": "practice:v1", "contentHash": "abc",
        "counts": {"target": 0, "valid": 0, "localDetail": 0, "extraDetail": 0, "extraTotal": 0, "groups": 0},
    }
    body.update(over)
    return body


def test_payloads_with_observations_calibration_or_unknown_fields_are_refused_before_the_db(monkeypatch):
    def no_db(*_a, **_k):
        raise AssertionError("validation must fail before the DB is touched")

    monkeypatch.setattr(metronome_service, "resolve_owner", no_db)
    device = {"member_id": 1}
    assert _code(metronome_service.create_session, device, _session_body(rawOnsets=[1, 2])) == (422, "INVALID_SCHEMA")
    assert _code(metronome_service.create_session, device, _session_body(scoreSummary={"calibration": {"offsetMs": 80}})) == (422, "INVALID_SCHEMA")
    assert _code(metronome_service.create_session, device, _session_body(durationMs=1_800_001)) == (422, "INVALID_SCHEMA")
    assert _code(metronome_service.create_session, device, _session_body(schemaVersion=2)) == (422, "UNSUPPORTED_VERSION")
    too_many = _session_body(counts={"target": 10, "valid": 0, "localDetail": 11, "extraDetail": 0, "extraTotal": 0, "groups": 0})
    assert _code(metronome_service.create_session, device, too_many) == (422, "INVALID_SCHEMA")
    part = {"schemaVersion": 1, "historyEpoch": 1, "consentRevision": 1, "payloadHash": "h", "groups": []}
    assert _code(metronome_service.put_part, device, "11111111-1111-4111-8111-111111111111", 1, part) == (422, "INVALID_SCHEMA")
    groups = [{"ordinal": i, "conditionKey": "c", "layerKey": "meter", "beatPositionKey": f"b{i}", "targetCount": 1, "validCount": 1, "extraTotal": 0, "stats": {}, "quality": {}} for i in range(257)]
    assert _code(metronome_service.put_part, device, "11111111-1111-4111-8111-111111111111", 0, dict(part, groups=groups)) == (422, "INVALID_SCHEMA")
    with_e = dict(part, groups=[{"ordinal": 0, "conditionKey": "c", "layerKey": "meter", "beatPositionKey": "b0", "targetCount": 1, "validCount": 1, "extraTotal": 0, "stats": {"medianMs": 1, "e": [1]}, "quality": {}}])
    assert _code(metronome_service.put_part, device, "11111111-1111-4111-8111-111111111111", 0, with_e) == (422, "INVALID_SCHEMA")
    fin = {"schemaVersion": 1, "historyEpoch": 1, "consentRevision": 1, "partHashes": ["h"], "eventCount": 5, "groupCount": 0, "summary": {}, "status": "complete"}
    assert _code(metronome_service.finalize_session, device, "11111111-1111-4111-8111-111111111111", fin) == (422, "INVALID_SCHEMA")


def test_preset_tempos_are_integer_tenths_and_durations_are_refused(monkeypatch):
    monkeypatch.setattr(metronome_service, "resolve_owner", lambda *_a: (_ for _ in ()).throw(AssertionError("no db")))
    base = {"schemaVersion": 1, "id": "33333333-3333-4333-8333-333333333333", "revision": 1, "kind": "basic", "title": "x", "payload": {"tempo": {"bpmTenths": 1200.5, "reference": {"n": 1, "d": 4}}}}
    body = {"schemaVersion": 1, "historyEpoch": 1, "consentRevision": 1, "preset": base}
    assert _code(metronome_service.create_preset, {"member_id": 1}, body)[0] == 422
    curve = {"startBpmTenths": 600, "endBpmTenths": 800, "durationSeconds": 3.7}
    score = dict(base, kind="score", payload={"tempoMap": [curve]})
    assert _code(metronome_service.create_preset, {"member_id": 1}, dict(body, preset=score)) == (422, "INVALID_TEMPO_MAP")
