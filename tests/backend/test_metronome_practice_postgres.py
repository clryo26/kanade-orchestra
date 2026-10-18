"""Metronome practice history against a disposable PostgreSQL database (MT-14).

Runs only when METRONOME_TEST_DSN points to a throw-away database that has
the portal base tables and every migration up to 019 applied. It never uses
the application's configured DSN.
"""
from __future__ import annotations

import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

DSN = os.getenv("METRONOME_TEST_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Disposable PostgreSQL DSN (METRONOME_TEST_DSN) not supplied")

TABLES = [
    "metronome_operations", "metronome_tombstones", "metronome_presets", "metronome_upload_parts", "metronome_summary_groups",
    "metronome_sessions", "metronome_preferences", "tuner_note_events", "tuner_upload_parts", "tuner_sessions", "tuner_tombstones",
    "tuner_presets", "tuner_instruments", "tuner_preferences", "tuner_owners",
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture()
def db(monkeypatch):
    from src.backend.core.auth_dependencies import get_system_admin_device_auth
    from src.backend.core.middleware import configure_middlewares
    from src.backend.repositories.metronome_repository import MetronomeRepository
    from src.backend.repositories.tuner_repository import TunerRepository
    from src.backend.routers import metronome as metronome_router
    from src.backend.routers import tuner as tuner_router
    from src.backend.services import metronome_service, tuner_service

    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("TRUNCATE " + ", ".join(TABLES) + " CASCADE")
        conn.execute("DELETE FROM members WHERE organization_id IN ('default', 'org-b')")
    monkeypatch.setattr(metronome_service, "_repository", lambda: MetronomeRepository(DSN))
    monkeypatch.setattr(metronome_service, "db_data_enabled", lambda: True)
    monkeypatch.setattr(tuner_service, "_repository", lambda: TunerRepository(DSN))
    monkeypatch.setattr(tuner_service, "db_data_enabled", lambda: True)
    state: dict[str, Any] = {"device": None}
    app = FastAPI()
    configure_middlewares(app, environ={})
    app.include_router(metronome_router.router)
    app.include_router(tuner_router.router)
    app.dependency_overrides[get_system_admin_device_auth] = lambda: state["device"]
    with TestClient(app) as client:
        yield {"client": client, "state": state}


def add_member(member_id: int, *, org: str = "default", created_at: datetime | None = None) -> datetime:
    created = created_at or _now()
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO members (id, organization_id, name, permission, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s)",
            (member_id, org, f"member-{member_id}", "システム管理者", created, created),
        )
    return created


def delete_member(member_id: int, org: str = "default") -> None:
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("DELETE FROM members WHERE organization_id = %s AND id = %s", (org, member_id))


def device(member_id: int | None, authenticated_at: datetime | None = None, hidden: bool = False) -> dict[str, Any]:
    return {
        "device_id": f"dev-{member_id}",
        "member_id": member_id,
        "permission": "システム管理者",
        "hidden_user": hidden,
        "authenticated_at": (authenticated_at or (_now() + timedelta(seconds=1))).isoformat(),
    }


def as_user(env, dev: dict[str, Any]) -> TestClient:
    env["state"]["device"] = dev
    return env["client"]


def identity(client: TestClient) -> dict[str, Any]:
    r = client.get("/api/metronome/identity")
    assert r.status_code == 200, r.text
    return r.json()


def consent(client: TestClient, on: bool = True) -> dict[str, Any]:
    prefs = client.get("/api/metronome/preferences").json()
    r = client.put("/api/metronome/preferences", json={"schemaVersion": 1, "expectedRevision": prefs["revision"], "accountConsent": on, "consentVersion": "metronome-history-v1"})
    assert r.status_code == 200, r.text
    return identity(client)


def groups(n: int, target: int = 10, valid: int = 8) -> list[dict[str, Any]]:
    return [
        {"ordinal": i, "conditionKey": "bpm1200|4-4", "layerKey": "meter", "beatPositionKey": f"b{i}", "targetCount": target, "validCount": valid, "missingCount": 1, "extraTotal": 0, "excludedByReason": {"missing": 1}, "stats": {"medianMs": 12.5, "madMs": 4.0, "sdMs": 6.1, "ioiRatioStats": None, "verdict": "reference"}, "quality": {"calibrated": True, "confidenceClass": "reference", "extraDetailsTruncated": False}}
        for i in range(n)
    ]


def session_body(ident: dict[str, Any], n_groups: int = 2, session_id: str | None = None, **over) -> dict[str, Any]:
    body = {
        "schemaVersion": 1, "historyEpoch": ident["historyEpoch"], "consentRevision": ident["consentRevision"],
        "sessionId": session_id or str(uuid.uuid4()), "attemptId": str(uuid.uuid4()), "startedAt": _now().isoformat(),
        "durationMs": 60000, "versions": {"statsVersion": "timing-stats-v1"}, "scoreSummary": {"kind": "analysis", "layers": ["meter"]},
        "conditionKey": "bpm1200|4-4", "contentHash": "hash-1",
        "counts": {"target": 10 * n_groups, "valid": 8 * n_groups, "localDetail": 10 * n_groups + 3, "extraDetail": 3, "extraTotal": 5, "groups": n_groups},
    }
    body.update(over)
    return body


def upload(client: TestClient, ident: dict[str, Any], n_groups: int = 2) -> str:
    body = session_body(ident, n_groups)
    sid = body["sessionId"]
    assert client.post("/api/metronome/sessions", json=body).status_code == 201
    epoch = {"schemaVersion": 1, "historyEpoch": ident["historyEpoch"], "consentRevision": ident["consentRevision"]}
    r = client.put(f"/api/metronome/sessions/{sid}/parts/0", json={**epoch, "payloadHash": "p0", "groups": groups(n_groups)})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/metronome/sessions/{sid}/finalize", json={**epoch, "partHashes": ["p0"], "eventCount": 0, "groupCount": n_groups, "summary": {"medianMs": 12.5}, "status": "complete"})
    assert r.status_code == 200, r.text
    return sid


def test_first_use_creates_the_shared_owner_and_requires_consent_before_upload(db):
    add_member(101)
    client = as_user(db, device(101))
    first = identity(client)
    assert first["accountStorageAvailable"] is True and first["accountConsent"] is False
    # The tuner sees the same personal owner (shared identity, not a copy).
    assert client.get("/api/tuner/identity").json()["ownerId"] == first["ownerId"]
    r = client.post("/api/metronome/sessions", json=session_body(first))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "CONSENT_REQUIRED"
    granted = consent(client)
    assert granted["consentRevision"] == first["consentRevision"] + 1
    # A request prepared under the old consent revision is refused.
    r = client.post("/api/metronome/sessions", json=session_body(first))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "CONSENT_REVISION"
    assert r.headers["Cache-Control"] == "no-store"


def test_upload_is_three_idempotent_writes_and_keeps_only_summaries(db):
    add_member(102)
    client = as_user(db, device(102))
    ident = consent(client)
    body = session_body(ident, 2)
    sid = body["sessionId"]
    assert client.post("/api/metronome/sessions", json=body).status_code == 201
    assert client.post("/api/metronome/sessions", json=body).status_code == 200  # same hash: same result
    r = client.post("/api/metronome/sessions", json=dict(body, contentHash="other"))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "SESSION_CONFLICT"
    epoch = {"schemaVersion": 1, "historyEpoch": ident["historyEpoch"], "consentRevision": ident["consentRevision"]}
    part = {**epoch, "payloadHash": "p0", "groups": groups(2)}
    assert client.put(f"/api/metronome/sessions/{sid}/parts/0", json=part).status_code == 200
    assert client.put(f"/api/metronome/sessions/{sid}/parts/0", json=part).status_code == 200
    r = client.put(f"/api/metronome/sessions/{sid}/parts/0", json=dict(part, payloadHash="p1"))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "PART_CONFLICT"
    assert client.get("/api/metronome/sessions").json()["items"] == []  # uploading is not listed
    fin = {**epoch, "partHashes": ["p0"], "eventCount": 0, "groupCount": 3, "summary": {"medianMs": 12.5}, "status": "complete"}
    assert client.post(f"/api/metronome/sessions/{sid}/finalize", json=fin).status_code == 409  # wrong group count
    assert client.post(f"/api/metronome/sessions/{sid}/finalize", json=dict(fin, groupCount=2)).status_code == 200
    assert client.post(f"/api/metronome/sessions/{sid}/finalize", json=dict(fin, groupCount=2)).json()["status"] == "complete"
    detail = client.get(f"/api/metronome/sessions/{sid}").json()
    assert len(detail["groups"]) == 2 and detail["details"] == "local-only"
    assert [s["sessionId"] for s in client.get("/api/metronome/sessions").json()["items"]] == [sid]
    with psycopg.connect(DSN, autocommit=True) as conn:
        assert conn.execute("SELECT event_count FROM metronome_sessions").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM metronome_upload_parts").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM metronome_summary_groups").fetchone()[0] == 2


def test_group_counts_must_partition_the_session_counts(db):
    add_member(103)
    client = as_user(db, device(103))
    ident = consent(client)
    body = session_body(ident, 2, counts={"target": 99, "valid": 16, "localDetail": 50, "extraDetail": 3, "extraTotal": 5, "groups": 2})
    sid = body["sessionId"]
    assert client.post("/api/metronome/sessions", json=body).status_code == 201
    epoch = {"schemaVersion": 1, "historyEpoch": ident["historyEpoch"], "consentRevision": ident["consentRevision"]}
    client.put(f"/api/metronome/sessions/{sid}/parts/0", json={**epoch, "payloadHash": "p0", "groups": groups(2)})
    r = client.post(f"/api/metronome/sessions/{sid}/finalize", json={**epoch, "partHashes": ["p0"], "eventCount": 0, "groupCount": 2, "summary": {}, "status": "complete"})
    assert r.status_code == 409


def test_full_deletion_moves_only_the_metronome_epoch_and_refuses_late_uploads(db):
    add_member(104)
    client = as_user(db, device(104))
    ident = consent(client)
    upload(client, ident)
    # A tuner session of the same person must survive the metronome deletion.
    tuner_epoch = client.get("/api/tuner/identity").json()["historyEpoch"]
    tuner_body = {"schemaVersion": 1, "historyEpoch": tuner_epoch, "clientOperationId": str(uuid.uuid4()), "session": {"sessionId": str(uuid.uuid4()), "startedAt": _now().isoformat(), "durationMs": 1000, "kind": "longtone", "conditionKey": "c", "eventCount": 0, "versions": {}, "summary": {}}}
    assert client.post("/api/tuner/sessions", json=tuner_body).status_code == 200
    op = str(uuid.uuid4())
    r = client.request("DELETE", "/api/metronome/history", json={"schemaVersion": 1, "operationId": op, "historyEpoch": ident["historyEpoch"]})
    assert r.status_code == 200, r.text
    assert r.json()["historyEpoch"] == ident["historyEpoch"] + 1 and r.json()["deletedCount"] == 1
    # Same operation again (lost response): same result, nothing deleted twice.
    again = client.request("DELETE", "/api/metronome/history", json={"schemaVersion": 1, "operationId": op, "historyEpoch": ident["historyEpoch"]})
    assert again.json()["historyEpoch"] == ident["historyEpoch"] + 1
    late = client.post("/api/metronome/sessions", json=session_body(ident))
    assert late.status_code == 409 and late.json()["detail"]["code"] == "HISTORY_EPOCH"
    with psycopg.connect(DSN, autocommit=True) as conn:
        assert conn.execute("SELECT COUNT(*) FROM tuner_sessions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM metronome_sessions").fetchone()[0] == 0
    assert identity(client)["accountConsent"] is True  # consent is not deleted with history


def test_single_deletion_leaves_a_tombstone_and_other_people_see_nothing(db):
    add_member(105)
    add_member(106)
    a = as_user(db, device(105))
    ident = consent(a)
    sid = upload(a, ident)
    b = as_user(db, device(106))
    consent(b)
    assert b.get(f"/api/metronome/sessions/{sid}").status_code == 404
    assert b.get("/api/metronome/sessions").json()["items"] == []
    r = b.request("DELETE", f"/api/metronome/sessions/{sid}", json={"schemaVersion": 1, "operationId": str(uuid.uuid4()), "historyEpoch": identity(b)["historyEpoch"]})
    assert r.status_code == 404
    a = as_user(db, device(105))
    r = a.request("DELETE", f"/api/metronome/sessions/{sid}", json={"schemaVersion": 1, "operationId": str(uuid.uuid4()), "historyEpoch": ident["historyEpoch"]})
    assert r.status_code == 200 and r.json()["tombstone"] is True
    again = a.post("/api/metronome/sessions", json=session_body(ident, session_id=sid))
    assert again.status_code == 409


def test_member_deletion_and_id_reuse_remove_metronome_data_and_never_hand_it_over(db):
    born = add_member(107, created_at=_now() - timedelta(days=10))
    old = as_user(db, device(107))
    old_owner = consent(old)["ownerId"]
    upload(old, identity(old))
    delete_member(107)  # 017 trigger revokes the owner -> 019 trigger removes metronome rows
    with psycopg.connect(DSN, autocommit=True) as conn:
        for table in ("metronome_sessions", "metronome_summary_groups", "metronome_preferences"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0, table
    add_member(107)
    stale = as_user(db, device(107, authenticated_at=born + timedelta(days=1)))
    r = stale.get("/api/metronome/identity")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "MEMBER_RECREATED"
    fresh = as_user(db, device(107))
    new = identity(fresh)
    assert new["ownerId"] != old_owner
    assert new["accountConsent"] is False
    assert fresh.get("/api/metronome/sessions").json()["items"] == []


def test_concurrent_first_use_by_tuner_and_metronome_creates_one_owner(db):
    add_member(108)
    from src.backend.repositories.metronome_repository import MetronomeRepository
    from src.backend.repositories.tuner_repository import TunerRepository

    with psycopg.connect(DSN, autocommit=True) as conn:
        birth = conn.execute("SELECT created_at FROM members WHERE id = 108").fetchone()[0]
    results: list[Any] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(6)

    def metronome() -> None:
        barrier.wait()
        try:
            results.append(MetronomeRepository(DSN).resolve_owner("default", 108, birth)["ownerId"])
        except BaseException as exc:  # recorded for the assertion
            errors.append(exc)

    def tuner() -> None:
        barrier.wait()
        try:
            results.append(TunerRepository(DSN).resolve_owner("default", 108, birth, create=True)["id"])
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=metronome) for _ in range(4)] + [threading.Thread(target=tuner) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    with psycopg.connect(DSN, autocommit=True) as conn:
        active = conn.execute("SELECT COUNT(*) FROM tuner_owners WHERE member_id = 108 AND revoked_at IS NULL").fetchone()[0]
    assert active == 1
    # Every successful caller got that one owner; a lost race may only be the
    # retryable initialisation conflict or the tuner's unique violation.
    assert len(set(results)) == 1
    for exc in errors:
        assert type(exc).__name__ in ("OwnerInitRetry", "UniqueViolation"), repr(exc)


def test_hidden_administrator_has_device_only_history(db):
    client = as_user(db, device(None, hidden=True))
    assert identity(client)["accountStorageAvailable"] is False
    r = client.get("/api/metronome/sessions")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "ACCOUNT_STORAGE_UNAVAILABLE"


def test_account_presets_are_explicit_and_referenced_presets_cannot_be_deleted(db):
    add_member(109)
    client = as_user(db, device(109))
    ident = consent(client)
    base_id = str(uuid.uuid4())
    base = {"schemaVersion": 1, "id": base_id, "revision": 1, "kind": "basic", "title": "基本", "payload": {"tempo": {"bpmTenths": 1200, "reference": {"n": 1, "d": 4}}}}
    epoch = {"schemaVersion": 1, "historyEpoch": ident["historyEpoch"], "consentRevision": ident["consentRevision"]}
    assert client.post("/api/metronome/presets", json={**epoch, "preset": base}).status_code == 201
    child = {"schemaVersion": 1, "id": str(uuid.uuid4()), "revision": 1, "kind": "advanced", "title": "層", "payload": {"basePresetId": base_id, "baseRevision": 1}}
    assert client.post("/api/metronome/presets", json={**epoch, "preset": child}).status_code == 201
    assert len(client.get("/api/metronome/presets").json()["items"]) == 2
    r = client.request("DELETE", f"/api/metronome/presets/{base_id}", json={"schemaVersion": 1, "operationId": str(uuid.uuid4()), "historyEpoch": ident["historyEpoch"]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "PRESET_IN_USE"
