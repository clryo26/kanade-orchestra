"""Operation and asset records for file-bearing portal changes (JST spec R05-A/B, R06/R06-A).

PostgreSQL (production): every call takes the cursor of an open row-level
transaction (``db_item_repository.ItemContext``) so the business row change,
the confirmed asset reference and the operation result commit together.

SQLite: explicit local JSON development mode only (same rule as the promotion
repository). Business rows live in JSON files there, so atomicity with the
JSON write is not guaranteed; production never uses this adapter.

All times come from the DB clock (``clock_timestamp()``), never the app clock.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import closing, contextmanager
from datetime import datetime, timedelta
from typing import Any, Iterator
from uuid import uuid4

from ..core.db_runtime import local_json_fallback_enabled
from ..core.tenant_context import get_current_tenant_id
from ..utils.datetime_utils import parse_instant, utc_now

OPERATION_LEASE = timedelta(minutes=10)
RESULT_RETENTION = timedelta(days=30)
# Refreshed for every reader, independently of retirement. This exceeds the
# storage read's 120s retry budget plus a final 60s request timeout.
READ_PROTECTION = timedelta(minutes=15)


class LostAttempt(Exception):
    """This attempt no longer owns the operation (lease expired or taken over)."""


class _LocalCursor:
    """psycopg-like cursor over SQLite for the local development mode."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self._cursor: sqlite3.Cursor | None = None

    def execute(self, query: str, params: tuple[Any, ...] = ()) -> "_LocalCursor":
        query = query.replace(" FOR UPDATE", "").replace("%s", "?").replace("::jsonb", "")
        converted = tuple(value.isoformat() if isinstance(value, datetime) else value for value in params)
        self._cursor = self.conn.execute(query, converted)
        return self

    def fetchone(self) -> Any:
        assert self._cursor is not None
        return self._cursor.fetchone()

    def fetchall(self) -> list[Any]:
        assert self._cursor is not None
        return self._cursor.fetchall()

    @property
    def description(self) -> Any:
        assert self._cursor is not None
        return self._cursor.description

    @property
    def rowcount(self) -> int:
        assert self._cursor is not None
        return self._cursor.rowcount


_LOCAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS portal_file_operations (
  organization_id TEXT, actor_key TEXT, operation_id TEXT, kind TEXT, method TEXT, target_id INTEGER,
  view_scope TEXT, request_hash TEXT, hash_version INTEGER, state TEXT, attempt_id TEXT, lease_until TEXT,
  result_status INTEGER, result_body TEXT, result_expires_at TEXT, created_at TEXT, updated_at TEXT,
  PRIMARY KEY (organization_id, actor_key, operation_id));
CREATE TABLE IF NOT EXISTS portal_file_assets (
  asset_id TEXT PRIMARY KEY, organization_id TEXT, kind TEXT, owner_id INTEGER, actor_key TEXT,
  operation_id TEXT, attempt_id TEXT, object_name TEXT UNIQUE, source TEXT, filename TEXT,
  content_type TEXT, byte_size INTEGER, sha256 TEXT, storage_generation INTEGER, state TEXT,
  legacy INTEGER DEFAULT 0, legacy_evidence TEXT, created_at TEXT, activated_at TEXT, retired_at TEXT,
  deleted_at TEXT, last_checked_at TEXT, next_attempt_at TEXT, read_protected_until TEXT, retry_count INTEGER DEFAULT 0,
  last_error_code TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_file_assets_active_owner
  ON portal_file_assets (organization_id, kind, owner_id) WHERE state = 'active';
"""


def uses_local_store() -> bool:
    return local_json_fallback_enabled()


@contextmanager
def local_transaction() -> Iterator[_LocalCursor]:
    from ..core.compat_gateway import get_runtime_data_paths

    path = get_runtime_data_paths()[0] / "portal-files-local.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    # sqlite3.Connection's context commits/rolls back but does not close it.
    # Reads now record protection too, so release the file handle per call.
    with closing(sqlite3.connect(path, timeout=10)) as conn, conn:
        conn.create_function("clock_timestamp", 0, lambda: utc_now().isoformat())
        conn.executescript(_LOCAL_SCHEMA)
        # Existing explicit local development databases predate read protection.
        if "read_protected_until" not in {row[1] for row in conn.execute("PRAGMA table_info(portal_file_assets)")}:
            conn.execute("ALTER TABLE portal_file_assets ADD COLUMN read_protected_until TEXT")
        conn.execute("BEGIN IMMEDIATE")
        yield _LocalCursor(conn)


def _rows(cur: Any) -> list[dict[str, Any]]:
    columns = [desc[0] for desc in cur.description]
    return [_decode(dict(zip(columns, row))) for row in cur.fetchall()]


def _row(cur: Any) -> dict[str, Any] | None:
    row = cur.fetchone()
    if row is None:
        return None
    columns = [desc[0] for desc in cur.description]
    return _decode(dict(zip(columns, row)))


def _decode(row: dict[str, Any]) -> dict[str, Any]:
    body = row.get("result_body")
    if isinstance(body, str):
        row["result_body"] = json.loads(body)
    evidence = row.get("legacy_evidence")
    if isinstance(evidence, str):
        row["legacy_evidence"] = json.loads(evidence)
    for key in ("operation_id", "attempt_id", "asset_id"):
        if row.get(key) is not None:
            row[key] = str(row[key])
    return row


def as_instant(value: Any) -> datetime:
    return parse_instant(value) if not isinstance(value, datetime) else value


def db_now(cur: Any) -> datetime:
    cur.execute("SELECT clock_timestamp() AS now")
    value = cur.fetchone()[0]
    if isinstance(value, datetime):
        return value
    parsed = datetime.fromisoformat(str(value))
    return parsed


# --------------------------------------------------------------------------- operations


def operation(cur: Any, actor_key: str, operation_id: str, *, lock: bool = True) -> dict[str, Any] | None:
    cur.execute(
        "SELECT * FROM portal_file_operations WHERE organization_id=%s AND actor_key=%s AND operation_id=%s"
        + (" FOR UPDATE" if lock else ""),
        (get_current_tenant_id(), actor_key, operation_id),
    )
    return _row(cur)


def reserve(
    cur: Any,
    *,
    actor_key: str,
    operation_id: str,
    kind: str,
    method: str,
    target_id: Any,
    view_scope: str,
    digest: str,
) -> tuple[dict[str, Any], bool, bool]:
    """Insert or match the operation; return ``(op, claimed, conflict)``.

    A processing operation whose lease expired is taken over by a new
    attempt through a compare-and-update, so the old attempt is fenced.
    """
    now = db_now(cur)
    attempt = str(uuid4())
    cur.execute(
        "INSERT INTO portal_file_operations (organization_id,actor_key,operation_id,kind,method,target_id,view_scope,"
        "request_hash,hash_version,state,attempt_id,lease_until,created_at,updated_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,1,'processing',%s,%s,%s,%s) "
        "ON CONFLICT (organization_id,actor_key,operation_id) DO NOTHING",
        (get_current_tenant_id(), actor_key, operation_id, kind, method, target_id, view_scope, digest,
         attempt, now + OPERATION_LEASE, now, now),
    )
    op = operation(cur, actor_key, operation_id)
    assert op is not None
    if op["request_hash"] != digest or op["kind"] != kind or op["method"] != method:
        return op, False, True
    if str(op["attempt_id"]) == attempt:
        return op, True, False
    if op["state"] == "processing" and as_instant(op["lease_until"]) <= now:
        new_attempt = str(uuid4())
        cur.execute(
            "UPDATE portal_file_operations SET attempt_id=%s,lease_until=%s,updated_at=clock_timestamp() "
            "WHERE organization_id=%s AND actor_key=%s AND operation_id=%s AND state='processing' AND attempt_id=%s",
            (new_attempt, now + OPERATION_LEASE, get_current_tenant_id(), actor_key, operation_id, op["attempt_id"]),
        )
        if cur.rowcount == 1:
            claimed = operation(cur, actor_key, operation_id)
            assert claimed is not None
            return claimed, True, False
    return op, False, False


def require_attempt(cur: Any, op: dict[str, Any]) -> None:
    current = operation(cur, op["actor_key"], op["operation_id"])
    if (
        not current
        or current["state"] != "processing"
        or str(current["attempt_id"]) != str(op["attempt_id"])
        or as_instant(current["lease_until"]) <= db_now(cur)
    ):
        raise LostAttempt()


def finish(cur: Any, op: dict[str, Any], status: int, body: dict[str, Any]) -> None:
    # Every terminal write is fenced by the current attempt and a live lease.
    now = db_now(cur)
    cur.execute(
        "UPDATE portal_file_operations SET state=%s,result_status=%s,result_body=%s::jsonb,result_expires_at=%s,"
        "updated_at=clock_timestamp() WHERE organization_id=%s AND actor_key=%s AND operation_id=%s "
        "AND state='processing' AND attempt_id=%s AND lease_until>%s",
        ("succeeded" if status < 400 else "rejected", status, json.dumps(body, ensure_ascii=False, allow_nan=False),
         now + RESULT_RETENTION, get_current_tenant_id(), op["actor_key"], op["operation_id"], op["attempt_id"], now),
    )
    if cur.rowcount != 1:
        raise LostAttempt()


def release(cur: Any, op: dict[str, Any]) -> None:
    """Give the lease back after a transient failure so the same key can resume at once."""
    cur.execute(
        "UPDATE portal_file_operations SET lease_until=clock_timestamp(),updated_at=clock_timestamp() "
        "WHERE organization_id=%s AND actor_key=%s AND operation_id=%s AND state='processing' AND attempt_id=%s",
        (get_current_tenant_id(), op["actor_key"], op["operation_id"], op["attempt_id"]),
    )


# --------------------------------------------------------------------------- assets


def stage_asset(
    cur: Any,
    op: dict[str, Any],
    *,
    kind: str,
    owner_id: Any,
    object_name: str,
    asset_id: str,
    source: str,
    filename: str,
    content_type: str,
    byte_size: int,
    sha256: str,
) -> None:
    cur.execute(
        "INSERT INTO portal_file_assets (asset_id,organization_id,kind,owner_id,actor_key,operation_id,attempt_id,"
        "object_name,source,filename,content_type,byte_size,sha256,state,created_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'staged',clock_timestamp())",
        (asset_id, get_current_tenant_id(), kind, owner_id, op["actor_key"], op["operation_id"], op["attempt_id"],
         object_name, source, filename, content_type, byte_size, sha256),
    )


def asset(cur: Any, asset_id: str, *, lock: bool = False) -> dict[str, Any] | None:
    cur.execute(
        "SELECT * FROM portal_file_assets WHERE organization_id=%s AND asset_id=%s" + (" FOR UPDATE" if lock else ""),
        (get_current_tenant_id(), asset_id),
    )
    return _row(cur)


def active_asset(cur: Any, kind: str, owner_id: Any, *, lock: bool = False) -> dict[str, Any] | None:
    cur.execute(
        "SELECT * FROM portal_file_assets WHERE organization_id=%s AND kind=%s AND owner_id=%s AND state='active'"
        + (" FOR UPDATE" if lock else ""),
        (get_current_tenant_id(), kind, owner_id),
    )
    return _row(cur)


def protect_asset_read(cur: Any, asset_id: str) -> None:
    """Extend protection while holding the same asset row lock as cleanup.

    Do not clear it when a reader finishes: another concurrent reader may
    still need it. A failed/crashed reader leaves only a finite grace period.
    """
    until = db_now(cur) + READ_PROTECTION
    cur.execute(
        "UPDATE portal_file_assets SET read_protected_until=CASE "
        "WHEN read_protected_until>%s THEN read_protected_until ELSE %s END "
        "WHERE organization_id=%s AND asset_id=%s AND state IN ('active','retired')",
        (until, until, get_current_tenant_id(), asset_id),
    )


def activate(cur: Any, op: dict[str, Any], asset_id: str, *, owner_id: Any, generation: Any) -> None:
    cur.execute(
        "UPDATE portal_file_assets SET state='active',owner_id=%s,storage_generation=%s,activated_at=clock_timestamp() "
        "WHERE organization_id=%s AND asset_id=%s AND state='staged' AND attempt_id=%s",
        (owner_id, generation, get_current_tenant_id(), asset_id, op["attempt_id"]),
    )
    if cur.rowcount != 1:
        raise LostAttempt()


def retire(cur: Any, asset_id: str) -> None:
    cur.execute(
        "UPDATE portal_file_assets SET state='retired',retired_at=clock_timestamp(),next_attempt_at=clock_timestamp() "
        "WHERE organization_id=%s AND asset_id=%s AND state='active'",
        (get_current_tenant_id(), asset_id),
    )


def abandon(cur: Any, op: dict[str, Any], asset_id: str, generation: Any = None) -> None:
    """An attempt may give up only its own non-active asset (never another attempt's)."""
    current = asset(cur, asset_id, lock=True)
    if not current or str(current["attempt_id"]) != str(op["attempt_id"]) or current["state"] != "staged":
        return
    cur.execute(
        "UPDATE portal_file_assets SET state='delete_pending',storage_generation=COALESCE(%s,storage_generation),"
        "next_attempt_at=clock_timestamp() WHERE organization_id=%s AND asset_id=%s AND state='staged'",
        (generation, get_current_tenant_id(), asset_id),
    )


def reconcile_candidates(cur: Any, now: datetime, limit: int) -> list[dict[str, Any]]:
    cur.execute(
        "SELECT * FROM portal_file_assets WHERE organization_id=%s AND state<>'active' "
        "AND (next_attempt_at IS NULL OR next_attempt_at<=%s) "
        "ORDER BY COALESCE(last_checked_at, created_at), asset_id LIMIT %s",
        (get_current_tenant_id(), now, limit),
    )
    return _rows(cur)


def expire_results(cur: Any, now: datetime) -> int:
    """Drop result bodies past retention; keep the minimal record (ID/hash/state)."""
    cur.execute(
        "UPDATE portal_file_operations SET result_body=NULL,updated_at=clock_timestamp() "
        "WHERE organization_id=%s AND state<>'processing' AND result_body IS NOT NULL AND result_expires_at<=%s",
        (get_current_tenant_id(), now),
    )
    return int(cur.rowcount or 0)
