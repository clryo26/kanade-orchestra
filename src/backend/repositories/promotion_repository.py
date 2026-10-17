"""Row-level promotion storage. SQLite is an explicit local-development adapter only.

No DB error falls back to JSON/local storage. All operation results and published
image references commit together; uploads and physical deletes happen outside it.
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


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


class LocalCursor:
    def __init__(self, conn):
        self.conn = conn
        self.cursor = None

    def execute(self, query, params=()):
        query = query.replace(" FOR UPDATE", "").replace("%s", "?").replace("::jsonb", "")
        self.cursor = self.conn.execute(query, tuple(iso(v) for v in params))
        return self

    def fetchone(self):
        row = self.cursor.fetchone()
        return dict(row) if row is not None else None

    def fetchall(self):
        return [dict(row) for row in self.cursor.fetchall()]

    @property
    def rowcount(self):
        return self.cursor.rowcount


def _local_schema(conn):
    # Keep the production transaction model in local tests without requiring a
    # developer's PostgreSQL or credentials. Real concurrency tests use PG.
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL,
      title TEXT, summary TEXT, image_url TEXT, member_id INTEGER, registered_by TEXT,
      created_at TEXT, updated_at TEXT, revision INTEGER NOT NULL DEFAULT 1, image_asset_id TEXT);
    CREATE TABLE IF NOT EXISTS promotion_operations (
      organization_id TEXT, actor_key TEXT, operation_id TEXT, method TEXT, target_id INTEGER,
      request_hash TEXT, state TEXT, attempt_id TEXT, lease_until TEXT, result_status INTEGER,
      result_body TEXT, error_code TEXT, created_at TEXT, updated_at TEXT,
      PRIMARY KEY(organization_id,actor_key,operation_id));
    CREATE TABLE IF NOT EXISTS promotion_image_assets (
      asset_id TEXT PRIMARY KEY, organization_id TEXT, promotion_id INTEGER,
      operation_id TEXT, actor_key TEXT, attempt_id TEXT, object_name TEXT UNIQUE,
      content_type TEXT, byte_size INTEGER, sha256 TEXT, storage_generation INTEGER,
      state TEXT, created_at TEXT, retired_at TEXT, deleted_at TEXT, last_checked_at TEXT,
      next_attempt_at TEXT, retry_count INTEGER DEFAULT 0, last_error_code TEXT);
    CREATE TABLE IF NOT EXISTS promotion_reset_runs (
      run_id TEXT PRIMARY KEY, environment_id TEXT, organization_id TEXT, state TEXT,
      manifest_hash TEXT, item_count INTEGER, created_at TEXT, updated_at TEXT,
      db_deleted_at TEXT, completed_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS promotion_reset_active
      ON promotion_reset_runs(environment_id,organization_id) WHERE state <> 'completed';
    CREATE TABLE IF NOT EXISTS promotion_reset_items (
      item_id TEXT PRIMARY KEY, run_id TEXT, promotion_id INTEGER, kind TEXT, object_name TEXT,
      storage_generation INTEGER, fingerprint TEXT, state TEXT, retry_count INTEGER DEFAULT 0,
      next_attempt_at TEXT, last_error_code TEXT, updated_at TEXT, UNIQUE(run_id,kind,fingerprint));
    """)


@contextmanager
def transaction():
    if local_json_fallback_enabled():
        from ..core.compat_gateway import get_runtime_data_paths
        path = get_runtime_data_paths()[0] / "promotions-local.sqlite3"
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path, timeout=10) as conn:
            conn.row_factory = sqlite3.Row
            conn.create_function("clock_timestamp", 0, lambda: utc_now().isoformat())
            _local_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            yield LocalCursor(conn)
        return
    with psycopg.connect(db_connection_string(), autocommit=False, connect_timeout=10) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            yield cur


def row(cur, item_id, lock=False):
    cur.execute("SELECT * FROM promotions WHERE organization_id=%s AND id=%s" +
                (" FOR UPDATE" if lock else ""), (get_current_tenant_id(), item_id))
    return cur.fetchone()


def list_items() -> list[dict[str, Any]]:
    with transaction() as cur:
        cur.execute("SELECT * FROM promotions WHERE organization_id=%s ORDER BY created_at DESC,id DESC",
                    (get_current_tenant_id(),))
        return cast(list[dict[str, Any]], cur.fetchall())


def get_item(item_id):
    with transaction() as cur:
        return row(cur, item_id)


def operation(cur, actor, operation_id, lock=True):
    cur.execute("SELECT * FROM promotion_operations WHERE organization_id=%s AND actor_key=%s "
                "AND operation_id=%s" + (" FOR UPDATE" if lock else ""),
                (get_current_tenant_id(), actor, operation_id))
    result = cur.fetchone()
    if result and isinstance(result.get("result_body"), str):
        result["result_body"] = json.loads(result["result_body"])
    return result


def db_now(cur):
    cur.execute("SELECT clock_timestamp() AS now")
    value = cur.fetchone()["now"]
    return value if isinstance(value, datetime) else datetime.fromisoformat(value)


def reserve(actor, operation_id, method, target_id, digest):
    with transaction() as cur:
        now = db_now(cur)
        attempt = str(uuid4())
        cur.execute("INSERT INTO promotion_operations (organization_id,actor_key,operation_id,method,target_id,"
                    "request_hash,state,attempt_id,lease_until,created_at,updated_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,'processing',%s,%s,%s,%s) "
                    "ON CONFLICT (organization_id,actor_key,operation_id) DO NOTHING",
                    (get_current_tenant_id(), actor, operation_id, method, target_id, digest,
                     attempt, now + timedelta(minutes=10), now, now))
        op = operation(cur, actor, operation_id)
        if op["request_hash"] != digest:
            return op, False, True
        if str(op["attempt_id"]) == attempt:
            return op, True, False
        if op["state"] == "processing":
            cur.execute("UPDATE promotion_operations SET attempt_id=%s,lease_until=%s,updated_at=clock_timestamp() "
                        "WHERE organization_id=%s AND actor_key=%s AND operation_id=%s AND state='processing' "
                        "AND attempt_id=%s AND lease_until<=clock_timestamp() RETURNING *",
                        (attempt, db_now(cur) + timedelta(minutes=10), get_current_tenant_id(), actor,
                         operation_id, op["attempt_id"]))
            claimed = cur.fetchone()
            if claimed:
                return claimed, True, False
        return op, False, False


class LostAttempt(Exception):
    pass


def require_attempt(cur, op):
    current = operation(cur, op["actor_key"], op["operation_id"])
    if not current or current["state"] != "processing" or str(current["attempt_id"]) != str(op["attempt_id"]):
        raise LostAttempt()
    cur.execute("SELECT 1 AS valid FROM promotion_operations WHERE organization_id=%s AND actor_key=%s "
                "AND operation_id=%s AND attempt_id=%s AND state='processing' "
                "AND lease_until>clock_timestamp()",
                (get_current_tenant_id(), op["actor_key"], op["operation_id"], op["attempt_id"]))
    if not cur.fetchone():
        raise LostAttempt()


def finish(cur, op, status, body):
    # Every terminal write is fenced, including errors found before uploading.
    cur.execute("UPDATE promotion_operations SET state=%s,result_status=%s,result_body=%s::jsonb,"
                "updated_at=clock_timestamp() WHERE organization_id=%s AND actor_key=%s AND operation_id=%s "
                "AND state='processing' AND attempt_id=%s AND lease_until>clock_timestamp() RETURNING operation_id",
                ("succeeded" if status < 400 else "rejected", status,
                 json.dumps(body, ensure_ascii=False, allow_nan=False), get_current_tenant_id(),
                 op["actor_key"], op["operation_id"], op["attempt_id"]))
    if not cur.fetchone():
        raise LostAttempt()


def release(op):
    with transaction() as cur:
        require_attempt(cur, op)
        cur.execute("UPDATE promotion_operations SET lease_until=clock_timestamp(),updated_at=clock_timestamp() "
                    "WHERE organization_id=%s AND actor_key=%s AND operation_id=%s AND state='processing' "
                    "AND attempt_id=%s AND lease_until>clock_timestamp() RETURNING operation_id",
                    (get_current_tenant_id(), op["actor_key"], op["operation_id"], op["attempt_id"]))
        if not cur.fetchone():
            raise LostAttempt()


def asset(cur, asset_id, lock=False):
    cur.execute("SELECT * FROM promotion_image_assets WHERE organization_id=%s AND asset_id=%s" +
                (" FOR UPDATE" if lock else ""), (get_current_tenant_id(), asset_id))
    return cur.fetchone()


def seed_local(items):
    """Explicit local fixtures/imports only; production whole-list saves are forbidden."""
    if not local_json_fallback_enabled():
        raise RuntimeError("Promotion whole-list writes are disabled")
    with transaction() as cur:
        tenant = get_current_tenant_id()
        for table in ("promotions", "promotion_image_assets", "promotion_operations"):
            cur.execute(f"DELETE FROM {table} WHERE organization_id=%s", (tenant,))
        for item in items:
            now = utc_now()
            cur.execute("INSERT INTO promotions (id,organization_id,title,summary,image_url,member_id,registered_by,"
                        "created_at,updated_at,revision) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (item.get("id"), tenant, item.get("title", ""), item.get("summary", ""),
                         item.get("image_url", ""), item.get("member_id") or None,
                         item.get("registered_by", ""), item.get("created_at") or now,
                         item.get("updated_at") or now, item.get("revision", 1)))
