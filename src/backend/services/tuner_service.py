"""Tuner practice history: owner resolution, validation, limits, diagnosis.

Identity (docs/TUNER_ADVANCED_DATA_API_DESIGN.md 5): the owner is never
chosen by the client. It is resolved on every request from the signed-in
device -> its member -> the member row's immutable creation time
(``member_birth``). A device that authenticated before the current member
row was created (a reused numeric id) is refused with REAUTH_REQUIRED. The
hidden system administrator has no member and therefore no account storage.
Only summaries are accepted; audio and pitch series are never part of the API.
"""
from __future__ import annotations

import base64
import csv
import io
import logging
import math
import random
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, ParamSpec, TypeVar

from fastapi import HTTPException

from ..core import db_connection_string
from ..core.tenant_context import get_current_tenant_id
from ..db.database import db_data_enabled
from ..repositories.tuner_repository import (
    Conflict,
    HistoryEpochMismatch,
    NotFound,
    OwnerRevoked,
    Tombstoned,
    TunerRepository,
)

logger = logging.getLogger(__name__)

_P = ParamSpec("_P")
_R = TypeVar("_R")

SCHEMA_VERSION = 1
LIMITS = {
    "sessions": 2000,
    "events": 200_000,
    "bytes": 50 * 1024 * 1024,
    "instruments": 50,
    "presets": 200,
    "session_events": 10_000,
    "session_ms": 7_200_000,
    "part_events": 500,
    "part_bytes": 1024 * 1024,
    "json_bytes": 64 * 1024,
    "event_json_bytes": 16 * 1024,
    "string_chars": 2000,
    "depth": 8,
    "array_items": 1000,
}
PRESET_KINDS = {"temperament", "sound", "exercise", "analysis"}
SESSION_KINDS = {"free", "longtone", "chromatic", "major", "minor", "leap", "repeat", "dynamics", "ear", "interval", "custom", "metronome", "warmup"}
DIAGNOSIS_RULES = {"min_events": 5, "min_sessions": 3, "min_event_ms": 150, "min_observations": 3, "min_coverage": 0.8, "max_interval_width": 10.0, "bootstrap": 400}


def _repository() -> TunerRepository:
    return TunerRepository(db_connection_string())


def _error(status: int, code: str, message: str) -> HTTPException:
    # No internal storage names, SQL or other people's existence in errors.
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _unavailable(reason: str) -> HTTPException:
    return _error(403, "ACCOUNT_STORAGE_UNAVAILABLE", "このアカウントでは練習履歴をアカウントに保存できません。端末内の保存を使えます。" if reason else "")


# ----- validation -------------------------------------------------------------

def _check_json(value: Any, *, max_bytes: int, path: str = "value", depth: int = 0) -> None:
    if depth > LIMITS["depth"]:
        raise _error(400, "INVALID", f"{path}: too deeply nested")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise _error(400, "INVALID", f"{path}: non-finite number")
        return
    if isinstance(value, str):
        if len(value) > LIMITS["string_chars"]:
            raise _error(400, "INVALID", f"{path}: text too long")
        return
    if isinstance(value, list):
        if len(value) > LIMITS["array_items"]:
            raise _error(400, "INVALID", f"{path}: too many items")
        for i, item in enumerate(value):
            _check_json(item, max_bytes=max_bytes, path=f"{path}[{i}]", depth=depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 200:
            raise _error(400, "INVALID", f"{path}: too many fields")
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > 64:
                raise _error(400, "INVALID", f"{path}: invalid field name")
            _check_json(item, max_bytes=max_bytes, path=f"{path}.{key}", depth=depth + 1)
        return
    raise _error(400, "INVALID", f"{path}: unsupported value")


def _json_size(value: Any) -> int:
    import json

    return len(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))


def _object(value: Any, name: str, max_bytes: int) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise _error(400, "INVALID", f"{name}: object required")
    _check_json(value, max_bytes=max_bytes, path=name)
    if _json_size(value) > max_bytes:
        raise _error(413, "TOO_LARGE", f"{name}: too large")
    return value


def _uuid(value: Any, name: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise _error(400, "INVALID", f"{name}: UUID required") from None


def _int(value: Any, name: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) or int(value) != value:
        raise _error(400, "INVALID", f"{name}: integer required")
    number = int(value)
    if number < lo or number > hi:
        raise _error(400, "INVALID", f"{name}: out of range")
    return number


def _text(value: Any, name: str, max_chars: int = 200) -> str:
    text = "" if value is None else str(value)
    text = "".join(ch for ch in text if ch == "\n" or ord(ch) >= 32)
    if len(text) > max_chars:
        raise _error(400, "INVALID", f"{name}: too long")
    return text


def _schema(body: dict[str, Any]) -> None:
    if body.get("schemaVersion") != SCHEMA_VERSION:
        raise _error(400, "UNSUPPORTED_SCHEMA", "unsupported schemaVersion")


def _parse_time(value: Any, name: str) -> datetime:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
        return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise _error(400, "INVALID", f"{name}: invalid time") from None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    raise _error(400, "INVALID", f"{name}: time required")


def _as_utc(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ----- identity -----------------------------------------------------------------

def resolve_owner(device: dict[str, Any], *, create: bool = True) -> dict[str, Any]:
    if not db_data_enabled():
        raise _unavailable("db-unavailable")
    member_id = device.get("member_id")
    if member_id is None or member_id == "" or bool(device.get("hidden_user")):
        raise _unavailable("no-member")
    try:
        member_id = int(member_id)
    except (TypeError, ValueError):
        raise _unavailable("no-member") from None
    organization_id = get_current_tenant_id()
    repo = _repository()
    birth = repo.member_birth(organization_id, member_id)
    if birth is None:
        raise _unavailable("member-missing")
    birth = birth if birth.tzinfo else birth.replace(tzinfo=timezone.utc)
    authenticated = _as_utc(device.get("authenticated_at")) or _as_utc(device.get("created_at"))
    if authenticated is None or authenticated < birth:
        # This device signed in for an earlier member with the same id.
        raise _error(403, "REAUTH_REQUIRED", "もう一度ログインしてください。")
    owner = repo.resolve_owner(organization_id, member_id, birth, create=create)
    if not owner:
        raise _unavailable("no-owner")
    return {"ownerId": owner["id"], "historyEpoch": owner["history_epoch"], "repo": repo}


def identity(device: dict[str, Any]) -> dict[str, Any]:
    try:
        owner = resolve_owner(device, create=True)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        if detail.get("code") == "ACCOUNT_STORAGE_UNAVAILABLE":
            return {"schemaVersion": SCHEMA_VERSION, "accountStorageAvailable": False, "ownerId": None, "historyEpoch": None}
        raise
    return {"schemaVersion": SCHEMA_VERSION, "accountStorageAvailable": True, "ownerId": owner["ownerId"], "historyEpoch": owner["historyEpoch"]}


def _guarded(fn: Callable[_P, _R]) -> Callable[_P, _R]:
    """Maps repository conditions to the API's status codes."""

    def wrapper(*args: _P.args, **kwargs: _P.kwargs) -> _R:
        try:
            return fn(*args, **kwargs)
        except OwnerRevoked:
            raise _error(403, "REAUTH_REQUIRED", "もう一度ログインしてください。") from None
        except HistoryEpochMismatch:
            raise _error(409, "HISTORY_EPOCH", "履歴が削除されたため、この保存は受け付けられません。") from None
        except Tombstoned:
            raise _error(410, "DELETED", "削除済みの記録です。") from None
        except Conflict:
            raise _error(409, "CONFLICT", "保存済みの内容と一致しません。") from None
        except NotFound:
            raise _error(404, "NOT_FOUND", "見つかりません。") from None
        except OverflowError:
            raise _error(409, "STORAGE_LIMIT", "保存できる上限に達しました。不要な履歴を削除してください。") from None

    wrapper.__name__ = fn.__name__
    return wrapper


def _epoch(body: dict[str, Any]) -> int:
    return _int(body.get("historyEpoch"), "historyEpoch", 1, 2**31 - 1)


# ----- preferences / instruments / presets ------------------------------------------

@_guarded
def get_preferences(device: dict[str, Any]) -> dict[str, Any]:
    owner = resolve_owner(device)
    data = owner["repo"].get_preferences(owner["ownerId"])
    return {"schemaVersion": SCHEMA_VERSION, "revision": data["revision"], "data": data}


@_guarded
def put_preferences(device: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    _schema(body)
    owner = resolve_owner(device)
    revision = _int(body.get("revision"), "revision", 0, 2**31 - 1)
    prefs = _object(body.get("preferences"), "preferences", LIMITS["json_bytes"])
    data = owner["repo"].put_preferences(owner["ownerId"], revision, prefs, _text(body.get("consentVersion"), "consentVersion", 40))
    return {"schemaVersion": SCHEMA_VERSION, "revision": data["revision"], "data": data}


def _instrument_profile(raw: Any) -> dict[str, Any]:
    profile = _object(raw, "instrument", LIMITS["json_bytes"])
    out: dict[str, Any] = {
        "name": _text(profile.get("name"), "name", 80),
        "kind": _text(profile.get("kind"), "kind", 40),
        "maker": _text(profile.get("maker"), "maker", 80),
        "model": _text(profile.get("model"), "model", 80),
        "nickname": _text(profile.get("nickname"), "nickname", 80),
        "memo": _text(profile.get("memo"), "memo", 1000),
        "settings": [],
        "maintenance": [],
        "registerBoundaries": None,
    }
    for item in (profile.get("settings") or [])[:50]:
        if isinstance(item, dict):
            out["settings"].append({"label": _text(item.get("label"), "settings.label", 80), "value": _text(item.get("value"), "settings.value", 200), "revision": _int(item.get("revision") or 1, "settings.revision", 1, 10_000)})
    for item in (profile.get("maintenance") or [])[:100]:
        if isinstance(item, dict):
            out["maintenance"].append({"date": _text(item.get("date"), "maintenance.date", 20), "memo": _text(item.get("memo"), "maintenance.memo", 500)})
    boundaries = profile.get("registerBoundaries")
    if isinstance(boundaries, dict):
        out["registerBoundaries"] = {
            "lowMax": _int(boundaries.get("lowMax"), "lowMax", 24, 108),
            "midMax": _int(boundaries.get("midMax"), "midMax", 24, 108),
        }
    range_ = profile.get("range")
    if isinstance(range_, dict):
        out["range"] = {"lowMidi": _int(range_.get("lowMidi"), "lowMidi", 24, 108), "highMidi": _int(range_.get("highMidi"), "highMidi", 24, 108)}
    if not out["name"].strip():
        raise _error(400, "INVALID", "name: required")
    return out


@_guarded
def list_instruments(device: dict[str, Any]) -> dict[str, Any]:
    owner = resolve_owner(device)
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": owner["repo"].list_instruments(owner["ownerId"])}


@_guarded
def create_instrument(device: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    _schema(body)
    owner = resolve_owner(device)
    raw = body.get("instrument") or {}
    instrument_id = _uuid(raw.get("instrumentId"), "instrumentId")
    data = owner["repo"].create_instrument(owner["ownerId"], instrument_id, _instrument_profile(raw), LIMITS["instruments"])
    return {"schemaVersion": SCHEMA_VERSION, "revision": data["revision"], "data": data}


@_guarded
def update_instrument(device: dict[str, Any], instrument_id: str, body: dict[str, Any]) -> dict[str, Any]:
    _schema(body)
    owner = resolve_owner(device)
    data = owner["repo"].update_instrument(
        owner["ownerId"], _uuid(instrument_id, "instrumentId"), _int(body.get("revision"), "revision", 1, 2**31 - 1), _instrument_profile(body.get("instrument"))
    )
    return {"schemaVersion": SCHEMA_VERSION, "revision": data["revision"], "data": data}


@_guarded
def delete_instrument(device: dict[str, Any], instrument_id: str) -> dict[str, Any]:
    owner = resolve_owner(device)
    owner["repo"].delete_instrument(owner["ownerId"], _uuid(instrument_id, "instrumentId"))
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": {"deleted": True}}


@_guarded
def list_presets(device: dict[str, Any]) -> dict[str, Any]:
    owner = resolve_owner(device)
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": owner["repo"].list_presets(owner["ownerId"])}


@_guarded
def create_preset(device: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    _schema(body)
    owner = resolve_owner(device)
    raw = body.get("preset") or {}
    if not isinstance(raw, dict):
        raise _error(400, "INVALID", "preset: object required")
    kind = str(raw.get("kind") or "")
    if kind not in PRESET_KINDS:
        raise _error(400, "INVALID", "kind: unsupported")
    payload = _object(raw.get("payload"), "payload", LIMITS["json_bytes"])
    data = owner["repo"].create_preset(owner["ownerId"], _uuid(raw.get("presetId"), "presetId"), kind, payload, LIMITS["presets"])
    return {"schemaVersion": SCHEMA_VERSION, "revision": data["revision"], "data": data}


@_guarded
def delete_preset(device: dict[str, Any], preset_id: str) -> dict[str, Any]:
    owner = resolve_owner(device)
    owner["repo"].delete_preset(owner["ownerId"], _uuid(preset_id, "presetId"))
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": {"deleted": True}}


# ----- sessions ---------------------------------------------------------------------------

def _session_payload(raw: Any) -> tuple[dict[str, Any], datetime]:
    if not isinstance(raw, dict):
        raise _error(400, "INVALID", "session: object required")
    started_at = _parse_time(raw.get("startedAt"), "startedAt")
    kind = str(raw.get("kind") or "free")
    if kind not in SESSION_KINDS:
        raise _error(400, "INVALID", "kind: unsupported")
    session = {
        "sessionId": _uuid(raw.get("sessionId"), "sessionId"),
        "startedAt": started_at.isoformat(),
        "durationMs": _int(raw.get("durationMs") or 0, "durationMs", 0, LIMITS["session_ms"]),
        "kind": kind,
        "status": "complete",
        "conditionKey": _text(raw.get("conditionKey"), "conditionKey", 64),
        "eventCount": _int(raw.get("eventCount") or 0, "eventCount", 0, LIMITS["session_events"]),
        "conditions": _object(raw.get("conditions"), "conditions", LIMITS["json_bytes"]),
        "versions": _object(raw.get("versions"), "versions", 4096),
        "summary": _object(raw.get("summary"), "summary", LIMITS["json_bytes"]),
        "result": _object(raw.get("result"), "result", LIMITS["json_bytes"]),
        "instrumentSnapshot": _object(raw.get("instrumentSnapshot"), "instrumentSnapshot", LIMITS["json_bytes"]),
        "targetSnapshot": _object(raw.get("targetSnapshot"), "targetSnapshot", LIMITS["json_bytes"]),
    }
    instrument = (raw.get("instrumentSnapshot") or {}).get("instrumentId") if isinstance(raw.get("instrumentSnapshot"), dict) else None
    session["instrumentId"] = _uuid(instrument, "instrumentId") if instrument else None
    return session, started_at


def _event_payload(raw: Any, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise _error(400, "INVALID", f"events[{index}]: object required")
    start = _int(raw.get("startMs") or 0, f"events[{index}].startMs", 0, LIMITS["session_ms"])
    end = _int(raw.get("endMs") or 0, f"events[{index}].endMs", start, LIMITS["session_ms"])
    return {
        "eventId": _uuid(raw.get("eventId"), f"events[{index}].eventId"),
        "ordinal": _int(raw.get("ordinal") if raw.get("ordinal") is not None else index, f"events[{index}].ordinal", 0, LIMITS["session_events"]),
        "startMs": start,
        "endMs": end,
        "target": _object(raw.get("target"), f"events[{index}].target", 4096),
        "stats": _object(raw.get("stats"), f"events[{index}].stats", LIMITS["event_json_bytes"]),
        "quality": _object(raw.get("quality"), f"events[{index}].quality", 4096),
    }


@_guarded
def create_session(device: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    _schema(body)
    owner = resolve_owner(device)
    repo = owner["repo"]
    repo.cleanup_expired_parts(owner["ownerId"])
    operation_id = _uuid(body.get("clientOperationId"), "clientOperationId")
    session, started_at = _session_payload(body.get("session"))
    usage = repo.usage(owner["ownerId"])
    if usage["bytes"] + _json_size(session) > LIMITS["bytes"]:
        raise OverflowError("STORAGE_LIMIT")
    data = repo.create_session(owner["ownerId"], _epoch(body), session, started_at, operation_id, {"sessions": LIMITS["sessions"], "events": LIMITS["events"]})
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": data}


@_guarded
def put_part(device: dict[str, Any], session_id: str, index: int, body: dict[str, Any]) -> dict[str, Any]:
    _schema(body)
    owner = resolve_owner(device)
    if not isinstance(index, int) or index < 0 or index >= 100:
        raise _error(400, "INVALID", "part index out of range")
    events_raw = body.get("events")
    if not isinstance(events_raw, list) or not events_raw:
        raise _error(400, "INVALID", "events: list required")
    if len(events_raw) > LIMITS["part_events"]:
        raise _error(413, "TOO_LARGE", "too many events in one part")
    events = [_event_payload(ev, i) for i, ev in enumerate(events_raw)]
    if _json_size(events) > LIMITS["part_bytes"]:
        raise _error(413, "TOO_LARGE", "part too large")
    payload_hash = _text(body.get("hash"), "hash", 64)
    if not payload_hash:
        raise _error(400, "INVALID", "hash: required")
    data = owner["repo"].put_part(owner["ownerId"], _epoch(body), _uuid(session_id, "sessionId"), index, payload_hash, events)
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": data}


@_guarded
def finalize_session(device: dict[str, Any], session_id: str, body: dict[str, Any]) -> dict[str, Any]:
    _schema(body)
    owner = resolve_owner(device)
    hashes = body.get("partHashes")
    if not isinstance(hashes, list) or len(hashes) > 100 or not all(isinstance(h, str) and len(h) <= 64 for h in hashes):
        raise _error(400, "INVALID", "partHashes: list required")
    part_count = _int(body.get("partCount"), "partCount", 0, 100)
    if part_count != len(hashes):
        raise _error(400, "INVALID", "partCount mismatch")
    event_count = _int(body.get("eventCount"), "eventCount", 0, LIMITS["session_events"])
    data = owner["repo"].finalize(owner["ownerId"], _epoch(body), _uuid(session_id, "sessionId"), hashes, event_count)
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": data}


def _encode_cursor(started_at: datetime, session_id: str) -> str:
    raw = f"{started_at.isoformat()}|{session_id}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(cursor: str | None) -> tuple[datetime, str] | None:
    if not cursor:
        return None
    try:
        text = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        started, session_id = text.split("|", 1)
        return _parse_time(started, "cursor"), _uuid(session_id, "cursor")
    except (ValueError, UnicodeDecodeError, HTTPException):
        raise _error(400, "INVALID", "cursor: invalid") from None


@_guarded
def list_sessions(device: dict[str, Any], query: dict[str, Any]) -> dict[str, Any]:
    owner = resolve_owner(device)
    limit = _int(int(query.get("limit") or 20), "limit", 1, 100)
    filters: dict[str, Any] = {}
    if query.get("from"):
        filters["from"] = _parse_time(query["from"], "from")
    if query.get("to"):
        filters["to"] = _parse_time(query["to"], "to")
    if query.get("instrument"):
        filters["instrument"] = _uuid(query["instrument"], "instrument")
    if query.get("kind"):
        filters["kind"] = _text(query["kind"], "kind", 20)
    if query.get("condition"):
        filters["condition"] = _text(query["condition"], "condition", 64)
    rows = owner["repo"].list_sessions(owner["ownerId"], filters, limit, _decode_cursor(query.get("cursor")))
    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        next_cursor = _encode_cursor(last["startedAtRaw"], last["sessionId"])
        rows = rows[:limit]
    for row in rows:
        row.pop("startedAtRaw", None)
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": {"sessions": rows, "nextCursor": next_cursor}}


@_guarded
def get_session(device: dict[str, Any], session_id: str, cursor: str | None) -> dict[str, Any]:
    owner = resolve_owner(device)
    offset = _int(int(cursor), "cursor", 0, LIMITS["session_events"]) if cursor else 0
    data = owner["repo"].get_session(owner["ownerId"], _uuid(session_id, "sessionId"), offset, 500)
    if not data:
        # Another owner's id and a missing id look the same.
        raise NotFound()
    events = data["events"]
    data["nextEventCursor"] = str(offset + 500) if len(events) > 500 else None
    data["events"] = events[:500]
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": data}


@_guarded
def delete_session(device: dict[str, Any], session_id: str) -> dict[str, Any]:
    owner = resolve_owner(device)
    deleted = owner["repo"].delete_session(owner["ownerId"], _uuid(session_id, "sessionId"))
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": {"deleted": deleted}}


@_guarded
def delete_history(device: dict[str, Any]) -> dict[str, Any]:
    owner = resolve_owner(device)
    epoch = owner["repo"].delete_history(owner["ownerId"], None)
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": {"historyEpoch": epoch}}


# ----- diagnosis (same rules as intonation_profile.js) ---------------------------------------

def _eligible(stats: dict[str, Any], quality: dict[str, Any]) -> str | None:
    if quality.get("simultaneousPlayback") or quality.get("playbackOverlap"):
        return "playback"
    if quality.get("boundaryType") == "targetChange" and quality.get("countsAsAttempt") is False:
        return "target-change"
    if not (float(stats.get("durationSeconds") or 0) * 1000 >= DIAGNOSIS_RULES["min_event_ms"]):
        return "short"
    if not (int(stats.get("observationCount") or 0) >= DIAGNOSIS_RULES["min_observations"]):
        return "few-observations"
    if not (float(stats.get("coverage") or 0) >= DIAGNOSIS_RULES["min_coverage"]):
        return "low-coverage"
    for key in ("meanCents", "medianCents"):
        value = stats.get(key)
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            return "no-value"
    if quality.get("unknownFlags"):
        return "unknown-flags"
    return None


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    v = sorted(values)
    mid = len(v) // 2
    return v[mid] if len(v) % 2 else (v[mid - 1] + v[mid]) / 2


def _summarize(events: list[dict[str, Any]]) -> dict[str, Any]:
    by_session: dict[str, list[float]] = {}
    excluded: dict[str, int] = {}
    for ev in events:
        reason = _eligible(ev["stats"], ev["quality"])
        if reason:
            excluded[reason] = excluded.get(reason, 0) + 1
            continue
        by_session.setdefault(ev["sessionId"], []).append(float(ev["stats"]["medianCents"]))
    session_means = [sum(v) / len(v) for v in by_session.values()]
    n_events = sum(len(v) for v in by_session.values())
    interval = None
    if len(session_means) >= 2:
        rng = random.Random(12345)
        means = sorted(sum(rng.choice(session_means) for _ in session_means) / len(session_means) for _ in range(int(DIAGNOSIS_RULES["bootstrap"])))
        interval = [means[int(0.025 * (len(means) - 1))], means[math.ceil(0.975 * (len(means) - 1))]]
    if n_events < DIAGNOSIS_RULES["min_events"] or len(session_means) < DIAGNOSIS_RULES["min_sessions"]:
        status = "insufficient"
    elif not interval or interval[1] - interval[0] > DIAGNOSIS_RULES["max_interval_width"]:
        status = "reference"
    else:
        status = "ok"
    tendency = "undetermined"
    if status == "ok" and interval:
        tendency = "high" if interval[0] > 0 else ("low" if interval[1] < 0 else "none")
    return {
        "status": status,
        "nEvents": n_events,
        "nSessions": len(session_means),
        "meanCents": sum(session_means) / len(session_means) if session_means else None,
        "medianCents": _median([_median(v) or 0.0 for v in by_session.values()]) if by_session else None,
        "interval95": interval,
        "tendency": tendency,
        "excludedByReason": excluded,
    }


@_guarded
def diagnosis(device: dict[str, Any], condition_key: str) -> dict[str, Any]:
    owner = resolve_owner(device)
    key = _text(condition_key, "condition", 64)
    if not key:
        raise _error(400, "INVALID", "condition: required")
    rows = owner["repo"].diagnosis_events(owner["ownerId"], key, 20000)
    versions = {f"{(r['versions'] or {}).get('engineVersion', 'unknown')}/{(r['versions'] or {}).get('statsVersion', 'unknown')}" for r in rows}
    by_midi: dict[int, list[dict[str, Any]]] = {}
    for row in rows:
        midi = (row["target"] or {}).get("midi")
        if isinstance(midi, int) and not isinstance(midi, bool):
            by_midi.setdefault(midi, []).append(row)
    notes = {str(midi): _summarize(items) for midi, items in sorted(by_midi.items())}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "revision": 1,
        "data": {
            "conditionKey": key,
            # Results from different engine/statistics versions are never merged silently.
            "versions": sorted(versions),
            "comparable": len(versions) <= 1,
            "notes": notes,
            "rules": DIAGNOSIS_RULES,
        },
    }


# ----- export ---------------------------------------------------------------------------------------

def _csv_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, float) and not math.isfinite(value):
        return ""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


@_guarded
def export_data(device: dict[str, Any], fmt: str, cursor: str | None) -> dict[str, Any] | str:
    owner = resolve_owner(device)
    rows = owner["repo"].list_sessions(owner["ownerId"], {}, 50, _decode_cursor(cursor))
    page = rows[:50]
    next_cursor = _encode_cursor(page[-1]["startedAtRaw"], page[-1]["sessionId"]) if len(rows) > 50 and page else None
    details = [owner["repo"].get_session(owner["ownerId"], row["sessionId"], 0, LIMITS["session_events"]) for row in page]
    details = [d for d in details if d]
    if fmt == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\r\n")
        writer.writerow(["session_id", "started_at", "kind", "condition_key", "event_id", "start_ms", "end_ms", "target_midi", "target_hz", "mean_cent", "median_cent", "sd_cent", "valid_sec", "coverage", "engine_version", "stats_version"])
        for d in details:
            versions = d.get("versions") or {}
            for ev in d["events"]:
                stats = ev.get("stats") or {}
                target = ev.get("target") or {}
                writer.writerow([_csv_cell(v) for v in [
                    d["sessionId"], d["startedAt"], d["kind"], d["conditionKey"], ev["eventId"], ev["startMs"], ev["endMs"],
                    target.get("midi"), target.get("targetHz"), stats.get("meanCents"), stats.get("medianCents"), stats.get("sdCents"),
                    stats.get("validSeconds"), stats.get("coverage"), versions.get("engineVersion"), versions.get("statsVersion"),
                ]])
        return buffer.getvalue()
    return {"schemaVersion": SCHEMA_VERSION, "revision": 1, "data": {"sessions": details, "nextCursor": next_cursor, "units": {"frequency": "Hz", "deviation": "cent", "level": "dBFS", "time": "ms"}}}


# ----- member lifecycle hook -------------------------------------------------------------------------

def revoke_member(member_id: int) -> None:
    """Called when a member is deleted (the DB trigger does the same)."""
    if not db_data_enabled():
        return
    try:
        _repository().revoke_member(get_current_tenant_id(), int(member_id), "member-deleted")
    except Exception as exc:  # noqa: BLE001 - must never block member deletion
        logger.warning("tuner owner revoke skipped: %s", type(exc).__name__)
