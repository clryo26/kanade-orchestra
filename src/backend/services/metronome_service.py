"""Metronome practice history: owner resolution, validation, limits.

Identity (docs/METRONOME_DATA_API_DESIGN.md 7 / 8): the owner is never chosen
by the client. It is resolved on every request from the signed-in device ->
its member -> the member row's immutable creation time (member_birth), using
the shared ``tuner_owners`` identity (created here when the member never
used the tuner). A device that authenticated before the current member row
was created (a reused numeric id) must sign in again. The hidden system
administrator has no member and therefore no account storage (device only).

Only summaries are accepted: at most 256 groups per session in one part,
event_count = 0. Individual observations, onset times, calibration values,
audio / PCM / spectra and device ids are refused as unknown fields.
The DB is the only data source (no JSON file fallback).
"""
from __future__ import annotations

import json
import logging
import math
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, ParamSpec, TypeVar

from fastapi import HTTPException

from ..core import db_connection_string
from ..core.tenant_context import get_current_tenant_id
from ..db.database import db_data_enabled
from ..repositories.metronome_repository import (
    Conflict,
    ConsentMismatch,
    HistoryEpochMismatch,
    MemberRecreated,
    MetronomeRepository,
    NotFound,
    OwnerInitRetry,
    OwnerRevoked,
    Tombstoned,
)

logger = logging.getLogger(__name__)

_P = ParamSpec("_P")
_R = TypeVar("_R")

SCHEMA_VERSION = 1
# limits-v0 (tuning values, docs/METRONOME_DESIGN.md 15); the same numbers as
# the CHECK constraints of migration 019 and the client.
LIMITS = {
    "session_ms": 1_800_000,
    "targets": 28_800,
    "local_details": 36_000,
    "extra_details": 7_200,
    "groups": 256,
    "groups_bytes": 128 * 1024,
    "score_summary_bytes": 64 * 1024,
    "summary_bytes": 32 * 1024,
    "versions_bytes": 4 * 1024,
    "group_bytes": 512,
    "body_bytes": 256 * 1024,
    "sessions": 5000,
    "presets": 60,
    "preset_bytes": 256 * 1024,
    "list_limit": 100,
    "string_chars": 200,
    "depth": 8,
}

SESSION_FIELDS = {"schemaVersion", "historyEpoch", "consentRevision", "sessionId", "attemptId", "programId", "startedAt", "durationMs", "versions", "scoreSummary", "counts", "conditionKey", "contentHash"}
COUNT_FIELDS = {"target", "valid", "localDetail", "extraDetail", "extraTotal", "groups"}
PART_FIELDS = {"schemaVersion", "historyEpoch", "consentRevision", "payloadHash", "groups"}
GROUP_FIELDS = {"ordinal", "conditionKey", "layerKey", "beatPositionKey", "targetCount", "validCount", "missingCount", "extraTotal", "excludedByReason", "stats", "quality"}
STATS_FIELDS = {"medianMs", "madMs", "sdMs", "ioiRatioStats", "verdict"}
QUALITY_FIELDS = {"calibrated", "confidenceClass", "extraDetailsTruncated"}
FINALIZE_FIELDS = {"schemaVersion", "historyEpoch", "consentRevision", "partHashes", "eventCount", "groupCount", "summary", "status"}
DELETE_FIELDS = {"schemaVersion", "operationId", "historyEpoch"}
PREFERENCE_FIELDS = {"schemaVersion", "expectedRevision", "accountConsent", "consentVersion"}
PRESET_FIELDS = {"schemaVersion", "historyEpoch", "consentRevision", "preset"}
# Never accepted anywhere in a payload (observations, calibration, audio).
FORBIDDEN_KEYS = {"pcm", "audio", "samples", "spectrum", "fft", "onsets", "observations", "calibration", "offsetMs", "deviceId", "rawDeviceId", "e", "ioi", "__proto__", "prototype", "constructor"}


def _repository() -> MetronomeRepository:
    return MetronomeRepository(db_connection_string())


def _error(status: int, code: str, message: str, retryable: bool = False) -> HTTPException:
    # No internal storage names, SQL or other people's existence in errors.
    # Error responses are personal too: never cached (the router dependency
    # only reaches successful responses).
    return HTTPException(status_code=status, detail={"code": code, "message": message, "retryable": retryable}, headers={"Cache-Control": "no-store"})


def _invalid(code: str, path: str) -> HTTPException:
    return _error(422, code, f"{path}: invalid")


# ----- validation -------------------------------------------------------------------

def _size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))


def _check_json(value: Any, path: str, depth: int = 0) -> None:
    if depth > LIMITS["depth"]:
        raise _invalid("INVALID_SCHEMA", path)
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise _invalid("INVALID_SCHEMA", path)
        return
    if isinstance(value, str):
        if len(value) > LIMITS["string_chars"]:
            raise _invalid("INVALID_SCHEMA", path)
        return
    if isinstance(value, list):
        if len(value) > 1000:
            raise _invalid("INVALID_SCHEMA", path)
        for i, item in enumerate(value):
            _check_json(item, f"{path}[{i}]", depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > 64 or key in FORBIDDEN_KEYS:
                raise _invalid("INVALID_SCHEMA", f"{path}.{key}")
            _check_json(item, f"{path}.{key}", depth + 1)
        return
    raise _invalid("INVALID_SCHEMA", path)


def _only(body: Any, allowed: set[str], path: str) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise _invalid("INVALID_SCHEMA", path)
    unknown = [k for k in body if k not in allowed]
    if unknown:
        raise _invalid("INVALID_SCHEMA", f"{path}.{unknown[0]}")
    return body


def _object(value: Any, path: str, max_bytes: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid("INVALID_SCHEMA", path)
    _check_json(value, path)
    if _size(value) > max_bytes:
        raise _error(413, "PAYLOAD_TOO_LARGE", f"{path}: too large")
    return value


def _uuid(value: Any, path: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise _invalid("INVALID_SCHEMA", path) from None


def _int(value: Any, path: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        # Integers only (e.g. bpmTenths): non-integers are refused, never rounded.
        raise _invalid("INVALID_SCHEMA", path)
    if value < lo or value > hi:
        raise _invalid("INVALID_SCHEMA", path)
    return value


def _text(value: Any, path: str, max_chars: int = 200) -> str:
    if not isinstance(value, str) or len(value) > max_chars or any(ord(ch) < 32 for ch in value):
        raise _invalid("INVALID_SCHEMA", path)
    return value


def _schema(body: dict[str, Any]) -> None:
    if body.get("schemaVersion") != SCHEMA_VERSION:
        raise _error(422, "UNSUPPORTED_VERSION", "unsupported schemaVersion")


def _body_size(body: Any) -> None:
    if _size(body) > LIMITS["body_bytes"]:
        raise _error(413, "PAYLOAD_TOO_LARGE", "request too large")


def _time(value: Any, path: str) -> datetime:
    if not isinstance(value, str):
        raise _invalid("INVALID_SCHEMA", path)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise _invalid("INVALID_SCHEMA", path) from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


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


def _group(raw: Any, i: int) -> dict[str, Any]:
    path = f"groups[{i}]"
    g = _only(raw, GROUP_FIELDS, path)
    _check_json(g, path)
    if _size(g) > LIMITS["group_bytes"]:
        raise _error(413, "PAYLOAD_TOO_LARGE", f"{path}: too large")
    stats = _only(g.get("stats") or {}, STATS_FIELDS, f"{path}.stats")
    quality = _only(g.get("quality") or {}, QUALITY_FIELDS, f"{path}.quality")
    target = _int(g.get("targetCount"), f"{path}.targetCount", 0, LIMITS["targets"])
    valid = _int(g.get("validCount"), f"{path}.validCount", 0, target)
    missing = _int(g.get("missingCount", 0), f"{path}.missingCount", 0, target)
    if valid + missing > target:
        raise _invalid("INVALID_SCHEMA", f"{path}.missingCount")
    return {
        "ordinal": _int(g.get("ordinal"), f"{path}.ordinal", 0, LIMITS["groups"] - 1),
        "conditionKey": _text(g.get("conditionKey"), f"{path}.conditionKey"),
        "layerKey": _text(g.get("layerKey"), f"{path}.layerKey", 64),
        "beatPositionKey": _text(g.get("beatPositionKey"), f"{path}.beatPositionKey", 64),
        "targetCount": target,
        "validCount": valid,
        "extraTotal": _int(g.get("extraTotal", 0), f"{path}.extraTotal", 0, 2**31 - 1),
        "stats": stats,
        "quality": quality,
    }


# ----- identity -------------------------------------------------------------------

def resolve_owner(device: dict[str, Any]) -> dict[str, Any]:
    if not db_data_enabled():
        raise _error(503, "DATABASE_UNAVAILABLE", "現在アカウントに保存できません。")
    member_id = device.get("member_id")
    if member_id is None or member_id == "" or bool(device.get("hidden_user")):
        raise _error(409, "ACCOUNT_STORAGE_UNAVAILABLE", "このアカウントでは記録をアカウントに保存できません。端末内の保存を使えます。")
    try:
        member_id = int(member_id)
    except (TypeError, ValueError):
        raise _error(409, "ACCOUNT_STORAGE_UNAVAILABLE", "このアカウントでは記録をアカウントに保存できません。") from None
    organization_id = get_current_tenant_id()
    repo = _repository()
    birth = repo.member_birth(organization_id, member_id)
    if birth is None:
        raise _error(409, "ACCOUNT_STORAGE_UNAVAILABLE", "このアカウントでは記録をアカウントに保存できません。")
    birth = birth if birth.tzinfo else birth.replace(tzinfo=timezone.utc)
    authenticated = _as_utc(device.get("authenticated_at")) or _as_utc(device.get("created_at"))
    if authenticated is None or authenticated < birth:
        # This device signed in for an earlier member with the same id.
        raise _error(409, "MEMBER_RECREATED", "もう一度ログインしてください。")
    owner = repo.resolve_owner(organization_id, member_id, birth)
    owner["repo"] = repo
    return owner


def _guarded(fn: Callable[_P, _R]) -> Callable[_P, _R]:
    """Maps repository conditions to the API's status codes (data design 8)."""

    def wrapper(*args: _P.args, **kwargs: _P.kwargs) -> _R:
        try:
            return fn(*args, **kwargs)
        except OwnerRevoked:
            raise _error(409, "OWNER_REVOKED", "もう一度ログインしてください。") from None
        except MemberRecreated:
            raise _error(409, "MEMBER_RECREATED", "もう一度ログインしてください。") from None
        except OwnerInitRetry:
            raise _error(409, "OWNER_INITIALIZATION_RETRY", "少し待ってからもう一度お試しください。", retryable=True) from None
        except HistoryEpochMismatch:
            raise _error(409, "HISTORY_EPOCH", "履歴の状態が変わりました。本人情報を再確認してください。") from None
        except ConsentMismatch as exc:
            raise _error(409, exc.code, "保存の同意が変わりました。保存方法を確認してください。") from None
        except Tombstoned:
            raise _error(409, "SESSION_CONFLICT", "削除済みの記録です。") from None
        except Conflict as exc:
            raise _error(409, exc.code, "保存済みの内容と一致しません。") from None
        except NotFound:
            raise _error(404, "NOT_FOUND", "見つかりません。") from None
        except OverflowError:
            raise _error(413, "PAYLOAD_TOO_LARGE", "保存できる上限に達しました。不要な記録を削除してください。") from None

    wrapper.__name__ = fn.__name__
    return wrapper


def _public_identity(owner: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "accountStorageAvailable": True,
        "ownerId": owner["ownerId"],
        "organizationScopeToken": owner["organizationScopeToken"],
        "memberBirthToken": owner["memberBirthToken"],
        "active": owner["active"],
        "historyEpoch": owner["historyEpoch"],
        "consentRevision": owner["consentRevision"],
        "accountConsent": owner["accountConsent"],
        "consentVersion": owner["consentVersion"],
    }


@_guarded
def identity(device: dict[str, Any]) -> dict[str, Any]:
    try:
        owner = resolve_owner(device)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        if detail.get("code") == "ACCOUNT_STORAGE_UNAVAILABLE":
            # Device-only history stays available; no owner is revealed.
            return {"schemaVersion": SCHEMA_VERSION, "accountStorageAvailable": False, "ownerId": None, "historyEpoch": None}
        raise
    return _public_identity(owner)


@_guarded
def get_preferences(device: dict[str, Any]) -> dict[str, Any]:
    owner = resolve_owner(device)
    return {"schemaVersion": SCHEMA_VERSION, **owner["repo"].get_preferences(owner["ownerId"])}


@_guarded
def put_preferences(device: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    body = _only(body, PREFERENCE_FIELDS, "$")
    _schema(body)
    owner = resolve_owner(device)
    consent = body.get("accountConsent")
    if not isinstance(consent, bool):
        raise _invalid("INVALID_SCHEMA", "$.accountConsent")
    data = owner["repo"].put_preferences(
        owner["ownerId"],
        _int(body.get("expectedRevision"), "$.expectedRevision", 1, 2**62),
        consent,
        _text(body.get("consentVersion", ""), "$.consentVersion", 40),
    )
    return {"schemaVersion": SCHEMA_VERSION, **data}


# ----- sessions ----------------------------------------------------------------------

def _epochs(body: dict[str, Any]) -> tuple[int, int]:
    return _int(body.get("historyEpoch"), "$.historyEpoch", 1, 2**62), _int(body.get("consentRevision"), "$.consentRevision", 1, 2**62)


@_guarded
def create_session(device: dict[str, Any], body: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    _body_size(body)
    body = _only(body, SESSION_FIELDS, "$")
    _schema(body)
    epoch, consent = _epochs(body)
    counts = _only(body.get("counts"), COUNT_FIELDS, "$.counts")
    target = _int(counts.get("target"), "$.counts.target", 0, LIMITS["targets"])
    extra_detail = _int(counts.get("extraDetail"), "$.counts.extraDetail", 0, LIMITS["extra_details"])
    local_detail = _int(counts.get("localDetail"), "$.counts.localDetail", 0, LIMITS["local_details"])
    extra_total = _int(counts.get("extraTotal"), "$.counts.extraTotal", extra_detail, 2**31 - 1)
    valid = _int(counts.get("valid"), "$.counts.valid", 0, target)
    if local_detail > target + extra_detail:
        # Details are expected beats plus the stored extra attacks (never more).
        raise _invalid("INVALID_SCHEMA", "$.counts.localDetail")
    data = {
        "sessionId": _uuid(body.get("sessionId"), "$.sessionId"),
        "attemptId": _uuid(body.get("attemptId"), "$.attemptId"),
        "programId": _uuid(body["programId"], "$.programId") if body.get("programId") else None,
        "startedAt": _time(body.get("startedAt"), "$.startedAt"),
        "durationMs": _int(body.get("durationMs"), "$.durationMs", 0, LIMITS["session_ms"]),
        "versions": _object(body.get("versions"), "$.versions", LIMITS["versions_bytes"]),
        "scoreSummary": _object(body.get("scoreSummary"), "$.scoreSummary", LIMITS["score_summary_bytes"]),
        "counts": {"target": target, "valid": valid, "localDetail": local_detail, "extraDetail": extra_detail, "extraTotal": extra_total, "groups": _int(counts.get("groups"), "$.counts.groups", 0, LIMITS["groups"])},
        "conditionKey": _text(body.get("conditionKey"), "$.conditionKey"),
        "contentHash": _text(body.get("contentHash"), "$.contentHash", 64),
    }
    owner = resolve_owner(device)
    result, created = owner["repo"].create_session(owner["ownerId"], epoch, consent, data, LIMITS["sessions"])
    return {"schemaVersion": SCHEMA_VERSION, **result}, created


@_guarded
def put_part(device: dict[str, Any], session_id: str, index: int, body: dict[str, Any]) -> dict[str, Any]:
    if index != 0:
        raise _error(422, "INVALID_SCHEMA", "only part 0 exists")
    _body_size(body)
    body = _only(body, PART_FIELDS, "$")
    _schema(body)
    epoch, consent = _epochs(body)
    raw = body.get("groups")
    if not isinstance(raw, list) or len(raw) > LIMITS["groups"]:
        raise _invalid("INVALID_SCHEMA", "$.groups")
    groups = [_group(g, i) for i, g in enumerate(raw)]
    if _size(groups) > LIMITS["groups_bytes"]:
        raise _error(413, "PAYLOAD_TOO_LARGE", "groups too large")
    ordinals = [g["ordinal"] for g in groups]
    keys = {(g["conditionKey"], g["layerKey"], g["beatPositionKey"]) for g in groups}
    if sorted(ordinals) != list(range(len(groups))) or len(keys) != len(groups):
        raise _invalid("INVALID_SCHEMA", "$.groups")
    owner = resolve_owner(device)
    data = owner["repo"].put_part(owner["ownerId"], _uuid(session_id, "sessionId"), epoch, consent, _text(body.get("payloadHash"), "$.payloadHash", 64), groups)
    return {"schemaVersion": SCHEMA_VERSION, **data}


@_guarded
def finalize_session(device: dict[str, Any], session_id: str, body: dict[str, Any]) -> dict[str, Any]:
    _body_size(body)
    body = _only(body, FINALIZE_FIELDS, "$")
    _schema(body)
    epoch, consent = _epochs(body)
    if body.get("eventCount") != 0:
        # Individual observations are never sent to the account.
        raise _invalid("INVALID_SCHEMA", "$.eventCount")
    hashes = body.get("partHashes")
    if not isinstance(hashes, list) or len(hashes) != 1:
        raise _invalid("INVALID_SCHEMA", "$.partHashes")
    status = body.get("status")
    if status not in ("complete", "incomplete"):
        raise _invalid("INVALID_SCHEMA", "$.status")
    summary = _object(body.get("summary") or {}, "$.summary", LIMITS["summary_bytes"])
    owner = resolve_owner(device)
    data = owner["repo"].finalize(
        owner["ownerId"], _uuid(session_id, "sessionId"), epoch, consent, _text(hashes[0], "$.partHashes[0]", 64),
        _int(body.get("groupCount"), "$.groupCount", 0, LIMITS["groups"]), summary, status,
    )
    return {"schemaVersion": SCHEMA_VERSION, **data}


@_guarded
def list_sessions(device: dict[str, Any], query: dict[str, Any]) -> dict[str, Any]:
    limit = query.get("limit") or 20
    if not isinstance(limit, int) or limit < 1 or limit > LIMITS["list_limit"]:
        raise _invalid("INVALID_SCHEMA", "limit")
    start = _time(query["from"], "from") if query.get("from") else None
    end = _time(query["to"], "to") if query.get("to") else None
    condition = _text(query["condition"], "condition") if query.get("condition") else None
    cursor = _text(query["cursor"], "cursor", 400) if query.get("cursor") else None
    owner = resolve_owner(device)
    data = owner["repo"].list_sessions(owner["ownerId"], start, end, condition, cursor, limit)
    return {"schemaVersion": SCHEMA_VERSION, **data}


@_guarded
def get_session(device: dict[str, Any], session_id: str) -> dict[str, Any]:
    owner = resolve_owner(device)
    return {"schemaVersion": SCHEMA_VERSION, **owner["repo"].get_session(owner["ownerId"], _uuid(session_id, "sessionId"))}


def _delete_body(body: dict[str, Any] | None) -> tuple[str, int]:
    body = _only(body or {}, DELETE_FIELDS, "$")
    _schema(body)
    return _uuid(body.get("operationId"), "$.operationId"), _int(body.get("historyEpoch"), "$.historyEpoch", 1, 2**62)


@_guarded
def delete_session(device: dict[str, Any], session_id: str, body: dict[str, Any] | None) -> dict[str, Any]:
    operation_id, epoch = _delete_body(body)
    owner = resolve_owner(device)
    return {"schemaVersion": SCHEMA_VERSION, **owner["repo"].delete_session(owner["ownerId"], _uuid(session_id, "sessionId"), operation_id, epoch)}


@_guarded
def delete_history(device: dict[str, Any], body: dict[str, Any] | None) -> dict[str, Any]:
    operation_id, epoch = _delete_body(body)
    owner = resolve_owner(device)
    return {"schemaVersion": SCHEMA_VERSION, **owner["repo"].delete_history(owner["ownerId"], operation_id, epoch)}


# ----- presets (explicit account save only) -----------------------------------------------

def _preset_envelope(raw: Any) -> dict[str, Any]:
    env = _only(raw, {"schemaVersion", "id", "revision", "kind", "title", "payload"}, "$.preset")
    if env.get("schemaVersion") != SCHEMA_VERSION:
        raise _error(422, "UNSUPPORTED_VERSION", "unsupported preset schemaVersion")
    if env.get("kind") not in ("basic", "advanced", "score"):
        raise _invalid("INVALID_SCHEMA", "$.preset.kind")
    _text(env.get("title", ""), "$.preset.title", 120)
    payload = env.get("payload")
    if not isinstance(payload, dict):
        raise _invalid("INVALID_SCHEMA", "$.preset.payload")
    _check_json(env, "$.preset")
    if _size(env) > LIMITS["preset_bytes"]:
        raise _error(413, "PAYLOAD_TOO_LARGE", "preset too large")
    # Stored tempo values are integer tenths only (never rounded here).
    tempo = payload.get("tempo")
    if tempo is not None:
        if not isinstance(tempo, dict) or set(tempo) - {"bpmTenths", "reference"}:
            raise _error(422, "INVALID_TEMPO_MAP", "$.preset.payload.tempo")
        _int(tempo.get("bpmTenths"), "$.preset.payload.tempo.bpmTenths", 200, 3000)
    for i, curve in enumerate(payload.get("tempoMap") or []):
        if not isinstance(curve, dict) or "durationSeconds" in curve:
            raise _error(422, "INVALID_TEMPO_MAP", f"$.preset.payload.tempoMap[{i}]")
        _int(curve.get("startBpmTenths"), f"$.preset.payload.tempoMap[{i}].startBpmTenths", 200, 3000)
        _int(curve.get("endBpmTenths"), f"$.preset.payload.tempoMap[{i}].endBpmTenths", 200, 3000)
    return env


@_guarded
def list_presets(device: dict[str, Any], limit: int) -> dict[str, Any]:
    if limit < 1 or limit > LIMITS["presets"]:
        raise _invalid("INVALID_SCHEMA", "limit")
    owner = resolve_owner(device)
    return {"schemaVersion": SCHEMA_VERSION, "items": owner["repo"].list_presets(owner["ownerId"], limit)}


@_guarded
def create_preset(device: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    _body_size(body)
    body = _only(body, PRESET_FIELDS, "$")
    _schema(body)
    epoch, consent = _epochs(body)
    env = _preset_envelope(body.get("preset"))
    preset_id = _uuid(env.get("id"), "$.preset.id")
    revision = _int(env.get("revision"), "$.preset.revision", 1, 2**31 - 1)
    owner = resolve_owner(device)
    data = owner["repo"].create_preset(owner["ownerId"], epoch, consent, preset_id, revision, env["kind"], env, LIMITS["presets"])
    return {"schemaVersion": SCHEMA_VERSION, **data}


@_guarded
def delete_preset(device: dict[str, Any], preset_id: str, body: dict[str, Any] | None) -> dict[str, Any]:
    operation_id, epoch = _delete_body(body)
    owner = resolve_owner(device)
    return {"schemaVersion": SCHEMA_VERSION, **owner["repo"].delete_preset(owner["ownerId"], _uuid(preset_id, "presetId"), operation_id, epoch)}
