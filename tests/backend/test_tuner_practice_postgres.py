"""Tuner practice history against a disposable PostgreSQL database.

Runs only when TUNER_TEST_DSN points to a throw-away database that already
has the portal base tables and every migration up to 017 applied (see
docs/TUNER_ADVANCED_IMPLEMENTATION_STATUS.md). It never uses the
application's configured DSN.
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

DSN = os.getenv("TUNER_TEST_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Disposable PostgreSQL DSN (TUNER_TEST_DSN) not supplied")

TUNER_TABLES = ["tuner_note_events", "tuner_upload_parts", "tuner_sessions", "tuner_tombstones", "tuner_presets", "tuner_instruments", "tuner_preferences", "tuner_owners"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture()
def db(monkeypatch):
    from src.backend.core.auth_dependencies import get_system_admin_device_auth
    from src.backend.core.middleware import configure_middlewares
    from src.backend.repositories.tuner_repository import TunerRepository
    from src.backend.routers import tuner as tuner_router
    from src.backend.services import tuner_service

    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("TRUNCATE " + ", ".join(TUNER_TABLES) + " CASCADE")
        conn.execute("DELETE FROM members WHERE organization_id IN ('default', 'org-b')")
    monkeypatch.setattr(tuner_service, "_repository", lambda: TunerRepository(DSN))
    monkeypatch.setattr(tuner_service, "db_data_enabled", lambda: True)
    state: dict[str, Any] = {"device": None}
    app = FastAPI()
    configure_middlewares(app, environ={})
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


def session_body(epoch: int, session_id: str | None = None, *, event_count: int = 2, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    session = {
        "sessionId": session_id or str(uuid.uuid4()),
        "startedAt": _now().isoformat(),
        "durationMs": 4000,
        "kind": "longtone",
        "conditionKey": "cond-1",
        "eventCount": event_count,
        "conditions": {"a4Tenths": 4420, "temperament": "equal"},
        "versions": {"engineVersion": "yin-2", "statsVersion": 1},
        "summary": {"medianCents": 1.5},
    }
    session.update(extra or {})
    return {"schemaVersion": 1, "historyEpoch": epoch, "clientOperationId": str(uuid.uuid4()), "session": session}


def events(n: int, midi: int = 69, median: float = 4.0) -> list[dict[str, Any]]:
    return [
        {
            "eventId": str(uuid.uuid4()),
            "ordinal": i,
            "startMs": i * 1000,
            "endMs": i * 1000 + 800,
            "target": {"midi": midi, "targetHz": 442.0},
            "stats": {"meanCents": median, "medianCents": median, "sdCents": 1.0, "durationSeconds": 0.8, "observationCount": 20, "coverage": 0.95, "validSeconds": 0.76},
            "quality": {},
        }
        for i in range(n)
    ]


def upload(client: TestClient, epoch: int, evs: list[dict[str, Any]], session_id: str | None = None) -> str:
    body = session_body(epoch, session_id, event_count=len(evs))
    sid = body["session"]["sessionId"]
    assert client.post("/api/tuner/sessions", json=body).status_code == 200
    r = client.put(f"/api/tuner/sessions/{sid}/parts/0", json={"schemaVersion": 1, "historyEpoch": epoch, "hash": "h0", "events": evs})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/tuner/sessions/{sid}/finalize", json={"schemaVersion": 1, "historyEpoch": epoch, "partCount": 1, "eventCount": len(evs), "partHashes": ["h0"]})
    assert r.status_code == 200, r.text
    return sid


def identity(client: TestClient) -> dict[str, Any]:
    r = client.get("/api/tuner/identity")
    assert r.status_code == 200, r.text
    return r.json()


def test_owner_is_stable_and_upload_flow_is_idempotent(db):
    add_member(101)
    client = as_user(db, device(101))
    first = identity(client)
    assert first["accountStorageAvailable"] is True
    assert identity(client)["ownerId"] == first["ownerId"]
    epoch = first["historyEpoch"]
    body = session_body(epoch)
    sid = body["session"]["sessionId"]
    assert client.post("/api/tuner/sessions", json=body).json()["data"]["created"] is True
    # Same body again: accepted, nothing duplicated. A different body: conflict.
    assert client.post("/api/tuner/sessions", json=body).json()["data"]["created"] is False
    changed = dict(body, session=dict(body["session"], durationMs=5000))
    assert client.post("/api/tuner/sessions", json=changed).status_code == 409
    evs = events(2)
    part = {"schemaVersion": 1, "historyEpoch": epoch, "hash": "h0", "events": evs}
    assert client.put(f"/api/tuner/sessions/{sid}/parts/0", json=part).json()["data"]["stored"] is True
    assert client.put(f"/api/tuner/sessions/{sid}/parts/0", json=part).json()["data"]["stored"] is False
    assert client.put(f"/api/tuner/sessions/{sid}/parts/0", json=dict(part, events=events(2))).status_code == 409
    # Not listed before finalize.
    assert client.get("/api/tuner/sessions").json()["data"]["sessions"] == []
    bad = {"schemaVersion": 1, "historyEpoch": epoch, "partCount": 1, "eventCount": 3, "partHashes": ["h0"]}
    assert client.post(f"/api/tuner/sessions/{sid}/finalize", json=bad).status_code == 409
    ok = dict(bad, eventCount=2)
    assert client.post(f"/api/tuner/sessions/{sid}/finalize", json=ok).json()["data"]["finalized"] is True
    assert client.post(f"/api/tuner/sessions/{sid}/finalize", json=ok).json()["data"]["finalized"] is False
    listed = client.get("/api/tuner/sessions").json()["data"]["sessions"]
    assert [s["sessionId"] for s in listed] == [sid]
    detail = client.get(f"/api/tuner/sessions/{sid}").json()["data"]
    assert len(detail["events"]) == 2
    assert detail["events"][0]["stats"]["medianCents"] == 4.0


def test_another_member_cannot_read_or_delete_and_admins_get_no_bypass(db):
    add_member(201)
    add_member(202)
    a = as_user(db, device(201))
    sid = upload(a, identity(a)["historyEpoch"], events(1))
    b = as_user(db, device(202))
    identity(b)
    # Another owner's id looks like a missing id.
    assert b.get(f"/api/tuner/sessions/{sid}").status_code == 404
    assert b.get("/api/tuner/sessions").json()["data"]["sessions"] == []
    assert b.delete(f"/api/tuner/sessions/{sid}").json()["data"]["deleted"] is False
    a = as_user(db, device(201))
    assert a.get(f"/api/tuner/sessions/{sid}").status_code == 200


def test_member_deletion_and_id_reuse_never_hand_over_history(db):
    born = add_member(301, created_at=_now() - timedelta(days=10))
    old = as_user(db, device(301))
    old_owner = identity(old)["ownerId"]
    upload(old, identity(old)["historyEpoch"], events(2))
    delete_member(301)  # trigger revokes the owner and deletes its data
    with psycopg.connect(DSN, autocommit=True) as conn:
        assert conn.execute("SELECT COUNT(*) FROM tuner_sessions").fetchone()[0] == 0
        assert conn.execute("SELECT revoked_reason FROM tuner_owners WHERE id = %s", (old_owner,)).fetchone()[0] == "member-deleted"
    # A new member with the same numeric id.
    add_member(301)
    stale = as_user(db, device(301, authenticated_at=born + timedelta(days=1)))
    # A device that signed in for the previous member is refused.
    r = stale.get("/api/tuner/identity")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "REAUTH_REQUIRED"
    fresh = as_user(db, device(301))
    new = identity(fresh)
    assert new["ownerId"] != old_owner
    assert fresh.get("/api/tuner/sessions").json()["data"]["sessions"] == []


def test_insert_with_a_reused_id_revokes_even_with_the_same_birth_time(db):
    born = add_member(401, created_at=_now() - timedelta(days=3))
    client = as_user(db, device(401))
    owner = identity(client)["ownerId"]
    upload(client, identity(client)["historyEpoch"], events(1))
    # Simulates a delete + re-insert that copied created_at (e.g. a bulk
    # rewrite): the INSERT trigger still revokes the old owner.
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("ALTER TABLE members DISABLE TRIGGER trg_tuner_members_owner_guard_delete")
        try:
            conn.execute("DELETE FROM members WHERE id = 401")
        finally:
            conn.execute("ALTER TABLE members ENABLE TRIGGER trg_tuner_members_owner_guard_delete")
    add_member(401, created_at=born)
    with psycopg.connect(DSN, autocommit=True) as conn:
        assert conn.execute("SELECT revoked_reason FROM tuner_owners WHERE id = %s", (owner,)).fetchone()[0] == "member-id-reused"
    assert identity(as_user(db, device(401)))["ownerId"] != owner


def test_birth_mismatch_after_a_restore_or_sync_revokes_the_old_owner(db):
    add_member(501, created_at=_now() - timedelta(days=5))
    client = as_user(db, device(501))
    owner = identity(client)["ownerId"]
    upload(client, identity(client)["historyEpoch"], events(1))
    # A restore/sync replaced the member row without firing the triggers.
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("ALTER TABLE members DISABLE TRIGGER USER")
        try:
            conn.execute("UPDATE members SET created_at = %s WHERE id = 501", (_now() - timedelta(hours=1),))
        finally:
            conn.execute("ALTER TABLE members ENABLE TRIGGER USER")
    new = identity(as_user(db, device(501)))
    assert new["ownerId"] != owner
    with psycopg.connect(DSN, autocommit=True) as conn:
        assert conn.execute("SELECT revoked_reason FROM tuner_owners WHERE id = %s", (owner,)).fetchone()[0] == "member-birth-mismatch"
        assert conn.execute("SELECT COUNT(*) FROM tuner_sessions").fetchone()[0] == 0


def test_hidden_administrator_has_no_account_storage(db):
    client = as_user(db, device(None, hidden=True))
    data = identity(client)
    assert data["accountStorageAvailable"] is False and data["ownerId"] is None
    r = client.get("/api/tuner/sessions")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "ACCOUNT_STORAGE_UNAVAILABLE"


def test_other_organization_cannot_resolve_the_same_member_id(db):
    add_member(601)
    a = as_user(db, device(601))
    upload(a, identity(a)["historyEpoch"], events(1))
    # Under another organisation the member is looked up there: no member,
    # no owner, nothing of organisation "default" is reachable.
    r = db["client"].get("/api/tuner/identity", headers={"X-Organization-Id": "org-b"})
    assert r.status_code == 200 and r.json()["accountStorageAvailable"] is False
    r = db["client"].get("/api/tuner/sessions", headers={"X-Organization-Id": "org-b"})
    assert r.status_code == 403
    # A member of org-b gets its own owner and sees none of the default data.
    add_member(602, org="org-b")
    other = as_user(db, device(602))
    data = other.get("/api/tuner/identity", headers={"X-Organization-Id": "org-b"}).json()
    assert data["accountStorageAvailable"] is True
    assert other.get("/api/tuner/sessions", headers={"X-Organization-Id": "org-b"}).json()["data"]["sessions"] == []


def test_deleted_session_is_never_resurrected_by_late_parts_or_resends(db):
    add_member(701)
    client = as_user(db, device(701))
    epoch = identity(client)["historyEpoch"]
    body = session_body(epoch, event_count=1)
    sid = body["session"]["sessionId"]
    client.post("/api/tuner/sessions", json=body)
    assert client.delete(f"/api/tuner/sessions/{sid}").status_code == 200
    late_part = {"schemaVersion": 1, "historyEpoch": epoch, "hash": "h0", "events": events(1)}
    assert client.put(f"/api/tuner/sessions/{sid}/parts/0", json=late_part).status_code == 410
    assert client.post(f"/api/tuner/sessions/{sid}/finalize", json={"schemaVersion": 1, "historyEpoch": epoch, "partCount": 0, "eventCount": 0, "partHashes": []}).status_code == 410
    assert client.post("/api/tuner/sessions", json=body).status_code == 410


def test_full_deletion_increments_the_epoch_and_refuses_old_outbox(db):
    add_member(801)
    client = as_user(db, device(801))
    epoch = identity(client)["historyEpoch"]
    upload(client, epoch, events(2))
    queued = session_body(epoch, event_count=1)  # queued before the deletion
    new_epoch = client.delete("/api/tuner/history").json()["data"]["historyEpoch"]
    assert new_epoch == epoch + 1
    assert client.get("/api/tuner/sessions").json()["data"]["sessions"] == []
    r = client.post("/api/tuner/sessions", json=queued)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "HISTORY_EPOCH"
    upload(client, new_epoch, events(1))
    assert len(client.get("/api/tuner/sessions").json()["data"]["sessions"]) == 1


def test_delete_and_finalize_racing_never_leave_a_resurrected_session(db):
    add_member(901)
    client = as_user(db, device(901))
    epoch = identity(client)["historyEpoch"]
    from src.backend.repositories.tuner_repository import TunerRepository

    repo = TunerRepository(DSN)
    owner = identity(client)["ownerId"]
    for _ in range(5):
        body = session_body(epoch, event_count=3)
        sid = body["session"]["sessionId"]
        client.post("/api/tuner/sessions", json=body)
        client.put(f"/api/tuner/sessions/{sid}/parts/0", json={"schemaVersion": 1, "historyEpoch": epoch, "hash": "h0", "events": events(3)})
        errors: list[str] = []

        def finalize() -> None:
            try:
                repo.finalize(owner, epoch, sid, ["h0"], 3)
            except Exception as exc:  # noqa: BLE001 - recorded for the assertion below
                errors.append(type(exc).__name__)

        def remove() -> None:
            repo.delete_session(owner, sid)

        threads = [threading.Thread(target=finalize), threading.Thread(target=remove)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        with psycopg.connect(DSN, autocommit=True) as conn:
            sessions = conn.execute("SELECT COUNT(*) FROM tuner_sessions WHERE session_uuid = %s", (sid,)).fetchone()[0]
            event_rows = conn.execute("SELECT COUNT(*) FROM tuner_note_events WHERE session_uuid = %s", (sid,)).fetchone()[0]
            tomb = conn.execute("SELECT COUNT(*) FROM tuner_tombstones WHERE entity_uuid = %s", (sid,)).fetchone()[0]
        assert tomb == 1 and sessions == 0 and event_rows == 0, errors
        assert set(errors) <= {"Tombstoned", "NotFound"}


def test_limits_and_value_validation(db):
    add_member(1001)
    client = as_user(db, device(1001))
    epoch = identity(client)["historyEpoch"]
    too_many = session_body(epoch, event_count=10_001)
    assert client.post("/api/tuner/sessions", json=too_many).status_code == 400
    sid = str(uuid.uuid4())
    client.post("/api/tuner/sessions", json=session_body(epoch, sid, event_count=501))
    r = client.put(f"/api/tuner/sessions/{sid}/parts/0", json={"schemaVersion": 1, "historyEpoch": epoch, "hash": "h", "events": events(501)})
    assert r.status_code == 413
    # Non-finite numbers are refused (JSON allows NaN only by extension).
    raw = '{"schemaVersion":1,"historyEpoch":%d,"hash":"h","events":[{"eventId":"%s","startMs":0,"endMs":1,"stats":{"meanCents":NaN}}]}' % (epoch, uuid.uuid4())
    r = client.put(f"/api/tuner/sessions/{sid}/parts/0", content=raw, headers={"Content-Type": "application/json"})
    assert r.status_code in (400, 422)
    assert client.post("/api/tuner/sessions", json=dict(session_body(epoch), schemaVersion=2)).status_code == 400
    bad_owner = session_body(epoch)
    bad_owner["ownerId"] = str(uuid.uuid4())  # the client cannot choose the owner
    assert client.post("/api/tuner/sessions", json=bad_owner).status_code == 200


def test_export_csv_neutralises_formulas_and_diagnosis_holds_without_enough_data(db):
    add_member(1101)
    client = as_user(db, device(1101))
    epoch = identity(client)["historyEpoch"]
    upload(client, epoch, events(2))
    body = session_body(epoch, event_count=1, extra={"conditionKey": "=HYPERLINK(1)"})
    sid = body["session"]["sessionId"]
    client.post("/api/tuner/sessions", json=body)
    client.put(f"/api/tuner/sessions/{sid}/parts/0", json={"schemaVersion": 1, "historyEpoch": epoch, "hash": "h0", "events": events(1)})
    client.post(f"/api/tuner/sessions/{sid}/finalize", json={"schemaVersion": 1, "historyEpoch": epoch, "partCount": 1, "eventCount": 1, "partHashes": ["h0"]})
    text = client.get("/api/tuner/export?format=csv").text
    assert "'=HYPERLINK(1)" in text
    assert ",=HYPERLINK" not in text
    diag = client.get("/api/tuner/diagnosis?condition=cond-1").json()["data"]
    assert diag["notes"]["69"]["status"] == "insufficient"
    assert diag["notes"]["69"]["nEvents"] == 2 and diag["notes"]["69"]["nSessions"] == 1
    # Enough events in enough sessions: a diagnosis with an interval.
    for _ in range(3):
        upload(client, epoch, events(3, median=6.0))
    note = client.get("/api/tuner/diagnosis?condition=cond-1").json()["data"]["notes"]["69"]
    assert note["nSessions"] == 4 and note["nEvents"] == 11
    assert note["status"] in ("ok", "reference")
    assert note["meanCents"] == pytest.approx((4.0 + 6.0 * 3) / 4)


def test_diagnosis_counts_an_event_under_its_own_condition_key(db):
    # A4 changed inside one session: the earlier events carry their own key
    # (target.conditionKey) and are never mixed into the session's condition.
    add_member(1201)
    client = as_user(db, device(1201))
    epoch = identity(client)["historyEpoch"]
    mixed = events(3, median=0.5)
    for ev in mixed[:2]:
        ev["target"] = dict(ev["target"], conditionKey="cond-440")
    upload(client, epoch, mixed)
    session_cond = client.get("/api/tuner/diagnosis?condition=cond-1").json()["data"]["notes"]["69"]
    assert session_cond["nEvents"] == 1
    own_cond = client.get("/api/tuner/diagnosis?condition=cond-440").json()["data"]["notes"]["69"]
    assert own_cond["nEvents"] == 2 and own_cond["nSessions"] == 1
