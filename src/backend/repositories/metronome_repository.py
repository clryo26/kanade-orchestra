"""DB access for the metronome practice history (summaries only).

Identity: the owner is the shared ``tuner_owners`` row (member + member_birth).
Owner initialisation locks the ``members`` row first and then the owner rows
(``members FOR UPDATE -> tuner_owners``), because a SELECT ... FOR UPDATE of
a not-yet-existing owner cannot serialise two first requests. A unique
violation of the active-owner index (tuner and metronome creating the owner
at the same time) is retried a few times and then reported as retryable.

Writes lock ``tuner_owners -> metronome_preferences -> session`` in that
order and re-check revocation, the metronome history epoch and the consent
revision in the same transaction, so a deletion and a delayed upload can
never interleave into resurrected history (docs/METRONOME_DATA_API_DESIGN.md 7.1).
Callers pass an owner id that the service resolved from the signed-in
member; there is no owner-less lookup by session id.
"""
from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from ..core.db_pool import pooled_psycopg as psycopg

PART_TTL = timedelta(hours=24)
OWNER_INIT_RETRIES = 3


class OwnerRevoked(Exception):
    """The owner was revoked (member deleted / id reused) during the request."""


class MemberRecreated(Exception):
    """The member row changed generation while the owner was resolved."""


class OwnerInitRetry(Exception):
    """Concurrent first creation of the owner; the request can be retried."""


class HistoryEpochMismatch(Exception):
    """The request belongs to an older metronome history epoch."""


class ConsentMismatch(Exception):
    """The consent revision changed, or account storage was not agreed to."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Tombstoned(Exception):
    """The entity id was deleted before; it cannot be written again."""


class Conflict(Exception):
    """Different content for an id / part / revision that already exists."""

    def __init__(self, code: str = "CONFLICT") -> None:
        super().__init__(code)
        self.code = code


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


def _token(*parts: Any) -> str:
    """Opaque, non-reversible token (organisation scope / member birth)."""
    text = "|".join(str(p) for p in parts)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def _cursor_encode(owner_id: str, started_at: datetime, session_uuid: str) -> str:
    raw = f"{_token('cursor', owner_id)}|{_iso(started_at)}|{session_uuid}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


def _cursor_decode(owner_id: str, cursor: str) -> tuple[datetime, str] | None:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        bound, started, session_uuid = raw.split("|")
        if bound != _token("cursor", owner_id):
            return None  # a cursor of another owner is never honoured
        parsed = datetime.fromisoformat(started.replace("Z", "+00:00"))
        return parsed, str(uuid.UUID(session_uuid))
    except (ValueError, UnicodeDecodeError):
        return None


class MetronomeRepository:
    def __init__(self, conn_str: str) -> None:
        self._conn_str = conn_str

    # ----- identity ------------------------------------------------------------

    def member_birth(self, organization_id: str, member_id: int) -> datetime | None:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT created_at FROM members WHERE organization_id = %s AND id = %s", (organization_id, member_id))
                row = cur.fetchone()
                return row[0] if row and row[0] is not None else None

    def resolve_owner(self, organization_id: str, member_id: int, member_birth: datetime) -> dict[str, Any]:
        """Active owner of (organisation, member, birth) and its metronome state.

        Creates the owner when the member never used the tuner (create=true
        path of the shared identity) and the metronome preferences row.
        """
        last_error: Exception | None = None
        for _ in range(OWNER_INIT_RETRIES):
            try:
                return self._resolve_owner_once(organization_id, member_id, member_birth)
            except psycopg.errors.UniqueViolation as exc:  # concurrent first creation
                last_error = exc
                continue
        raise OwnerInitRetry() from last_error

    def _resolve_owner_once(self, organization_id: str, member_id: int, member_birth: datetime) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                # 1. The member row first: it serialises first-time creation.
                cur.execute("SELECT created_at FROM members WHERE organization_id = %s AND id = %s FOR UPDATE", (organization_id, member_id))
                member = cur.fetchone()
                if not member or member[0] is None:
                    raise MemberRecreated()
                birth = member[0] if member[0].tzinfo else member[0].replace(tzinfo=timezone.utc)
                if birth != member_birth:
                    raise MemberRecreated()
                # 2. Then the owner rows.
                cur.execute(
                    """
                    SELECT id, member_birth FROM tuner_owners
                    WHERE organization_id = %s AND member_id = %s AND revoked_at IS NULL
                    FOR UPDATE
                    """,
                    (organization_id, member_id),
                )
                row = cur.fetchone()
                owner_id: str | None = None
                if row and row[1] == member_birth:
                    owner_id = str(row[0])
                elif row:
                    # Same numeric id, other member generation: revoke (017
                    # function; the metronome trigger removes its data too).
                    cur.execute("SELECT tuner_revoke_member_owner(%s, %s, %s)", (organization_id, member_id, "member-birth-mismatch"))
                if owner_id is None:
                    owner_id = str(uuid.uuid4())
                    cur.execute(
                        "INSERT INTO tuner_owners (id, organization_id, member_id, member_birth) VALUES (%s, %s, %s, %s)",
                        (owner_id, organization_id, member_id, member_birth),
                    )
                cur.execute("INSERT INTO metronome_preferences (owner_id) VALUES (%s) ON CONFLICT (owner_id) DO NOTHING", (owner_id,))
                cur.execute(
                    "SELECT history_epoch, consent_revision, account_consent, consent_version, revision FROM metronome_preferences WHERE owner_id = %s",
                    (owner_id,),
                )
                prefs = cur.fetchone()
            conn.commit()
        return {
            "ownerId": owner_id,
            "organizationScopeToken": _token("org", organization_id),
            "memberBirthToken": _token("birth", organization_id, member_id, _iso(member_birth)),
            "active": True,
            "historyEpoch": int(prefs[0]),
            "consentRevision": int(prefs[1]),
            "accountConsent": bool(prefs[2]),
            "consentVersion": prefs[3] or "",
            "revision": int(prefs[4]),
        }

    # ----- locking -------------------------------------------------------------

    @staticmethod
    def _lock(cur: Any, owner_id: str, *, history_epoch: int | None = None, consent_revision: int | None = None, need_consent: bool = False) -> dict[str, Any]:
        cur.execute("SELECT revoked_at FROM tuner_owners WHERE id = %s FOR UPDATE", (owner_id,))
        row = cur.fetchone()
        if not row or row[0] is not None:
            raise OwnerRevoked()
        cur.execute(
            "SELECT history_epoch, consent_revision, account_consent, revision FROM metronome_preferences WHERE owner_id = %s FOR UPDATE",
            (owner_id,),
        )
        prefs = cur.fetchone()
        if not prefs:
            raise OwnerRevoked()
        state = {"historyEpoch": int(prefs[0]), "consentRevision": int(prefs[1]), "accountConsent": bool(prefs[2]), "revision": int(prefs[3])}
        if history_epoch is not None and history_epoch != state["historyEpoch"]:
            raise HistoryEpochMismatch()
        if consent_revision is not None and consent_revision != state["consentRevision"]:
            raise ConsentMismatch("CONSENT_REVISION")
        if need_consent and not state["accountConsent"]:
            raise ConsentMismatch("CONSENT_REQUIRED")
        return state

    # ----- preferences -------------------------------------------------------------

    def get_preferences(self, owner_id: str) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT revision, consent_revision, account_consent, consent_version, history_epoch FROM metronome_preferences WHERE owner_id = %s",
                    (owner_id,),
                )
                row = cur.fetchone()
                if not row:
                    raise NotFound()
                return {"revision": int(row[0]), "consentRevision": int(row[1]), "accountConsent": bool(row[2]), "consentVersion": row[3] or "", "historyEpoch": int(row[4])}

    def put_preferences(self, owner_id: str, expected_revision: int, account_consent: bool, consent_version: str) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                state = self._lock(cur, owner_id)
                if expected_revision != state["revision"]:
                    raise Conflict("REVISION_CONFLICT")
                # A consent change (grant or withdrawal) moves the consent
                # revision: uploads prepared under the old one are refused.
                bump = 1 if account_consent != state["accountConsent"] else 0
                cur.execute(
                    """
                    UPDATE metronome_preferences
                       SET revision = revision + 1, consent_revision = consent_revision + %s,
                           account_consent = %s, consent_version = %s, updated_at = NOW()
                     WHERE owner_id = %s
                    """,
                    (bump, account_consent, consent_version, owner_id),
                )
                if bump and not account_consent:
                    # Withdrawal: unfinished uploads are discarded (sent data stays
                    # until the user deletes it; a separate operation).
                    cur.execute("DELETE FROM metronome_sessions WHERE owner_id = %s AND status = 'uploading'", (owner_id,))
            conn.commit()
        return self.get_preferences(owner_id)

    # ----- sessions ------------------------------------------------------------------

    def create_session(self, owner_id: str, epoch: int, consent_revision: int, data: dict[str, Any], max_sessions: int) -> tuple[dict[str, Any], bool]:
        """Returns (session, created). Same id + same hash is idempotent."""
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock(cur, owner_id, history_epoch=epoch, consent_revision=consent_revision, need_consent=True)
                cur.execute("SELECT 1 FROM metronome_tombstones WHERE owner_id = %s AND entity_type = 'session' AND entity_uuid = %s", (owner_id, data["sessionId"]))
                if cur.fetchone():
                    raise Tombstoned()
                cur.execute("SELECT content_hash, status FROM metronome_sessions WHERE owner_id = %s AND session_uuid = %s FOR UPDATE", (owner_id, data["sessionId"]))
                existing = cur.fetchone()
                if existing:
                    if existing[0] != data["contentHash"]:
                        raise Conflict("SESSION_CONFLICT")
                    conn.commit()
                    return {"sessionId": data["sessionId"], "status": existing[1]}, False
                cur.execute("SELECT COUNT(*) FROM metronome_sessions WHERE owner_id = %s", (owner_id,))
                if int(cur.fetchone()[0]) >= max_sessions:
                    raise OverflowError("STORAGE_LIMIT")
                c = data["counts"]
                cur.execute(
                    """
                    INSERT INTO metronome_sessions (
                        owner_id, session_uuid, history_epoch, attempt_uuid, program_uuid, status, started_at, duration_ms,
                        event_count, target_count, valid_count, local_detail_count, extra_detail_count, extra_total, group_count,
                        condition_key, versions, score_summary, content_hash)
                    VALUES (%s, %s, %s, %s, %s, 'uploading', %s, %s, 0, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
                    """,
                    (
                        owner_id, data["sessionId"], epoch, data["attemptId"], data.get("programId"), data["startedAt"], data["durationMs"],
                        c["target"], c["valid"], c["localDetail"], c["extraDetail"], c["extraTotal"], c["groups"],
                        data["conditionKey"], _jsonb(data["versions"]), _jsonb(data["scoreSummary"]), data["contentHash"],
                    ),
                )
            conn.commit()
        return {"sessionId": data["sessionId"], "status": "uploading"}, True

    def put_part(self, owner_id: str, session_id: str, epoch: int, consent_revision: int, payload_hash: str, groups: list[dict[str, Any]]) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock(cur, owner_id, history_epoch=epoch, consent_revision=consent_revision, need_consent=True)
                cur.execute("SELECT status FROM metronome_sessions WHERE owner_id = %s AND session_uuid = %s FOR UPDATE", (owner_id, session_id))
                row = cur.fetchone()
                if not row:
                    raise NotFound()
                cur.execute("SELECT payload_hash FROM metronome_upload_parts WHERE owner_id = %s AND session_uuid = %s AND part_index = 0", (owner_id, session_id))
                part = cur.fetchone()
                if row[0] != "uploading":
                    if part is None:
                        # Finalised earlier: the same part again is answered as stored.
                        conn.commit()
                        return {"partIndex": 0, "payloadHash": payload_hash, "groupCount": len(groups), "alreadyFinalized": True}
                if part:
                    if part[0] != payload_hash:
                        raise Conflict("PART_CONFLICT")
                    conn.commit()
                    return {"partIndex": 0, "payloadHash": payload_hash, "groupCount": len(groups)}
                cur.execute(
                    "INSERT INTO metronome_upload_parts (owner_id, session_uuid, part_index, payload_hash, groups, expires_at) VALUES (%s, %s, 0, %s, %s::jsonb, %s)",
                    (owner_id, session_id, payload_hash, _jsonb(groups), datetime.now(timezone.utc) + PART_TTL),
                )
            conn.commit()
        return {"partIndex": 0, "payloadHash": payload_hash, "groupCount": len(groups)}

    def finalize(self, owner_id: str, session_id: str, epoch: int, consent_revision: int, part_hash: str, group_count: int, summary: dict[str, Any], status: str) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock(cur, owner_id, history_epoch=epoch, consent_revision=consent_revision, need_consent=True)
                cur.execute(
                    """
                    SELECT status, revision, target_count, valid_count, extra_total, group_count
                    FROM metronome_sessions WHERE owner_id = %s AND session_uuid = %s FOR UPDATE
                    """,
                    (owner_id, session_id),
                )
                row = cur.fetchone()
                if not row:
                    raise NotFound()
                if row[0] != "uploading":
                    conn.commit()
                    return {"sessionId": session_id, "status": row[0], "revision": int(row[1])}
                if group_count != int(row[5]):
                    raise Conflict("SESSION_CONFLICT")
                cur.execute("SELECT payload_hash, groups FROM metronome_upload_parts WHERE owner_id = %s AND session_uuid = %s AND part_index = 0", (owner_id, session_id))
                part = cur.fetchone()
                if not part or part[0] != part_hash:
                    raise Conflict("PART_CONFLICT")
                groups = part[1] or []
                if len(groups) != group_count:
                    raise Conflict("SESSION_CONFLICT")
                # Groups partition the expected beats: their counts must add up.
                if group_count and (
                    sum(int(g["targetCount"]) for g in groups) != int(row[2])
                    or sum(int(g["validCount"]) for g in groups) != int(row[3])
                ):
                    raise Conflict("SESSION_CONFLICT")
                for g in groups:
                    cur.execute(
                        """
                        INSERT INTO metronome_summary_groups (
                            owner_id, session_uuid, ordinal, condition_key, layer_key, beat_position_key,
                            target_count, valid_count, extra_total, stats, quality)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
                        """,
                        (
                            owner_id, session_id, g["ordinal"], g["conditionKey"], g["layerKey"], g["beatPositionKey"],
                            g["targetCount"], g["validCount"], g["extraTotal"], _jsonb(g["stats"]), _jsonb(g["quality"]),
                        ),
                    )
                cur.execute(
                    "UPDATE metronome_sessions SET status = %s, summary = %s::jsonb, finalized_at = NOW(), updated_at = NOW() WHERE owner_id = %s AND session_uuid = %s",
                    (status, _jsonb(summary), owner_id, session_id),
                )
                cur.execute("DELETE FROM metronome_upload_parts WHERE owner_id = %s AND session_uuid = %s", (owner_id, session_id))
            conn.commit()
        return {"sessionId": session_id, "status": status, "revision": int(row[1])}

    def list_sessions(self, owner_id: str, start: datetime | None, end: datetime | None, condition: str | None, cursor: str | None, limit: int) -> dict[str, Any]:
        clauses = ["owner_id = %s", "status IN ('complete', 'incomplete')"]
        params: list[Any] = [owner_id]
        if start:
            clauses.append("started_at >= %s")
            params.append(start)
        if end:
            clauses.append("started_at < %s")
            params.append(end)
        if condition:
            clauses.append("condition_key = %s")
            params.append(condition)
        if cursor:
            decoded = _cursor_decode(owner_id, cursor)
            if decoded is None:
                raise NotFound()
            clauses.append("(started_at, session_uuid) < (%s, %s)")
            params.extend([decoded[0], decoded[1]])
        params.append(limit + 1)
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT session_uuid, attempt_uuid, program_uuid, status, started_at, duration_ms, target_count, valid_count,
                           group_count, condition_key, summary, versions
                    FROM metronome_sessions WHERE {' AND '.join(clauses)}
                    ORDER BY started_at DESC, session_uuid DESC LIMIT %s
                    """,
                    params,
                )
                rows = cur.fetchall()
        items = [
            {
                "sessionId": str(r[0]), "attemptId": str(r[1]), "programId": str(r[2]) if r[2] else None, "status": r[3], "startedAt": _iso(r[4]),
                "durationMs": int(r[5]), "targetCount": int(r[6]), "validCount": int(r[7]), "groupCount": int(r[8]), "conditionKey": r[9],
                "summary": r[10] or {}, "versions": r[11] or {},
            }
            for r in rows[:limit]
        ]
        next_cursor = _cursor_encode(owner_id, rows[limit - 1][4], str(rows[limit - 1][0])) if len(rows) > limit else None
        return {"items": items, "nextCursor": next_cursor}

    def get_session(self, owner_id: str, session_id: str) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT status, started_at, duration_ms, target_count, valid_count, local_detail_count, extra_detail_count,
                           extra_total, group_count, condition_key, versions, score_summary, summary
                    FROM metronome_sessions
                    WHERE owner_id = %s AND session_uuid = %s AND status IN ('complete', 'incomplete')
                    """,
                    (owner_id, session_id),
                )
                r = cur.fetchone()
                if not r:
                    raise NotFound()
                cur.execute(
                    """
                    SELECT ordinal, condition_key, layer_key, beat_position_key, target_count, valid_count, extra_total, stats, quality
                    FROM metronome_summary_groups WHERE owner_id = %s AND session_uuid = %s ORDER BY ordinal
                    """,
                    (owner_id, session_id),
                )
                groups = [
                    {"ordinal": int(g[0]), "conditionKey": g[1], "layerKey": g[2], "beatPositionKey": g[3], "targetCount": int(g[4]), "validCount": int(g[5]), "extraTotal": int(g[6]), "stats": g[7] or {}, "quality": g[8] or {}}
                    for g in cur.fetchall()
                ]
        return {
            "sessionId": session_id, "status": r[0], "startedAt": _iso(r[1]), "durationMs": int(r[2]),
            "counts": {"target": int(r[3]), "valid": int(r[4]), "localDetail": int(r[5]), "extraDetail": int(r[6]), "extraTotal": int(r[7]), "groups": int(r[8])},
            "conditionKey": r[9], "versions": r[10] or {}, "scoreSummary": r[11] or {}, "summary": r[12] or {}, "groups": groups,
            "details": "local-only",
        }

    # ----- deletion ---------------------------------------------------------------------

    @staticmethod
    def _operation(cur: Any, owner_id: str, operation_id: str, request_hash: str) -> dict[str, Any] | None:
        cur.execute("SELECT request_hash, response FROM metronome_operations WHERE owner_id = %s AND operation_uuid = %s", (owner_id, operation_id))
        row = cur.fetchone()
        if not row:
            return None
        if row[0] != request_hash:
            raise Conflict("CONFLICT")
        return row[1] or {}

    def delete_session(self, owner_id: str, session_id: str, operation_id: str, epoch: int) -> dict[str, Any]:
        request_hash = _token("delete-session", session_id, epoch)
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock(cur, owner_id)
                done = self._operation(cur, owner_id, operation_id, request_hash)
                if done is not None:
                    conn.commit()
                    return done
                self._lock(cur, owner_id, history_epoch=epoch)
                cur.execute("SELECT 1 FROM metronome_sessions WHERE owner_id = %s AND session_uuid = %s FOR UPDATE", (owner_id, session_id))
                if not cur.fetchone():
                    raise NotFound()
                cur.execute(
                    "INSERT INTO metronome_tombstones (owner_id, entity_type, entity_uuid, history_epoch) VALUES (%s, 'session', %s, %s) ON CONFLICT DO NOTHING",
                    (owner_id, session_id, epoch),
                )
                cur.execute("DELETE FROM metronome_sessions WHERE owner_id = %s AND session_uuid = %s", (owner_id, session_id))
                response = {"deletedId": session_id, "tombstone": True}
                cur.execute(
                    "INSERT INTO metronome_operations (owner_id, operation_uuid, kind, request_hash, response) VALUES (%s, %s, 'delete-session', %s, %s::jsonb)",
                    (owner_id, operation_id, request_hash, _jsonb(response)),
                )
            conn.commit()
        return response

    def delete_history(self, owner_id: str, operation_id: str, epoch: int) -> dict[str, Any]:
        """Full deletion of this owner's metronome history (tuner history,
        presets and preferences / consent stay)."""
        request_hash = _token("delete-history", epoch)
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock(cur, owner_id)
                done = self._operation(cur, owner_id, operation_id, request_hash)
                if done is not None:
                    conn.commit()
                    return done
                self._lock(cur, owner_id, history_epoch=epoch)
                cur.execute("DELETE FROM metronome_sessions WHERE owner_id = %s", (owner_id,))
                deleted = cur.rowcount
                cur.execute("DELETE FROM metronome_tombstones WHERE owner_id = %s AND entity_type = 'session'", (owner_id,))
                cur.execute(
                    "UPDATE metronome_preferences SET history_epoch = history_epoch + 1, updated_at = NOW() WHERE owner_id = %s RETURNING history_epoch",
                    (owner_id,),
                )
                new_epoch = int(cur.fetchone()[0])
                response = {"historyEpoch": new_epoch, "deletedCount": int(deleted)}
                cur.execute(
                    "INSERT INTO metronome_operations (owner_id, operation_uuid, kind, request_hash, response) VALUES (%s, %s, 'delete-history', %s, %s::jsonb)",
                    (owner_id, operation_id, request_hash, _jsonb(response)),
                )
            conn.commit()
        return response

    # ----- presets ---------------------------------------------------------------------

    def list_presets(self, owner_id: str, limit: int) -> list[dict[str, Any]]:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT preset_uuid, revision, kind, payload, created_at FROM metronome_presets WHERE owner_id = %s ORDER BY created_at DESC, preset_uuid, revision DESC LIMIT %s",
                    (owner_id, limit),
                )
                return [{"id": str(r[0]), "revision": int(r[1]), "kind": r[2], "preset": r[3] or {}, "createdAt": _iso(r[4])} for r in cur.fetchall()]

    def create_preset(self, owner_id: str, epoch: int, consent_revision: int, preset_id: str, revision: int, kind: str, envelope: dict[str, Any], max_presets: int) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock(cur, owner_id, history_epoch=epoch, consent_revision=consent_revision, need_consent=True)
                cur.execute("SELECT 1 FROM metronome_tombstones WHERE owner_id = %s AND entity_type = 'preset' AND entity_uuid = %s", (owner_id, preset_id))
                if cur.fetchone():
                    raise Tombstoned()
                cur.execute("SELECT payload FROM metronome_presets WHERE owner_id = %s AND preset_uuid = %s AND revision = %s", (owner_id, preset_id, revision))
                existing = cur.fetchone()
                if existing:
                    if (existing[0] or {}) != envelope:
                        raise Conflict("REVISION_CONFLICT")
                    conn.commit()
                    return {"id": preset_id, "revision": revision}
                cur.execute("SELECT COUNT(*) FROM metronome_presets WHERE owner_id = %s", (owner_id,))
                if int(cur.fetchone()[0]) >= max_presets:
                    raise OverflowError("STORAGE_LIMIT")
                cur.execute(
                    "INSERT INTO metronome_presets (owner_id, preset_uuid, revision, kind, payload) VALUES (%s, %s, %s, %s, %s::jsonb)",
                    (owner_id, preset_id, revision, kind, _jsonb(envelope)),
                )
            conn.commit()
        return {"id": preset_id, "revision": revision}

    def delete_preset(self, owner_id: str, preset_id: str, operation_id: str, epoch: int) -> dict[str, Any]:
        request_hash = _token("delete-preset", preset_id, epoch)
        with psycopg.connect(self._conn_str, autocommit=False) as conn:
            with conn.cursor() as cur:
                self._lock(cur, owner_id)
                done = self._operation(cur, owner_id, operation_id, request_hash)
                if done is not None:
                    conn.commit()
                    return done
                self._lock(cur, owner_id, history_epoch=epoch)
                cur.execute("SELECT 1 FROM metronome_presets WHERE owner_id = %s AND preset_uuid = %s", (owner_id, preset_id))
                if not cur.fetchone():
                    raise NotFound()
                # Referenced by another stored preset of this owner: refused.
                cur.execute(
                    "SELECT 1 FROM metronome_presets WHERE owner_id = %s AND preset_uuid <> %s AND payload -> 'payload' ->> 'basePresetId' = %s LIMIT 1",
                    (owner_id, preset_id, preset_id),
                )
                if cur.fetchone():
                    raise Conflict("PRESET_IN_USE")
                cur.execute("DELETE FROM metronome_presets WHERE owner_id = %s AND preset_uuid = %s", (owner_id, preset_id))
                cur.execute(
                    "INSERT INTO metronome_tombstones (owner_id, entity_type, entity_uuid, history_epoch) VALUES (%s, 'preset', %s, %s) ON CONFLICT DO NOTHING",
                    (owner_id, preset_id, epoch),
                )
                response = {"id": preset_id}
                cur.execute(
                    "INSERT INTO metronome_operations (owner_id, operation_uuid, kind, request_hash, response) VALUES (%s, %s, 'delete-preset', %s, %s::jsonb)",
                    (owner_id, operation_id, request_hash, _jsonb(response)),
                )
            conn.commit()
        return response
