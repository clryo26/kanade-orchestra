"""Row-level create/update/delete for portal collections (JST spec R05/R07).

Why this exists: the previous write path compared a version against the
per-process cache and then replaced the *whole* collection. Another Cloud Run
instance's newer rows could be deleted or resurrected. Here every single-item
write:

1. takes advisory locks (sorted keys) and ``SELECT … FOR UPDATE`` on the row,
2. re-reads the row and its children from the DB inside that transaction,
3. reads ``clock_timestamp()`` *after* the locks and derives the new version
   as ``max(db_now, previous + 1µs)``; a stored version more than
   ``MAX_FUTURE_VERSION_SKEW`` ahead stops the update (R07),
4. compares the expected version as an instant (Z/+09:00 equal),
5. applies a pure ``mutate`` callback (authorization/validation; no I/O so a
   deadlock retry can safely re-run it),
6. writes only that row and that parent's child rows, with the tenant in
   every WHERE clause, and returns the committed values.

Lock order (deadlock avoidance, plan 6.2): operation row (file ops only) ->
advisory locks in key order -> parent rows ``FOR UPDATE`` in id order ->
children (serialized by the parent lock) -> assets.

``ListRowStore`` implements the same API over a load/save pair. It is used for
the explicit local JSON development mode and by tests that fake the DB layer;
production DB mode always uses ``PostgresRowStore``.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, TypeVar

from fastapi import HTTPException

try:
    from ..core.db_pool import pooled_psycopg as psycopg
    from psycopg import errors as pg_errors
    from psycopg import sql as psql
except Exception:  # pragma: no cover - optional dependency guard
    psycopg = None  # type: ignore[assignment]
    pg_errors = None  # type: ignore[assignment]
    psql = None

from ..core.db_schema import (
    DATE_ENCODED_TIMESTAMP_COLUMNS,
    DB_CHILD_COLUMNS,
    DB_CHILD_PARENT_KEYS,
    DB_CHILD_TABLES,
    DB_COLLECTION_COLUMNS,
    DB_COLLECTION_ORDER_BY,
    JSON_COLLECTION_TABLES,
    LIST_LOCKED_COLLECTIONS,
)
from ..core.tenant_context import get_current_tenant_id
from ..db.database import db_connection_string
from ..utils.concurrency import ensure_expected_updated_at
from ..utils.datetime_utils import (
    MAX_FUTURE_VERSION_SKEW,
    FutureVersionAnomaly,
    format_instant,
    instant_or_none,
    jst_now,
    next_updated_at,
    parse_instant,
)
from .db_row_repository import (
    db_child_rows_for_collection,
    db_fill_missing_ids,
    db_insert_rows,
    db_row_to_json,
    db_row_tuple,
    table_has_organization_id,
)

logger = logging.getLogger(__name__)

LOCK_TIMEOUT = "5s"
STATEMENT_TIMEOUT = "15s"
IDLE_IN_TRANSACTION_TIMEOUT = "30s"
DEADLOCK_RETRIES = 2
NOT_FOUND_DETAIL = "Data not found"  # same detail as utils.collection_utils.find_item
SAVE_BUSY_DETAIL = {"code": "save_busy", "message": "保存が混み合っています。少し待ってから再度お試しください"}

SERVER_MANAGED = {"id", "created_at", "updated_at", "organization_id"}

Mutate = Callable[[dict[str, Any]], dict[str, Any]]
Build = Callable[[int], dict[str, Any]]
T = TypeVar("T")
Authorize = Callable[[dict[str, Any]], None]


@dataclass
class ItemContext:
    """An open row-level transaction shared by several calls (file operations)."""

    conn: Any
    cur: Any
    tenant_id: str
    locked_keys: set[str] = field(default_factory=set)
    _db_now: datetime | None = None
    touched: set[str] = field(default_factory=set)

    def db_now(self, *, refresh: bool = False) -> datetime:
        if self._db_now is None or refresh:
            self.cur.execute("SELECT clock_timestamp()")
            self._db_now = self.cur.fetchone()[0]
        assert self._db_now is not None
        return self._db_now


def _table(name: str) -> str:
    table = JSON_COLLECTION_TABLES.get(name)
    if not table:
        raise HTTPException(status_code=404, detail="Collection not found")
    return table


def _next_version(previous: Any, db_now: datetime, *, table: str, item_id: Any) -> datetime:
    previous_instant = instant_or_none(previous)
    if previous_instant is None:
        return db_now
    if previous_instant > db_now + MAX_FUTURE_VERSION_SKEW:
        raise FutureVersionAnomaly(table, item_id)
    return max(db_now, previous_instant + timedelta(microseconds=1))


def _vote_key(vote: Any) -> tuple[str, str]:
    if isinstance(vote, dict):
        member_id = str(vote.get("member_id") or "")
        return (member_id, "" if member_id else str(vote.get("name") or ""))
    return ("", str(vote or ""))


def _album_update_snapshot(name: str, current: dict[str, Any]) -> dict[str, Any] | None:
    if name != "albums":
        return None
    # Issue #150: preserve only these omission-sensitive fields, not a new
    # PATCH contract for every parent/collection. Snapshot under the row lock.
    return deepcopy({key: current[key] for key in ("photos", "created_by_member_id", "created_by_member_name") if key in current})


def _complete_album_update(updated: dict[str, Any], snapshot: dict[str, Any] | None) -> bool:
    """Validate after mutate's authorization; return whether photos were omitted."""
    if snapshot is None:
        return False
    stored = snapshot.get("photos")
    if stored is None:
        stored = []  # Explicit local legacy records may not yet have photos.
    if not isinstance(stored, list) or any(not isinstance(photo, dict) for photo in stored):
        logger.error("Album update blocked: stored photos are not an array of objects")
        raise RuntimeError("Stored album photos have invalid format")
    snapshot["photos"] = stored
    omitted = "photos" not in updated
    if omitted:
        updated["photos"] = stored
    elif not isinstance(updated["photos"], list) or any(not isinstance(photo, dict) for photo in updated["photos"]):
        raise HTTPException(status_code=422, detail="写真情報の形式が正しくありません")
    for key in ("created_by_member_id", "created_by_member_name"):
        if key not in updated and key in snapshot:
            updated[key] = snapshot[key]
    return omitted


def apply_server_child_fields(
    name: str,
    item: dict[str, Any],
    current: dict[str, Any] | None,
    now_text: str,
    *,
    add_missing: bool = True,
) -> None:
    """Child-row system timestamps come from the server, never the client (R02, N09).

    Existing children keep their stored values (matched by a stable key);
    new children get the DB time of this write.
    """
    current = current or {}
    parent_created = str(current.get("created_at") or item.get("created_at") or now_text)

    def keep(children_key: str, key_of: Callable[[Any], Any], extra: tuple[str, ...] = ()) -> None:
        stored = {
            key_of(child): child
            for child in current.get(children_key) or []
            if isinstance(child, dict)
        }
        normalized = []
        for child in item.get(children_key) or []:
            if not isinstance(child, dict):
                normalized.append(child)
                continue
            child = dict(child)
            match = stored.get(key_of(child))
            for column in ("created_at", *extra, "updated_at"):
                if not add_missing and column not in child:
                    continue
                child[column] = now_text if column == "updated_at" else (match or {}).get(column) or now_text
            normalized.append(child)
        if children_key in item:
            item[children_key] = normalized

    if name == "desired_pieces":
        keep("votes", _vote_key, ("voted_at",))
    elif name == "albums":
        keep("photos", lambda photo: str(photo.get("id") or ""), ("uploaded_at",))
    elif name == "date_adjustments":
        keep("candidates", lambda c: str(c.get("candidate_key") or c.get("id") or ""))
    else:
        for children_key in ("pieces", "members", "extras"):
            if isinstance(item.get(children_key), list):
                item[children_key] = [
                    _child_times(child, parent_created, now_text, add_missing) if isinstance(child, dict) else child
                    for child in item[children_key]
                ]


def _child_times(child: dict[str, Any], created: str, updated: str, add_missing: bool) -> dict[str, Any]:
    child = dict(child)
    for column, value in (("created_at", created), ("updated_at", updated)):
        if add_missing or column in child:
            child[column] = value
    return child


# --------------------------------------------------------------------------- reads


def _fetch_children(conn: Any, child_table: str, parent_key: str, parent_ids: list[Any], order_by: str) -> list[dict[str, Any]]:
    if not parent_ids:
        return []
    tenant_id = get_current_tenant_id()
    clauses = [psql.SQL("{} = ANY(%s)").format(psql.Identifier(parent_key))]
    params: list[Any] = [parent_ids]
    if table_has_organization_id(conn, child_table):
        clauses.insert(0, psql.SQL("organization_id = %s"))
        params.insert(0, tenant_id)
    order_sql = psql.SQL(" ORDER BY {}").format(psql.Identifier(order_by)) if order_by else psql.SQL("")
    query = psql.SQL("SELECT * FROM {} WHERE {}{}").format(
        psql.Identifier(child_table), psql.SQL(" AND ").join(clauses), order_sql
    )
    with conn.cursor() as cur:
        cur.execute(query, tuple(params))
        rows = cur.fetchall()
        columns = [desc[0] for desc in cur.description]
    return [db_row_to_json(dict(zip(columns, row)), child_table) for row in rows]


def attach_collection_children(
    conn: Any,
    name: str,
    items: list[dict[str, Any]],
    *,
    fetch_children: Callable[[str, str, list[Any], str], list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    """Shape child rows into the parent JSON exactly like the list API does."""
    if name not in DB_CHILD_TABLES or not items:
        return items
    parent_ids = [item.get("id") for item in items if item.get("id") is not None]

    def children(child_table: str, order_by: str) -> list[dict[str, Any]]:
        parent_key = DB_CHILD_PARENT_KEYS[child_table]
        if fetch_children is not None:
            return fetch_children(child_table, parent_key, parent_ids, order_by)
        return _fetch_children(conn, child_table, parent_key, parent_ids, order_by)

    def group(rows: list[dict[str, Any]], key: str) -> dict[Any, list[dict[str, Any]]]:
        grouped: dict[Any, list[dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(row.get(key), []).append(row)
        return grouped

    if name == "performances":
        by_parent = group(children("performance_pieces", "sort_order"), "performance_id")
        for item in items:
            item["pieces"] = by_parent.get(item.get("id"), [])
    elif name == "date_adjustments":
        rows = children("date_adjustment_candidates", "sort_order")
        for candidate in rows:
            candidate["id"] = candidate.get("candidate_key") or candidate.get("id")
        by_parent = group(rows, "adjustment_id")
        for item in items:
            item["candidates"] = by_parent.get(item.get("id"), [])
    elif name == "payments":
        by_parent = group(children("payment_performance_fees", ""), "payment_id")
        for item in items:
            fees: dict[str, bool] = {}
            amounts: dict[str, Any] = {}
            for fee in by_parent.get(item.get("id"), []):
                performance_id = str(fee.get("performance_id"))
                fees[performance_id] = bool(fee.get("is_paid"))
                amounts[performance_id] = fee.get("fee_amount")
            item["performance_fees"] = fees
            item["performance_fee_amounts"] = amounts
    elif name == "castings":
        members = group(children("casting_members", "sort_order"), "casting_id")
        extras = group(children("casting_extras", "sort_order"), "casting_id")
        for item in items:
            item["members"] = members.get(item.get("id"), [])
            item["extras"] = extras.get(item.get("id"), [])
    elif name == "desired_pieces":
        by_parent = group(children("desired_piece_votes", "id"), "desired_piece_id")
        for item in items:
            item["votes"] = by_parent.get(item.get("id"), [])
    elif name == "albums":
        by_parent = group(children("album_photos", "id"), "album_id")
        for item in items:
            item["photos"] = by_parent.get(item.get("id"), [])
    return items


# --------------------------------------------------------------------------- PostgreSQL


class PostgresRowStore:
    """Production row-level store."""

    @contextmanager
    def transaction(self) -> Iterator[ItemContext]:
        if psycopg is None:
            raise HTTPException(status_code=500, detail="psycopg is not installed")
        with psycopg.connect(db_connection_string(), autocommit=False, connect_timeout=10) as conn:
            with conn.cursor() as cur:
                # SET LOCAL lasts until COMMIT/ROLLBACK. Bounded waits so a
                # stuck lock never hangs a request (spec R05: finite time).
                cur.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
                cur.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
                cur.execute(f"SET LOCAL idle_in_transaction_session_timeout = '{IDLE_IN_TRANSACTION_TIMEOUT}'")
                ctx = ItemContext(conn=conn, cur=cur, tenant_id=get_current_tenant_id())
                yield ctx
            conn.commit()
        self._after_commit(ctx)

    def _after_commit(self, ctx: ItemContext) -> None:
        if not ctx.touched:
            return
        try:
            from ..core.compat_gateway import get_memory_cache_instance

            cache = get_memory_cache_instance()
            for name in ctx.touched:
                cache.invalidate(name)
        except Exception:  # pragma: no cover - cache refresh never fails a committed save
            logger.warning("Collection cache invalidation failed after commit")

    def _run(self, ctx: ItemContext | None, work: Callable[[ItemContext], T]) -> T:
        if ctx is not None:
            return work(ctx)
        attempts = 0
        while True:
            try:
                with self.transaction() as own:
                    return work(own)
            except Exception as exc:  # noqa: BLE001 - mapped below
                if pg_errors is not None and isinstance(exc, pg_errors.LockNotAvailable):
                    raise HTTPException(status_code=503, detail=SAVE_BUSY_DETAIL) from exc
                retryable = pg_errors is not None and isinstance(
                    exc, (pg_errors.DeadlockDetected, pg_errors.SerializationFailure)
                )
                if retryable and attempts < DEADLOCK_RETRIES:
                    attempts += 1
                    logger.warning("Row-level write retried after %s", type(exc).__name__)
                    continue
                raise

    # -- locks ---------------------------------------------------------------

    def lock(self, ctx: ItemContext, name: str, keys: Sequence[str]) -> None:
        wanted = sorted({f"portal:{ctx.tenant_id}:{name}:{key}" for key in keys} - ctx.locked_keys)
        for key in wanted:
            ctx.cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (key,))
            ctx.locked_keys.add(key)

    def _collection_keys(self, name: str, group_keys: Sequence[str]) -> list[str]:
        keys = [f"group:{key}" for key in group_keys]
        if name in LIST_LOCKED_COLLECTIONS:
            # Mixed row/list collections: every writer joins the same lock (C04).
            keys.append("collection")
        return keys

    # -- reads ---------------------------------------------------------------

    def _select(self, ctx: ItemContext, name: str, item_id: Any, *, lock: bool) -> dict[str, Any] | None:
        table = _table(name)
        has_org = table_has_organization_id(ctx.conn, table)
        where = psql.SQL("organization_id = %s AND id = %s") if has_org else psql.SQL("id = %s")
        params: tuple[Any, ...] = (ctx.tenant_id, item_id) if has_org else (item_id,)
        query = psql.SQL("SELECT * FROM {} WHERE {}{}").format(
            psql.Identifier(table), where, psql.SQL(" FOR UPDATE") if lock else psql.SQL("")
        )
        ctx.cur.execute(query, params)
        row = ctx.cur.fetchone()
        if row is None:
            return None
        columns = [desc[0] for desc in ctx.cur.description]
        item = db_row_to_json(dict(zip(columns, row)), table)
        return attach_collection_children(ctx.conn, name, [item])[0]

    def get(self, name: str, item_id: Any, *, ctx: ItemContext | None = None, lock: bool = False) -> dict[str, Any] | None:
        return self._run(ctx, lambda c: self._select(c, name, item_id, lock=lock))

    def list(self, name: str, *, ctx: ItemContext | None = None) -> list[dict[str, Any]]:
        def work(c: ItemContext) -> list[dict[str, Any]]:
            table = _table(name)
            order_by = DB_COLLECTION_ORDER_BY.get(name, "id")
            has_org = table_has_organization_id(c.conn, table)
            query = psql.SQL("SELECT * FROM {}{} ORDER BY {}").format(
                psql.Identifier(table),
                psql.SQL(" WHERE organization_id = %s") if has_org else psql.SQL(""),
                psql.Identifier(order_by),
            )
            c.cur.execute(query, (c.tenant_id,) if has_org else ())
            rows = c.cur.fetchall()
            columns = [desc[0] for desc in c.cur.description]
            items = [db_row_to_json(dict(zip(columns, row)), table) for row in rows]
            return attach_collection_children(c.conn, name, items)

        return self._run(ctx, work)

    # -- writes --------------------------------------------------------------

    def _allocate_id(self, ctx: ItemContext, table: str) -> int:
        # Same rule as before (max(id)+1, global across tenants) but read
        # from the DB under a lock instead of a possibly stale cached list.
        # Sequence adjustment is intentionally not done here (pending S00 Q16).
        ctx.cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"portal:id:{table}",))
        ctx.cur.execute(psql.SQL("SELECT COALESCE(MAX(id), 0) FROM {}").format(psql.Identifier(table)))
        return int(ctx.cur.fetchone()[0]) + 1

    def allocate_child_id(self, ctx: ItemContext, child_table: str) -> int:
        """Child IDs unique across parents (e.g. album photos, N05). Same rule as rows."""
        return self._allocate_id(ctx, child_table)

    def _write_children(self, ctx: ItemContext, name: str, item: dict[str, Any], now_text: str) -> None:
        for child_table, child_rows in db_child_rows_for_collection(name, [item], now=now_text).items():
            parent_key = DB_CHILD_PARENT_KEYS[child_table]
            child_has_org = table_has_organization_id(ctx.conn, child_table)
            columns = DB_CHILD_COLUMNS[child_table]
            if child_has_org and "organization_id" not in columns:
                columns = (*columns, "organization_id")
            delete_where = psql.SQL("{} = %s").format(psql.Identifier(parent_key))
            params: tuple[Any, ...] = (item["id"],)
            if child_has_org:
                delete_where = psql.SQL("organization_id = %s AND ") + delete_where
                params = (ctx.tenant_id, item["id"])
                for row in child_rows:
                    row["organization_id"] = ctx.tenant_id
            ctx.cur.execute(psql.SQL("DELETE FROM {} WHERE {}").format(psql.Identifier(child_table), delete_where), params)
            if not child_rows:
                continue
            db_fill_missing_ids(ctx.cur, child_table, child_rows)
            db_insert_rows(ctx.cur, child_table, columns, child_rows)

    def _columns(self, ctx: ItemContext, table: str) -> tuple[str, ...]:
        columns = DB_COLLECTION_COLUMNS[table]
        if table_has_organization_id(ctx.conn, table) and "organization_id" not in columns:
            columns = (*columns, "organization_id")
        return columns

    def insert(self, name: str, build: Build, *, group_keys: Sequence[str] = (), ctx: ItemContext | None = None) -> dict[str, Any]:
        def work(c: ItemContext) -> dict[str, Any]:
            table = _table(name)
            self.lock(c, name, self._collection_keys(name, group_keys))
            item_id = self._allocate_id(c, table)
            now = c.db_now(refresh=True)
            now_text = format_instant(now)
            item = {key: value for key, value in dict(build(item_id)).items() if key not in SERVER_MANAGED}
            item.update({"id": item_id, "created_at": now_text, "updated_at": now_text, "organization_id": c.tenant_id})
            apply_server_child_fields(name, item, None, now_text)
            columns = self._columns(c, table)
            db_insert_rows(c.cur, table, columns, [item])
            self._write_children(c, name, item, now_text)
            c.touched.add(name)
            saved = self._select(c, name, item_id, lock=False)
            assert saved is not None
            return saved

        return self._run(ctx, work)

    def update(
        self,
        name: str,
        item_id: Any,
        mutate: Mutate,
        *,
        expected_updated_at: str | None = None,
        group_keys: Sequence[str] = (),
        ctx: ItemContext | None = None,
    ) -> dict[str, Any]:
        def work(c: ItemContext) -> dict[str, Any]:
            table = _table(name)
            self.lock(c, name, self._collection_keys(name, group_keys))
            current = self._select(c, name, item_id, lock=True)
            if current is None:
                raise HTTPException(status_code=404, detail=NOT_FOUND_DETAIL)
            now = c.db_now(refresh=True)
            version = _next_version(current.get("updated_at"), now, table=table, item_id=item_id)
            ensure_expected_updated_at(current, expected_updated_at)
            snapshot = _album_update_snapshot(name, current)
            # A mutator must not mutate nested persisted values through the
            # shallow current dict, especially if it later fails validation.
            updated = dict(mutate(deepcopy(current) if snapshot is not None else dict(current)))
            photos_omitted = _complete_album_update(updated, snapshot)
            now_text = format_instant(version)
            updated.update(
                {"id": current["id"], "created_at": current.get("created_at"), "updated_at": now_text, "organization_id": c.tenant_id}
            )
            apply_server_child_fields(name, updated, current, now_text)
            if photos_omitted:
                assert snapshot is not None
                # No photo was edited: retain all stored child timestamps too.
                # SQL replacement still happens; diff writes belong to stage 4C.
                updated["photos"] = snapshot["photos"]
            # An unrecognized legacy date encoding is displayed as unknown.
            # A blank browser date input must not erase its original DB value
            # before Q04 establishes how that data is to be migrated.
            for column in DATE_ENCODED_TIMESTAMP_COLUMNS.get(table, set()):
                if current.get(column) == "" and updated.get(column) in (None, ""):
                    has_org = table_has_organization_id(c.conn, table)
                    where = psql.SQL("organization_id = %s AND id = %s") if has_org else psql.SQL("id = %s")
                    params = (c.tenant_id, current["id"]) if has_org else (current["id"],)
                    c.cur.execute(psql.SQL("SELECT {} FROM {} WHERE {}").format(
                        psql.Identifier(column), psql.Identifier(table), where,
                    ), params)
                    updated[column] = c.cur.fetchone()[0]
            columns = [column for column in self._columns(c, table) if column not in {"id", "created_at", "organization_id"}]
            values = db_row_tuple(table, tuple(columns), updated)
            has_org = table_has_organization_id(c.conn, table)
            where = psql.SQL("organization_id = %s AND id = %s") if has_org else psql.SQL("id = %s")
            where_params: tuple[Any, ...] = (c.tenant_id, current["id"]) if has_org else (current["id"],)
            c.cur.execute(
                psql.SQL("UPDATE {} SET {} WHERE {}").format(
                    psql.Identifier(table),
                    psql.SQL(", ").join(psql.SQL("{} = %s").format(psql.Identifier(column)) for column in columns),
                    where,
                ),
                (*values, *where_params),
            )
            if name in DB_CHILD_TABLES:
                self._write_children(c, name, updated, now_text)
            c.touched.add(name)
            saved = self._select(c, name, item_id, lock=False)
            assert saved is not None
            return saved

        return self._run(ctx, work)

    def update_columns(
        self,
        name: str,
        item_id: Any,
        values: dict[str, Any],
        *,
        where: dict[str, Any] | None = None,
        bump_version: bool = True,
        ctx: ItemContext | None = None,
    ) -> dict[str, Any] | None:
        """Partial UPDATE of named columns; returns ``None`` when ``where`` no longer matches."""

        def work(c: ItemContext) -> dict[str, Any] | None:
            table = _table(name)
            self.lock(c, name, self._collection_keys(name, ()))
            current = self._select(c, name, item_id, lock=True)
            if current is None:
                return None
            for column, expected in (where or {}).items():
                if current.get(column) != expected:
                    return None
            row = dict(current)
            row.update(values)
            if bump_version:
                version = _next_version(current.get("updated_at"), c.db_now(refresh=True), table=table, item_id=item_id)
                row["updated_at"] = format_instant(version)
            columns = [column for column in values if column not in SERVER_MANAGED]
            if bump_version:
                columns.append("updated_at")
            has_org = table_has_organization_id(c.conn, table)
            where_sql = psql.SQL("organization_id = %s AND id = %s") if has_org else psql.SQL("id = %s")
            where_params: tuple[Any, ...] = (c.tenant_id, current["id"]) if has_org else (current["id"],)
            c.cur.execute(
                psql.SQL("UPDATE {} SET {} WHERE {}").format(
                    psql.Identifier(table),
                    psql.SQL(", ").join(psql.SQL("{} = %s").format(psql.Identifier(column)) for column in columns),
                    where_sql,
                ),
                (*db_row_tuple(table, tuple(columns), row), *where_params),
            )
            c.touched.add(name)
            return self._select(c, name, item_id, lock=False)

        return self._run(ctx, work)

    def delete(
        self,
        name: str,
        item_id: Any,
        authorize: Authorize,
        *,
        expected_updated_at: str | None = None,
        group_keys: Sequence[str] = (),
        ctx: ItemContext | None = None,
    ) -> dict[str, Any]:
        def work(c: ItemContext) -> dict[str, Any]:
            table = _table(name)
            self.lock(c, name, self._collection_keys(name, group_keys))
            current = self._select(c, name, item_id, lock=True)
            if current is None:
                raise HTTPException(status_code=404, detail=NOT_FOUND_DETAIL)
            authorize(current)
            ensure_expected_updated_at(current, expected_updated_at)
            for child_table in DB_CHILD_TABLES.get(name, ()):
                parent_key = DB_CHILD_PARENT_KEYS[child_table]
                child_has_org = table_has_organization_id(c.conn, child_table)
                where = psql.SQL("{} = %s").format(psql.Identifier(parent_key))
                params: tuple[Any, ...] = (current["id"],)
                if child_has_org:
                    where = psql.SQL("organization_id = %s AND ") + where
                    params = (c.tenant_id, current["id"])
                c.cur.execute(psql.SQL("DELETE FROM {} WHERE {}").format(psql.Identifier(child_table), where), params)
            has_org = table_has_organization_id(c.conn, table)
            where_sql = psql.SQL("organization_id = %s AND id = %s") if has_org else psql.SQL("id = %s")
            c.cur.execute(
                psql.SQL("DELETE FROM {} WHERE {}").format(psql.Identifier(table), where_sql),
                (c.tenant_id, current["id"]) if has_org else (current["id"],),
            )
            c.touched.add(name)
            return current

        return self._run(ctx, work)

    def update_many(
        self,
        name: str,
        updates: dict[Any, dict[str, Any]],
        *,
        group_keys: Sequence[str] = (),
        ctx: ItemContext | None = None,
        unique_two_phase: str | None = None,
    ) -> None:
        """Set columns on several rows of one locked group (e.g. re-sequencing).

        ``unique_two_phase`` names an integer column covered by a UNIQUE index;
        rows are first moved to a free range so swaps cannot collide.
        """

        def work(c: ItemContext) -> None:
            table = _table(name)
            self.lock(c, name, self._collection_keys(name, group_keys))
            has_org = table_has_organization_id(c.conn, table)
            ids = sorted(updates, key=lambda value: int(value))
            now = c.db_now(refresh=True)
            if unique_two_phase and ids:
                c.cur.execute(
                    psql.SQL("SELECT COALESCE(MAX({}), 0) FROM {}").format(
                        psql.Identifier(unique_two_phase), psql.Identifier(table)
                    )
                )
                offset = int(c.cur.fetchone()[0]) + len(ids) + 1
                for index, row_id in enumerate(ids):
                    c.cur.execute(
                        psql.SQL("UPDATE {} SET {} = %s WHERE {}id = %s").format(
                            psql.Identifier(table),
                            psql.Identifier(unique_two_phase),
                            psql.SQL("organization_id = %s AND ") if has_org else psql.SQL(""),
                        ),
                        (offset + index, *((c.tenant_id,) if has_org else ()), row_id),
                    )
            for row_id in ids:
                current = self._select(c, name, row_id, lock=True)
                if current is None:
                    continue
                values = dict(updates[row_id])
                changed = any(current.get(key) != value for key, value in values.items())
                columns = [column for column in values if column not in SERVER_MANAGED]
                if changed:
                    values["updated_at"] = format_instant(
                        _next_version(current.get("updated_at"), now, table=table, item_id=row_id)
                    )
                    columns.append("updated_at")
                if not columns:
                    continue
                row = {**current, **values}
                c.cur.execute(
                    psql.SQL("UPDATE {} SET {} WHERE {}id = %s").format(
                        psql.Identifier(table),
                        psql.SQL(", ").join(psql.SQL("{} = %s").format(psql.Identifier(column)) for column in columns),
                        psql.SQL("organization_id = %s AND ") if has_org else psql.SQL(""),
                    ),
                    (*db_row_tuple(table, tuple(columns), row), *((c.tenant_id,) if has_org else ()), row_id),
                )
            c.touched.add(name)

        self._run(ctx, work)


# --------------------------------------------------------------------------- list adapter


class ListRowStore:
    """Same API over ``load(name)`` / ``save(name, items)``.

    Used for the explicit local JSON development mode (single process; a
    process lock serializes writers) and for tests that fake the DB layer.
    It mirrors the version/conflict/server-field rules of the DB store.
    """

    _locks: dict[str, threading.RLock] = {}
    _locks_guard = threading.Lock()

    def __init__(self, load: Callable[[str], list[dict[str, Any]]], save: Callable[[str, list[dict[str, Any]]], None]):
        self._load = load
        self._save_list = save

    def _save(self, name: str, items: list[dict[str, Any]]) -> None:
        self._save_list(name, items)
        # Same rule as the DB store: after a write the next read reloads.
        try:
            from ..core.compat_gateway import get_memory_cache_instance

            get_memory_cache_instance().invalidate(name)
        except Exception:  # pragma: no cover - cache refresh never fails a save
            logger.warning("Collection cache invalidation failed after save")

    @classmethod
    def _lock_for(cls, name: str) -> threading.RLock:
        with cls._locks_guard:
            return cls._locks.setdefault(name, threading.RLock())

    @contextmanager
    def transaction(self) -> Iterator[None]:
        yield None

    def lock(self, ctx: Any, name: str, keys: Sequence[str]) -> None:
        return None

    def allocate_child_id(self, ctx: Any, child_table: str) -> int:
        children_key = {"album_photos": ("albums", "photos")}[child_table]
        parents = self._items(children_key[0])
        return max(
            (int(child.get("id") or 0) for parent in parents for child in parent.get(children_key[1]) or [] if isinstance(child, dict)),
            default=0,
        ) + 1

    def _items(self, name: str) -> list[dict[str, Any]]:
        return [dict(item) for item in self._load(name)]

    def get(self, name: str, item_id: Any, *, ctx: Any = None, lock: bool = False) -> dict[str, Any] | None:
        return next((item for item in self._items(name) if item.get("id") == item_id), None)

    def list(self, name: str, *, ctx: Any = None) -> list[dict[str, Any]]:
        return self._items(name)

    def insert(self, name: str, build: Build, *, group_keys: Sequence[str] = (), ctx: Any = None) -> dict[str, Any]:
        with self._lock_for(name):
            items = self._items(name)
            item_id = max((int(item.get("id") or 0) for item in items), default=0) + 1
            now_text = format_instant(jst_now())
            item = {key: value for key, value in dict(build(item_id)).items() if key not in SERVER_MANAGED}
            item.update({"id": item_id, "created_at": now_text, "updated_at": now_text})
            apply_server_child_fields(name, item, None, now_text, add_missing=False)
            items.append(item)
            self._save(name, items)
            return dict(item)

    def update(
        self,
        name: str,
        item_id: Any,
        mutate: Mutate,
        *,
        expected_updated_at: str | None = None,
        group_keys: Sequence[str] = (),
        ctx: Any = None,
    ) -> dict[str, Any]:
        with self._lock_for(name):
            items = self._items(name)
            index = next((i for i, item in enumerate(items) if item.get("id") == item_id), None)
            if index is None:
                raise HTTPException(status_code=404, detail=NOT_FOUND_DETAIL)
            current = items[index]
            ensure_expected_updated_at(current, expected_updated_at)
            snapshot = _album_update_snapshot(name, current)
            # A mutator must not mutate nested persisted values through the
            # shallow current dict, especially if it later fails validation.
            updated = dict(mutate(deepcopy(current) if snapshot is not None else dict(current)))
            photos_omitted = _complete_album_update(updated, snapshot)
            now_text = next_updated_at(current.get("updated_at"))
            updated.update({"id": current["id"], "created_at": current.get("created_at") or now_text, "updated_at": now_text})
            apply_server_child_fields(name, updated, current, now_text, add_missing=False)
            if photos_omitted:
                assert snapshot is not None
                # No photo was edited: retain all stored child timestamps too.
                # SQL replacement still happens; diff writes belong to stage 4C.
                updated["photos"] = snapshot["photos"]
            items[index] = updated
            self._save(name, items)
            return dict(updated)

    def update_columns(
        self,
        name: str,
        item_id: Any,
        values: dict[str, Any],
        *,
        where: dict[str, Any] | None = None,
        bump_version: bool = True,
        ctx: Any = None,
    ) -> dict[str, Any] | None:
        with self._lock_for(name):
            items = self._items(name)
            index = next((i for i, item in enumerate(items) if item.get("id") == item_id), None)
            if index is None:
                return None
            current = items[index]
            if any(current.get(column) != expected for column, expected in (where or {}).items()):
                return None
            updated = {**current, **{k: v for k, v in values.items() if k not in SERVER_MANAGED}}
            if bump_version:
                updated["updated_at"] = next_updated_at(current.get("updated_at"))
            items[index] = updated
            self._save(name, items)
            return dict(updated)

    def delete(
        self,
        name: str,
        item_id: Any,
        authorize: Authorize,
        *,
        expected_updated_at: str | None = None,
        group_keys: Sequence[str] = (),
        ctx: Any = None,
    ) -> dict[str, Any]:
        with self._lock_for(name):
            items = self._items(name)
            current = next((item for item in items if item.get("id") == item_id), None)
            if current is None:
                raise HTTPException(status_code=404, detail=NOT_FOUND_DETAIL)
            authorize(current)
            ensure_expected_updated_at(current, expected_updated_at)
            self._save(name, [item for item in items if item.get("id") != item_id])
            return current

    def update_many(
        self,
        name: str,
        updates: dict[Any, dict[str, Any]],
        *,
        group_keys: Sequence[str] = (),
        ctx: Any = None,
        unique_two_phase: str | None = None,
    ) -> None:
        with self._lock_for(name):
            items = self._items(name)
            for item in items:
                values = updates.get(item.get("id"))
                if not values:
                    continue
                if any(item.get(key) != value for key, value in values.items()):
                    item.update(values)
                    item["updated_at"] = next_updated_at(item.get("updated_at"))
            self._save(name, items)


def stored_instant(value: Any) -> datetime | None:
    """Helper for callers comparing stored instants (None when unknown)."""
    try:
        return parse_instant(value) if value not in (None, "") else None
    except Exception:
        return None
