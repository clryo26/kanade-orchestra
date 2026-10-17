"""DB access for the tuner practice history (summaries only).

Every write locks the owner row first (``FOR UPDATE``) and re-checks that
the owner is still active and that the caller's history epoch is current,
so a deletion and a delayed upload can never interleave into resurrected
history. Callers pass an owner id that the service resolved from the
signed-in member; there is no owner-less lookup by session id.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from ..core.db_pool import pooled_psycopg as psycopg


class OwnerRevoked(Exception):
    """The owner was revoked (member deleted / id reused) during the request."""


class HistoryEpochMismatch(Exception):
    """The request belongs to an older history epoch (a full deletion happened)."""


class Tombstoned(Exception):
    """The entity id was deleted before; it cannot be written again."""


class Conflict(Exception):
    """Different content for an id/part that already exists."""


class NotFound(Exception):
    """No such entity for this owner."""


def _jsonb(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


class TunerRepository:
    def __init__(self, conn_str: str) -> None:
        self._conn_str = conn_str

    # ----- members / owners -------------------------------------------------

    def member_birth(self, organization_id: str, member_id: int) -> datetime | None:
        """Creation time of the member row (immutable: upserts keep created_at)."""
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT created_at FROM members WHERE organization_id = %s AND id = %s",
                    (organization_id, member_id),
                )
                row = cur.fetchone()
                return row[0] if row and row[0] is not None else None

    def resolve_owner(self, organization_id: str, member_id: int, member_birth: datetime, *, create: bool) -> dict[str, Any] | None:
        """Active owner of (organisation, member, birth); revokes a stale one."""
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, member_birth, history_epoch FROM tuner_owners
                    WHERE organization_id = %s AND member_id = %s AND revoked_at IS NULL
                    FOR UPDATE
                    """,
                    (organization_id, member_id),
                )
                row = cur.fetchone()
                if row and row[1] == member_birth:
                    conn.commit()
                    return {"id": str(row[0]), "history_epoch": int(row[2])}
                if row:
                    # Same numeric id, different member generation: the old
                    # history must never be handed to the new member.
                    cur.execute("SELECT tuner_revoke_member_owner(%s, %s, %s)", (organization_id, member_id, "member-birth-mismatch"))
                if not create:
                    conn.commit()
                    return None
                owner_id = uuid.uuid4()
                cur.execute(
                    """
                    INSERT INTO tuner_owners (id, organization_id, member_id, member_birth)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id, history_epoch
                    """,
                    (owner_id, organization_id, member_id, member_birth),
                )
                created = cur.fetchone()
                conn.commit()
                return {"id": str(created[0]), "history_epoch": int(created[1])}

    def revoke_member(self, organization_id: str, member_id: int, reason: str) -> None:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT tuner_revoke_member_owner(%s, %s, %s)", (organization_id, member_id, reason))
            conn.commit()

    @staticmethod
    def _lock_owner(cur: Any, owner_id: str, history_epoch: int | None) -> int:
        cur.execute("SELECT history_epoch, revoked_at FROM tuner_owners WHERE id = %s FOR UPDATE", (owner_id,))
        row = cur.fetchone()
        if not row or row[1] is not None:
            raise OwnerRevoked()
        if history_epoch is not None and int(history_epoch) != int(row[0]):
            raise HistoryEpochMismatch()
        return int(row[0])

    # ----- preferences ---------------------------------------------------------

    def get_preferences(self, owner_id: str) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT revision, preferences, consent_version, updated_at FROM tuner_preferences WHERE owner_id = %s", (owner_id,))
                row = cur.fetchone()
                if not row:
                    return {"revision": 0, "preferences": {}, "consentVersion": "", "updatedAt": None}
                return {"revision": int(row[0]), "preferences": row[1] or {}, "consentVersion": row[2] or "", "updatedAt": _iso(row[3])}

    def put_preferences(self, owner_id: str, revision: int, preferences: dict[str, Any], consent_version: str) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock_owner(cur, owner_id, None)
                cur.execute("SELECT revision FROM tuner_preferences WHERE owner_id = %s FOR UPDATE", (owner_id,))
                row = cur.fetchone()
                current = int(row[0]) if row else 0
                if revision != current:
                    raise Conflict()
                cur.execute(
                    """
                    INSERT INTO tuner_preferences (owner_id, revision, preferences, consent_version, updated_at)
                    VALUES (%s, %s, %s::jsonb, %s, NOW())
                    ON CONFLICT (owner_id) DO UPDATE SET revision = EXCLUDED.revision,
                        preferences = EXCLUDED.preferences, consent_version = EXCLUDED.consent_version, updated_at = NOW()
                    """,
                    (owner_id, current + 1, _jsonb(preferences), consent_version),
                )
            conn.commit()
        return self.get_preferences(owner_id)

    # ----- instruments / presets ---------------------------------------------

    def list_instruments(self, owner_id: str) -> list[dict[str, Any]]:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT instrument_uuid, revision, profile, created_at, updated_at FROM tuner_instruments
                    WHERE owner_id = %s AND deleted_at IS NULL ORDER BY created_at, instrument_uuid
                    """,
                    (owner_id,),
                )
                return [
                    {"instrumentId": str(r[0]), "revision": int(r[1]), "profile": r[2] or {}, "createdAt": _iso(r[3]), "updatedAt": _iso(r[4])}
                    for r in cur.fetchall()
                ]

    def create_instrument(self, owner_id: str, instrument_id: str, profile: dict[str, Any], limit: int) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock_owner(cur, owner_id, None)
                cur.execute("SELECT 1 FROM tuner_tombstones WHERE owner_id = %s AND entity_type = 'instrument' AND entity_uuid = %s", (owner_id, instrument_id))
                if cur.fetchone():
                    raise Tombstoned()
                cur.execute("SELECT profile FROM tuner_instruments WHERE owner_id = %s AND instrument_uuid = %s", (owner_id, instrument_id))
                existing = cur.fetchone()
                if existing:
                    if (existing[0] or {}) != profile:
                        raise Conflict()
                    conn.commit()
                    return {"instrumentId": instrument_id, "revision": 1, "profile": profile}
                cur.execute("SELECT COUNT(*) FROM tuner_instruments WHERE owner_id = %s AND deleted_at IS NULL", (owner_id,))
                if int(cur.fetchone()[0]) >= limit:
                    raise OverflowError("STORAGE_LIMIT")
                cur.execute(
                    "INSERT INTO tuner_instruments (owner_id, instrument_uuid, revision, profile) VALUES (%s, %s, 1, %s::jsonb)",
                    (owner_id, instrument_id, _jsonb(profile)),
                )
            conn.commit()
        return {"instrumentId": instrument_id, "revision": 1, "profile": profile}

    def update_instrument(self, owner_id: str, instrument_id: str, revision: int, profile: dict[str, Any]) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock_owner(cur, owner_id, None)
                cur.execute(
                    "SELECT revision FROM tuner_instruments WHERE owner_id = %s AND instrument_uuid = %s AND deleted_at IS NULL FOR UPDATE",
                    (owner_id, instrument_id),
                )
                row = cur.fetchone()
                if not row:
                    raise NotFound()
                if int(row[0]) != revision:
                    raise Conflict()
                cur.execute(
                    "UPDATE tuner_instruments SET revision = revision + 1, profile = %s::jsonb, updated_at = NOW() WHERE owner_id = %s AND instrument_uuid = %s",
                    (_jsonb(profile), owner_id, instrument_id),
                )
            conn.commit()
        return {"instrumentId": instrument_id, "revision": revision + 1, "profile": profile}

    def delete_instrument(self, owner_id: str, instrument_id: str) -> None:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                epoch = self._lock_owner(cur, owner_id, None)
                cur.execute(
                    "UPDATE tuner_instruments SET deleted_at = NOW() WHERE owner_id = %s AND instrument_uuid = %s AND deleted_at IS NULL",
                    (owner_id, instrument_id),
                )
                if cur.rowcount == 0:
                    raise NotFound()
                cur.execute(
                    """
                    INSERT INTO tuner_tombstones (owner_id, entity_type, entity_uuid, history_epoch)
                    VALUES (%s, 'instrument', %s, %s) ON CONFLICT DO NOTHING
                    """,
                    (owner_id, instrument_id, epoch),
                )
            conn.commit()

    def list_presets(self, owner_id: str) -> list[dict[str, Any]]:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT ON (preset_uuid) preset_uuid, revision, kind, payload, created_at, deleted_at
                    FROM tuner_presets WHERE owner_id = %s ORDER BY preset_uuid, revision DESC
                    """,
                    (owner_id,),
                )
                return [
                    {"presetId": str(r[0]), "revision": int(r[1]), "kind": r[2], "payload": r[3] or {}, "createdAt": _iso(r[4])}
                    for r in cur.fetchall()
                    if r[5] is None
                ]

    def create_preset(self, owner_id: str, preset_id: str, kind: str, payload: dict[str, Any], limit: int) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock_owner(cur, owner_id, None)
                cur.execute("SELECT 1 FROM tuner_tombstones WHERE owner_id = %s AND entity_type = 'preset' AND entity_uuid = %s", (owner_id, preset_id))
                if cur.fetchone():
                    raise Tombstoned()
                cur.execute("SELECT COUNT(DISTINCT preset_uuid) FROM tuner_presets WHERE owner_id = %s", (owner_id,))
                if int(cur.fetchone()[0]) >= limit:
                    raise OverflowError("STORAGE_LIMIT")
                cur.execute("SELECT COALESCE(MAX(revision), 0) FROM tuner_presets WHERE owner_id = %s AND preset_uuid = %s", (owner_id, preset_id))
                revision = int(cur.fetchone()[0]) + 1
                # Revisions are immutable: a new one is added, old ones stay as
                # the snapshot that past sessions may have used.
                cur.execute(
                    "INSERT INTO tuner_presets (owner_id, preset_uuid, revision, kind, payload) VALUES (%s, %s, %s, %s, %s::jsonb)",
                    (owner_id, preset_id, revision, kind, _jsonb(payload)),
                )
            conn.commit()
        return {"presetId": preset_id, "revision": revision, "kind": kind, "payload": payload}

    def delete_preset(self, owner_id: str, preset_id: str) -> None:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                epoch = self._lock_owner(cur, owner_id, None)
                cur.execute("UPDATE tuner_presets SET deleted_at = NOW() WHERE owner_id = %s AND preset_uuid = %s AND deleted_at IS NULL", (owner_id, preset_id))
                if cur.rowcount == 0:
                    raise NotFound()
                cur.execute(
                    "INSERT INTO tuner_tombstones (owner_id, entity_type, entity_uuid, history_epoch) VALUES (%s, 'preset', %s, %s) ON CONFLICT DO NOTHING",
                    (owner_id, preset_id, epoch),
                )
            conn.commit()

    # ----- sessions ---------------------------------------------------------------

    def usage(self, owner_id: str) -> dict[str, int]:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT COUNT(*), COALESCE(SUM(event_count), 0),
                           COALESCE(SUM(pg_column_size(summary) + pg_column_size(result) + pg_column_size(conditions)
                                        + pg_column_size(instrument_snapshot) + pg_column_size(target_snapshot)), 0)
                    FROM tuner_sessions WHERE owner_id = %s
                    """,
                    (owner_id,),
                )
                sessions, events, session_bytes = cur.fetchone()
                cur.execute(
                    "SELECT COALESCE(SUM(pg_column_size(target) + pg_column_size(stats) + pg_column_size(quality)), 0) FROM tuner_note_events WHERE owner_id = %s",
                    (owner_id,),
                )
                event_bytes = cur.fetchone()[0]
                return {"sessions": int(sessions), "events": int(events), "bytes": int(session_bytes) + int(event_bytes)}

    def create_session(
        self,
        owner_id: str,
        history_epoch: int,
        session: dict[str, Any],
        started_at: datetime,
        operation_id: str | None,
        limits: dict[str, int],
    ) -> dict[str, Any]:
        session_id = session["sessionId"]
        content = _canonical(session)
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock_owner(cur, owner_id, history_epoch)
                cur.execute("SELECT 1 FROM tuner_tombstones WHERE owner_id = %s AND entity_type = 'session' AND entity_uuid = %s", (owner_id, session_id))
                if cur.fetchone():
                    raise Tombstoned()
                cur.execute("SELECT status, content_hash FROM tuner_sessions WHERE owner_id = %s AND session_uuid = %s FOR UPDATE", (owner_id, session_id))
                existing = cur.fetchone()
                if existing:
                    # Idempotent re-send of the same body; a different body is a conflict.
                    if existing[1] != _content_hash(content):
                        raise Conflict()
                    conn.commit()
                    return {"sessionId": session_id, "status": existing[0], "created": False}
                cur.execute("SELECT COUNT(*), COALESCE(SUM(event_count), 0) FROM tuner_sessions WHERE owner_id = %s", (owner_id,))
                count, events = cur.fetchone()
                if int(count) >= limits["sessions"] or int(events) + int(session.get("eventCount") or 0) > limits["events"]:
                    raise OverflowError("STORAGE_LIMIT")
                cur.execute(
                    """
                    INSERT INTO tuner_sessions (owner_id, session_uuid, history_epoch, status, condition_key, kind, instrument_uuid,
                        started_at, duration_ms, versions, conditions, summary, result, instrument_snapshot, target_snapshot,
                        event_count, content_hash, client_operation_id)
                    VALUES (%s, %s, %s, 'uploading', %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, %s)
                    """,
                    (
                        owner_id, session_id, history_epoch, session.get("conditionKey") or "", session.get("kind") or "",
                        session.get("instrumentId"), started_at, int(session.get("durationMs") or 0),
                        _jsonb(session.get("versions") or {}), _jsonb(session.get("conditions") or {}), _jsonb(session.get("summary") or {}),
                        _jsonb(session.get("result") or {}), _jsonb(session.get("instrumentSnapshot") or {}), _jsonb(session.get("targetSnapshot") or {}),
                        int(session.get("eventCount") or 0), _content_hash(content), operation_id,
                    ),
                )
            conn.commit()
        return {"sessionId": session_id, "status": "uploading", "created": True}

    def put_part(self, owner_id: str, history_epoch: int, session_id: str, index: int, payload_hash: str, events: list[dict[str, Any]]) -> dict[str, Any]:
        content = _canonical(events)
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock_owner(cur, owner_id, history_epoch)
                cur.execute("SELECT 1 FROM tuner_tombstones WHERE owner_id = %s AND entity_type = 'session' AND entity_uuid = %s", (owner_id, session_id))
                if cur.fetchone():
                    raise Tombstoned()
                cur.execute("SELECT status FROM tuner_sessions WHERE owner_id = %s AND session_uuid = %s FOR UPDATE", (owner_id, session_id))
                row = cur.fetchone()
                if not row:
                    raise NotFound()
                if row[0] != "uploading":
                    raise Conflict()
                cur.execute(
                    "SELECT payload_hash, content_hash FROM tuner_upload_parts WHERE owner_id = %s AND session_uuid = %s AND part_index = %s",
                    (owner_id, session_id, index),
                )
                existing = cur.fetchone()
                if existing:
                    if existing[0] != payload_hash or existing[1] != _content_hash(content):
                        raise Conflict()
                    conn.commit()
                    return {"index": index, "stored": False}
                cur.execute(
                    """
                    INSERT INTO tuner_upload_parts (owner_id, session_uuid, part_index, payload_hash, content_hash, events, event_count, expires_at)
                    VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                    """,
                    (owner_id, session_id, index, payload_hash, _content_hash(content), _jsonb(events), len(events), datetime.now(timezone.utc) + timedelta(hours=24)),
                )
            conn.commit()
        return {"index": index, "stored": True}

    def finalize(self, owner_id: str, history_epoch: int, session_id: str, part_hashes: list[str], event_count: int) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock_owner(cur, owner_id, history_epoch)
                cur.execute("SELECT 1 FROM tuner_tombstones WHERE owner_id = %s AND entity_type = 'session' AND entity_uuid = %s", (owner_id, session_id))
                if cur.fetchone():
                    raise Tombstoned()
                cur.execute("SELECT status, event_count FROM tuner_sessions WHERE owner_id = %s AND session_uuid = %s FOR UPDATE", (owner_id, session_id))
                row = cur.fetchone()
                if not row:
                    raise NotFound()
                if row[0] == "complete":
                    conn.commit()
                    return {"sessionId": session_id, "status": "complete", "finalized": False}
                cur.execute(
                    "SELECT part_index, payload_hash, events FROM tuner_upload_parts WHERE owner_id = %s AND session_uuid = %s ORDER BY part_index",
                    (owner_id, session_id),
                )
                parts = cur.fetchall()
                if [p[1] for p in parts] != part_hashes or [p[0] for p in parts] != list(range(len(part_hashes))):
                    raise Conflict()
                events = [ev for p in parts for ev in (p[2] or [])]
                if len(events) != event_count or int(row[1]) != event_count:
                    raise Conflict()
                for ordinal, ev in enumerate(events):
                    cur.execute(
                        """
                        INSERT INTO tuner_note_events (owner_id, session_uuid, event_uuid, ordinal, start_ms, end_ms, target, stats, quality)
                        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb)
                        """,
                        (
                            owner_id, session_id, ev["eventId"], ordinal, int(ev.get("startMs") or 0), int(ev.get("endMs") or 0),
                            _jsonb(ev.get("target") or {}), _jsonb(ev.get("stats") or {}), _jsonb(ev.get("quality") or {}),
                        ),
                    )
                cur.execute("DELETE FROM tuner_upload_parts WHERE owner_id = %s AND session_uuid = %s", (owner_id, session_id))
                cur.execute(
                    "UPDATE tuner_sessions SET status = 'complete', finalized_at = NOW(), updated_at = NOW() WHERE owner_id = %s AND session_uuid = %s",
                    (owner_id, session_id),
                )
            conn.commit()
        return {"sessionId": session_id, "status": "complete", "finalized": True}

    def list_sessions(self, owner_id: str, filters: dict[str, Any], limit: int, cursor: tuple[datetime, str] | None) -> list[dict[str, Any]]:
        clauses = ["owner_id = %s", "status = 'complete'"]
        params: list[Any] = [owner_id]
        if filters.get("from"):
            clauses.append("started_at >= %s")
            params.append(filters["from"])
        if filters.get("to"):
            clauses.append("started_at <= %s")
            params.append(filters["to"])
        if filters.get("instrument"):
            clauses.append("instrument_uuid = %s")
            params.append(filters["instrument"])
        if filters.get("kind"):
            clauses.append("kind = %s")
            params.append(filters["kind"])
        if filters.get("condition"):
            clauses.append("condition_key = %s")
            params.append(filters["condition"])
        if cursor:
            clauses.append("(started_at, session_uuid) < (%s, %s)")
            params.extend([cursor[0], cursor[1]])
        params.append(limit + 1)
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT session_uuid, started_at, duration_ms, kind, condition_key, instrument_uuid, summary, versions, event_count "
                    "FROM tuner_sessions WHERE " + " AND ".join(clauses) + " ORDER BY started_at DESC, session_uuid DESC LIMIT %s",
                    tuple(params),
                )
                return [
                    {
                        "sessionId": str(r[0]), "startedAt": _iso(r[1]), "startedAtRaw": r[1], "durationMs": int(r[2]), "kind": r[3],
                        "conditionKey": r[4], "instrumentId": str(r[5]) if r[5] else None, "summary": r[6] or {}, "versions": r[7] or {}, "eventCount": int(r[8]),
                    }
                    for r in cur.fetchall()
                ]

    def get_session(self, owner_id: str, session_id: str, offset: int, limit: int) -> dict[str, Any] | None:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT session_uuid, started_at, duration_ms, kind, condition_key, instrument_uuid, versions, conditions, summary,
                           result, instrument_snapshot, target_snapshot, event_count
                    FROM tuner_sessions WHERE owner_id = %s AND session_uuid = %s AND status = 'complete'
                    """,
                    (owner_id, session_id),
                )
                r = cur.fetchone()
                if not r:
                    return None
                cur.execute(
                    "SELECT event_uuid, ordinal, start_ms, end_ms, target, stats, quality FROM tuner_note_events "
                    "WHERE owner_id = %s AND session_uuid = %s ORDER BY ordinal LIMIT %s OFFSET %s",
                    (owner_id, session_id, limit + 1, offset),
                )
                events = [
                    {"eventId": str(e[0]), "ordinal": int(e[1]), "startMs": int(e[2]), "endMs": int(e[3]), "target": e[4] or {}, "stats": e[5] or {}, "quality": e[6] or {}}
                    for e in cur.fetchall()
                ]
                return {
                    "sessionId": str(r[0]), "startedAt": _iso(r[1]), "durationMs": int(r[2]), "kind": r[3], "conditionKey": r[4],
                    "instrumentId": str(r[5]) if r[5] else None, "versions": r[6] or {}, "conditions": r[7] or {}, "summary": r[8] or {},
                    "result": r[9] or {}, "instrumentSnapshot": r[10] or {}, "targetSnapshot": r[11] or {}, "eventCount": int(r[12]),
                    "events": events,
                }

    def delete_session(self, owner_id: str, session_id: str) -> bool:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                epoch = self._lock_owner(cur, owner_id, None)
                # Tombstone first: a part/finalize arriving later is refused.
                cur.execute(
                    "INSERT INTO tuner_tombstones (owner_id, entity_type, entity_uuid, history_epoch) VALUES (%s, 'session', %s, %s) ON CONFLICT DO NOTHING",
                    (owner_id, session_id, epoch),
                )
                cur.execute("DELETE FROM tuner_sessions WHERE owner_id = %s AND session_uuid = %s", (owner_id, session_id))
                deleted = int(cur.rowcount) > 0
            conn.commit()
        return deleted

    def delete_history(self, owner_id: str, history_epoch: int | None) -> int:
        """Deletes every session of the owner and increments the history epoch."""
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock_owner(cur, owner_id, history_epoch)
                cur.execute("DELETE FROM tuner_sessions WHERE owner_id = %s", (owner_id,))
                cur.execute("UPDATE tuner_owners SET history_epoch = history_epoch + 1 WHERE id = %s RETURNING history_epoch", (owner_id,))
                new_epoch = int(cur.fetchone()[0])
            conn.commit()
        return new_epoch

    def diagnosis_events(self, owner_id: str, condition_key: str, limit: int) -> list[dict[str, Any]]:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT s.session_uuid, s.started_at, s.versions, e.event_uuid, e.target, e.stats, e.quality
                    FROM tuner_sessions s JOIN tuner_note_events e ON e.owner_id = s.owner_id AND e.session_uuid = s.session_uuid
                    WHERE s.owner_id = %s AND s.status = 'complete'
                      -- An event judged after a change of A4 / target inside the
                      -- session carries its own key (target.conditionKey) and is
                      -- counted only under that key.
                      AND COALESCE(NULLIF(e.target->>'conditionKey', ''), s.condition_key) = %s
                    ORDER BY s.started_at DESC, e.ordinal LIMIT %s
                    """,
                    (owner_id, condition_key, limit),
                )
                return [
                    {"sessionId": str(r[0]), "startedAt": r[1], "versions": r[2] or {}, "eventId": str(r[3]), "target": r[4] or {}, "stats": r[5] or {}, "quality": r[6] or {}}
                    for r in cur.fetchall()
                ]

    def cleanup_expired_parts(self, owner_id: str, max_rows: int = 200) -> int:
        """Bounded clean-up of abandoned uploads (called on the owner's own requests)."""
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM tuner_sessions WHERE (owner_id, session_uuid) IN (
                        SELECT owner_id, session_uuid FROM tuner_sessions
                        WHERE owner_id = %s AND status = 'uploading' AND created_at < NOW() - INTERVAL '24 hours'
                        LIMIT %s)
                    """,
                    (owner_id, max_rows),
                )
                removed = cur.rowcount
            conn.commit()
        return int(removed)


def _canonical(value: Any) -> str:
    """Canonical JSON (sorted keys) used only for content comparison."""
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
