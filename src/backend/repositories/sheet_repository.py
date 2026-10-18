"""Row-level sheet library storage (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md).

Production uses PostgreSQL only (DB Only). SQLite is an explicit local
development adapter with the same transaction model; no DB error ever falls
back to JSON or a process cache. Every committed change of sheet_library raises
the organization's list_version in the same transaction, so readers on any
server compare one number from the same DB instead of trusting a local cache.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, cast
from uuid import uuid4

from psycopg.rows import dict_row

from ..core.db_config import db_connection_string
from ..core.db_pool import pooled_psycopg as psycopg
from ..core.db_runtime import local_json_fallback_enabled
from ..core.tenant_context import get_current_tenant_id
from .promotion_repository import LocalCursor

OPERATION_LEASE = timedelta(minutes=10)

LIST_COLUMNS = (
    "id", "performance_id", "performance_title", "piece", "part", "source", "name", "path",
    "object_name", "size_bytes", "mime_type", "created_at", "updated_at", "revision",
    "file_id", "storage_generation", "sha256",
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def as_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _local_schema(conn) -> None:
    # Mirrors db/migrations/020 for local development and tests without a
    # PostgreSQL server. Concurrency guarantees are checked against PostgreSQL.
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS sheet_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL DEFAULT 'default',
      performance_id INTEGER, performance_title TEXT DEFAULT '', piece TEXT DEFAULT '', part TEXT DEFAULT '',
      source TEXT DEFAULT '', name TEXT DEFAULT '', path TEXT DEFAULT '', object_name TEXT DEFAULT '',
      url TEXT DEFAULT '', view_url TEXT DEFAULT '', download_url TEXT DEFAULT '', size_bytes INTEGER,
      mime_type TEXT DEFAULT '', created_at TEXT, updated_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
      file_id TEXT UNIQUE, storage_generation INTEGER, sha256 TEXT);
    CREATE TABLE IF NOT EXISTS sheet_library_state (
      organization_id TEXT PRIMARY KEY, list_version INTEGER NOT NULL, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS sheet_operations (
      organization_id TEXT, actor_key TEXT, operation_id TEXT, kind TEXT, request_hash TEXT, state TEXT,
      attempt_id TEXT, lease_until TEXT, result_status INTEGER, result_body TEXT, created_at TEXT, updated_at TEXT,
      PRIMARY KEY(organization_id, actor_key, operation_id));
    CREATE TABLE IF NOT EXISTS sheet_files (
      file_id TEXT PRIMARY KEY, organization_id TEXT, sheet_id INTEGER, actor_key TEXT, operation_id TEXT,
      attempt_id TEXT, source TEXT, object_name TEXT, byte_size INTEGER, sha256 TEXT, storage_generation INTEGER,
      legacy INTEGER NOT NULL DEFAULT 0, state TEXT, created_at TEXT, retired_at TEXT, deleted_at TEXT,
      next_attempt_at TEXT, last_checked_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT);
    CREATE TABLE IF NOT EXISTS sheet_file_leases (
      lease_id TEXT PRIMARY KEY, organization_id TEXT, file_id TEXT, holder TEXT, expires_at TEXT, created_at TEXT,
      UNIQUE(file_id, holder));
    CREATE TABLE IF NOT EXISTS sheet_zip_jobs (
      job_id TEXT PRIMARY KEY, organization_id TEXT, actor_key TEXT, performance_id TEXT, piece TEXT, part TEXT,
      title TEXT, list_version INTEGER, allow_partial INTEGER, manifest TEXT, missing TEXT DEFAULT '[]',
      file_count INTEGER, total_bytes INTEGER, done_count INTEGER DEFAULT 0, written_bytes INTEGER DEFAULT 0,
      parts TEXT DEFAULT '[]', entries TEXT DEFAULT '[]', progress TEXT DEFAULT '{}', state TEXT, attempt_id TEXT, lease_until TEXT,
      object_name TEXT, zip_bytes INTEGER, zip_sha256 TEXT, error_code TEXT, created_at TEXT, updated_at TEXT,
      ready_at TEXT, expires_at TEXT, cleaned_at TEXT);
    CREATE TABLE IF NOT EXISTS sheet_download_tickets (
      ticket_hash TEXT PRIMARY KEY, organization_id TEXT, device_id TEXT, target_kind TEXT, target_id TEXT,
      created_at TEXT, expires_at TEXT);
    """)
    # Local databases created before chunk checkpoints must also upgrade;
    # CREATE TABLE IF NOT EXISTS does not add columns to an existing table.
    if "progress" not in {r[1] for r in conn.execute("PRAGMA table_info(sheet_zip_jobs)")}:
        conn.execute("ALTER TABLE sheet_zip_jobs ADD COLUMN progress TEXT NOT NULL DEFAULT '{}'")


def _seed_local_once(conn) -> None:
    # Local development only: the first use imports the existing local JSON
    # list once (kept IDs). Afterwards the JSON file is never read or written.
    if conn.execute("SELECT 1 FROM sheet_library_state LIMIT 1").fetchone():
        return
    from ..core.compat_gateway import get_runtime_data_paths
    path = get_runtime_data_paths()[0] / "sheet_library.json"
    items: list[dict[str, Any]] = []
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            items = loaded if isinstance(loaded, list) else []
        except (OSError, ValueError):
            items = []
    tenant = "default"
    for item in items:
        file_id = str(uuid4())
        source = "google_cloud_storage" if item.get("source") == "google_cloud_storage" else "local"
        conn.execute(
            "INSERT INTO sheet_library (id,organization_id,performance_id,performance_title,piece,part,source,name,path,"
            "object_name,size_bytes,mime_type,created_at,updated_at,revision,file_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
            (item.get("id"), tenant, item.get("performance_id") or None, item.get("performance_title", ""),
             item.get("piece", ""), item.get("part", ""), source, item.get("name", ""), item.get("path", ""),
             item.get("object_name", ""), item.get("size") or item.get("size_bytes"), item.get("mime_type", ""),
             item.get("created_at") or item.get("modified_at"), item.get("updated_at"), file_id))
        name = item.get("object_name") if source == "google_cloud_storage" else item.get("path")
        if name:
            conn.execute("INSERT INTO sheet_files (file_id,organization_id,sheet_id,source,object_name,legacy,state,created_at) "
                         "VALUES (?,?,?,?,?,1,'active',?)", (file_id, tenant, item.get("id"), source, name, utc_now().isoformat()))
    conn.execute("INSERT INTO sheet_library_state (organization_id,list_version,updated_at) VALUES (?,1,?)",
                 (tenant, utc_now().isoformat()))


@contextmanager
def transaction(read_only_snapshot: bool = False):
    if local_json_fallback_enabled():
        from ..core.compat_gateway import get_runtime_data_paths
        path = get_runtime_data_paths()[0] / "sheets-local.sqlite3"
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path, timeout=10) as conn:
            conn.row_factory = sqlite3.Row
            conn.create_function("clock_timestamp", 0, lambda: utc_now().isoformat())
            _local_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            _seed_local_once(conn)
            yield LocalCursor(conn)
        return
    with psycopg.connect(db_connection_string(), autocommit=False, connect_timeout=10) as conn:
        if read_only_snapshot:
            # The list and its version must come from one snapshot.
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        with conn.cursor(row_factory=dict_row) as cur:
            yield cur


def tenant() -> str:
    return get_current_tenant_id()


def db_now(cur) -> datetime:
    cur.execute("SELECT clock_timestamp() AS now")
    return as_datetime(cur.fetchone()["now"])


def list_version(cur) -> int:
    cur.execute("SELECT list_version FROM sheet_library_state WHERE organization_id=%s", (tenant(),))
    found = cur.fetchone()
    return int(found["list_version"]) if found else 0


def bump_version(cur) -> int:
    # Serializes writers of one organization; readers see old or new, never half.
    cur.execute("INSERT INTO sheet_library_state (organization_id,list_version,updated_at) "
                "VALUES (%s,1,clock_timestamp()) ON CONFLICT (organization_id) DO UPDATE SET "
                "list_version=sheet_library_state.list_version+1,updated_at=clock_timestamp() RETURNING list_version",
                (tenant(),))
    return int(cur.fetchone()["list_version"])


def list_rows(cur) -> list[dict[str, Any]]:
    cur.execute("SELECT " + ",".join(LIST_COLUMNS) + " FROM sheet_library WHERE organization_id=%s "
                "ORDER BY created_at DESC, id DESC", (tenant(),))
    return cast(list[dict[str, Any]], cur.fetchall())


def snapshot() -> tuple[int, list[dict[str, Any]]]:
    with transaction(read_only_snapshot=True) as cur:
        return list_version(cur), list_rows(cur)


def current_version() -> int:
    with transaction(read_only_snapshot=True) as cur:
        return list_version(cur)


def row(cur, sheet_id: int, lock: bool = False) -> dict[str, Any] | None:
    cur.execute("SELECT * FROM sheet_library WHERE organization_id=%s AND id=%s" + (" FOR UPDATE" if lock else ""),
                (tenant(), sheet_id))
    return cast(dict[str, Any] | None, cur.fetchone())


def rows_locked(cur, sheet_ids: list[int]) -> dict[int, dict[str, Any]]:
    found: dict[int, dict[str, Any]] = {}
    # Ascending order keeps concurrent bulk operations from deadlocking.
    for sheet_id in sorted(set(sheet_ids)):
        item = row(cur, sheet_id, lock=True)
        if item:
            found[sheet_id] = item
    return found


# ----- operations -------------------------------------------------------------------


def operation(cur, actor: str, operation_id: str, lock: bool = True) -> dict[str, Any] | None:
    cur.execute("SELECT * FROM sheet_operations WHERE organization_id=%s AND actor_key=%s AND operation_id=%s" +
                (" FOR UPDATE" if lock else ""), (tenant(), actor, operation_id))
    result = cur.fetchone()
    if result and isinstance(result.get("result_body"), str):
        result["result_body"] = json.loads(result["result_body"])
    return cast(dict[str, Any] | None, result)


def reserve(actor: str, operation_id: str, kind: str, digest: str) -> tuple[dict[str, Any], bool, bool]:
    """Returns (operation, claimed, conflict). A processing operation whose
    lease expired is taken over by a new attempt (the old one is fenced)."""
    with transaction() as cur:
        now = db_now(cur)
        attempt = str(uuid4())
        cur.execute("INSERT INTO sheet_operations (organization_id,actor_key,operation_id,kind,request_hash,state,"
                    "attempt_id,lease_until,created_at,updated_at) VALUES (%s,%s,%s,%s,%s,'processing',%s,%s,%s,%s) "
                    "ON CONFLICT (organization_id,actor_key,operation_id) DO NOTHING",
                    (tenant(), actor, operation_id, kind, digest, attempt, now + OPERATION_LEASE, now, now))
        op = operation(cur, actor, operation_id)
        assert op is not None
        if op["request_hash"] != digest or op["kind"] != kind:
            return op, False, True
        if str(op["attempt_id"]) == attempt:
            return op, True, False
        if op["state"] == "processing" and as_datetime(op["lease_until"]) <= now:
            cur.execute("UPDATE sheet_operations SET attempt_id=%s,lease_until=%s,updated_at=clock_timestamp() "
                        "WHERE organization_id=%s AND actor_key=%s AND operation_id=%s AND state='processing' "
                        "AND attempt_id=%s RETURNING *",
                        (attempt, now + OPERATION_LEASE, tenant(), actor, operation_id, op["attempt_id"]))
            claimed = cur.fetchone()
            if claimed:
                return cast(dict[str, Any], claimed), True, False
        return op, False, False


class LostAttempt(Exception):
    """This attempt no longer owns the operation (lease expired / finished)."""


def require_attempt(cur, op: dict[str, Any]) -> None:
    current = operation(cur, op["actor_key"], str(op["operation_id"]))
    if (not current or current["state"] != "processing" or str(current["attempt_id"]) != str(op["attempt_id"])
            or as_datetime(current["lease_until"]) <= db_now(cur)):
        raise LostAttempt()


def finish(cur, op: dict[str, Any], status: int, body: dict[str, Any]) -> None:
    cur.execute("UPDATE sheet_operations SET state=%s,result_status=%s,result_body=%s::jsonb,updated_at=clock_timestamp() "
                "WHERE organization_id=%s AND actor_key=%s AND operation_id=%s AND state='processing' AND attempt_id=%s "
                "RETURNING operation_id",
                ("succeeded" if status < 400 else "rejected", status, json.dumps(body, ensure_ascii=False, default=iso),
                 tenant(), op["actor_key"], str(op["operation_id"]), str(op["attempt_id"])))
    if not cur.fetchone():
        raise LostAttempt()


def release(op: dict[str, Any]) -> None:
    # Gives an unfinished attempt back so the same key can be retried at once.
    with transaction() as cur:
        cur.execute("UPDATE sheet_operations SET lease_until=clock_timestamp(),updated_at=clock_timestamp() "
                    "WHERE organization_id=%s AND actor_key=%s AND operation_id=%s AND state='processing' AND attempt_id=%s",
                    (tenant(), op["actor_key"], str(op["operation_id"]), str(op["attempt_id"])))


# ----- files ------------------------------------------------------------------------


def file_record(cur, file_id: str, lock: bool = False) -> dict[str, Any] | None:
    cur.execute("SELECT * FROM sheet_files WHERE organization_id=%s AND file_id=%s" + (" FOR UPDATE" if lock else ""),
                (tenant(), file_id))
    return cast(dict[str, Any] | None, cur.fetchone())


def retire_file(cur, file_id: Any) -> None:
    if not file_id:
        return
    cur.execute("UPDATE sheet_files SET state='retired',retired_at=clock_timestamp(),next_attempt_at=clock_timestamp() "
                "WHERE organization_id=%s AND file_id=%s AND state IN ('active','staged')", (tenant(), str(file_id)))


def object_referenced(cur, source: str, object_name: str) -> bool:
    if source == "google_cloud_storage":
        cur.execute("SELECT 1 AS used FROM sheet_library WHERE source='google_cloud_storage' AND object_name=%s LIMIT 1",
                    (object_name,))
    else:
        cur.execute("SELECT 1 AS used FROM sheet_library WHERE source<>'google_cloud_storage' AND path=%s LIMIT 1",
                    (object_name,))
    return cur.fetchone() is not None


def live_lease(cur, file_id: str) -> bool:
    cur.execute("SELECT 1 AS live FROM sheet_file_leases WHERE file_id=%s AND expires_at>clock_timestamp() LIMIT 1",
                (str(file_id),))
    return cur.fetchone() is not None


def seed_local(items: list[dict[str, Any]]) -> None:
    """Explicit local fixtures/imports only; production whole-list saves are forbidden."""
    if not local_json_fallback_enabled():
        raise RuntimeError("Sheet whole-list writes are disabled")
    with transaction() as cur:
        org = tenant()
        for table in ("sheet_library", "sheet_files", "sheet_file_leases", "sheet_operations", "sheet_zip_jobs"):
            cur.execute(f"DELETE FROM {table} WHERE organization_id=%s", (org,))
        for item in items:
            file_id = str(item.get("file_id") or uuid4())
            source = "google_cloud_storage" if item.get("source") == "google_cloud_storage" else "local"
            cur.execute("INSERT INTO sheet_library (id,organization_id,performance_id,performance_title,piece,part,source,name,path,"
                        "object_name,size_bytes,mime_type,created_at,updated_at,revision,file_id) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (item.get("id"), org, item.get("performance_id") or None, item.get("performance_title", ""),
                         item.get("piece", ""), item.get("part", ""), source, item.get("name", ""), item.get("path", ""),
                         item.get("object_name", ""), item.get("size") or item.get("size_bytes"), item.get("mime_type", ""),
                         item.get("created_at") or utc_now().isoformat(), item.get("updated_at"), int(item.get("revision") or 1),
                         file_id))
            name = item.get("object_name") if source == "google_cloud_storage" else item.get("path")
            if name:
                cur.execute("INSERT INTO sheet_files (file_id,organization_id,sheet_id,source,object_name,legacy,state,created_at) "
                            "VALUES (%s,%s,%s,%s,%s,TRUE,'active',clock_timestamp())",
                            (file_id, org, item.get("id"), source, name))
        bump_version(cur)


def ensure_file(cur, item: dict[str, Any]) -> str | None:
    """The file identity of a sheet row, created when it is missing.

    Rows can lack it after a production->test DB sync (sheet_files is not
    synced) or when an older app version wrote a row after a rollback. The
    record is legacy (generation unknown, the object may be shared), so the
    cleanup checks references before deleting anything.
    """
    source = "google_cloud_storage" if item.get("source") == "google_cloud_storage" else "local"
    name = str(item.get("object_name") if source == "google_cloud_storage" else item.get("path") or "")
    file_id = str(item["file_id"]) if item.get("file_id") else None
    if not file_id:
        file_id = str(uuid4())
        cur.execute("UPDATE sheet_library SET file_id=%s WHERE organization_id=%s AND id=%s AND file_id IS NULL",
                    (file_id, tenant(), item["id"]))
        item["file_id"] = file_id
    if not name:
        return file_id
    cur.execute("INSERT INTO sheet_files (file_id,organization_id,sheet_id,source,object_name,byte_size,legacy,state,created_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,TRUE,'active',clock_timestamp()) ON CONFLICT (file_id) DO NOTHING",
                (file_id, tenant(), item["id"], source, name, item.get("size_bytes")))
    return file_id
