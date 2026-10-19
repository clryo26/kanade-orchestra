from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi import HTTPException

try:
    from ..core.db_pool import pooled_psycopg as psycopg
    from psycopg import sql as psql
    from psycopg.types.json import Jsonb
except Exception:  # pragma: no cover - optional dependency guard
    psycopg = None  # type: ignore[assignment]
    psql = None
    Jsonb = None

from ..core.db_schema import (
    LIST_LOCKED_COLLECTIONS,
    ROW_LEVEL_COLLECTIONS,
    DB_CHILD_PARENT_KEYS,
    DB_CHILD_COLUMNS,
    DB_CHILD_TABLES,
    DB_COLLECTION_COLUMNS,
    DB_COLLECTION_ORDER_BY,
    DB_WRITABLE_COLLECTIONS,
    JSON_COLLECTION_TABLES,
)
from .db_row_repository import (
    db_child_rows_for_collection,
    db_collection_rows_for_save,
    db_delete_collection_children,
    db_fetch_all,
    db_fill_missing_ids,
    db_prepare_timestamp_columns_for_upsert,
    db_insert_rows,
    db_upsert_rows,
    db_write_value,
    table_has_organization_id,
)
from ..core.tenant_context import get_current_tenant_id
from ..db.database import db_connection_string
from .db_item_repository import attach_collection_children
from ..utils.datetime_utils import API_DATETIME_FORMAT_VERSION, format_instant


def _core() -> None:
    # Backward-compat hook for tests that monkeypatch repository internals.
    return None


def load_generic_json_collection(name: str) -> list[dict[str, Any]]:
    with psycopg.connect(db_connection_string(), autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT items FROM portal_json_collections WHERE collection_name = %s",
                (name,),
            )
            row = cur.fetchone()
            if not row:
                return []
            items = row[0]
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]
            return []


def save_generic_json_collection(name: str, data: list[dict[str, Any]]) -> None:
    payload = Jsonb(data) if Jsonb is not None else json.dumps(data, ensure_ascii=False)
    with psycopg.connect(db_connection_string(), autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO portal_json_collections (collection_name, items, updated_at)
                VALUES (%s, %s, NOW())
                ON CONFLICT (collection_name)
                DO UPDATE SET items = EXCLUDED.items, updated_at = NOW()
                """,
                (name, payload),
            )


def _stabilize_concert_record_video_sort_orders(cur: Any, tenant_id: str) -> None:
    cur.execute(
        psql.SQL(
            "SELECT id, performance_id, sort_order FROM {} WHERE organization_id = %s "
            "ORDER BY performance_id, sort_order, id"
        ).format(psql.Identifier("concert_record_videos")),
        (tenant_id,),
    )
    rows = cur.fetchall()
    if not rows:
        return

    by_performance: dict[Any, list[tuple[int, int]]] = {}
    for row_id, performance_id, sort_order in rows:
        by_performance.setdefault(performance_id, []).append((int(row_id), int(sort_order or 0)))

    temp_updates: list[tuple[int, int]] = []
    for group_rows in by_performance.values():
        max_sort_order = max(sort_order for _, sort_order in group_rows)
        temp_sort_order = max_sort_order + len(group_rows) + 1
        for index, (row_id, _) in enumerate(group_rows):
            temp_updates.append((temp_sort_order + index, row_id))

    cur.executemany(
        psql.SQL("UPDATE {} SET sort_order = %s WHERE id = %s").format(psql.Identifier("concert_record_videos")),
        temp_updates,
    )


def load_json_data(name: str) -> list[dict[str, Any]]:
    table_name = JSON_COLLECTION_TABLES.get(name)
    if not table_name:
        return []

    with psycopg.connect(db_connection_string(), autocommit=True) as conn:
        items = db_fetch_all(conn, table_name, order_by=DB_COLLECTION_ORDER_BY.get(name, "id"))
        if name == "concert_record_videos":
            items.sort(
                key=lambda item: (
                    int(item.get("performance_id") or 0),
                    int(item.get("sort_order") or 0),
                    int(item.get("id") or 0),
                )
            )
        # Same child assembly as the row-level store (one definition).
        return attach_collection_children(conn, name, items, fetch_children=_tenant_children(conn))


def _tenant_children(conn: Any) -> Any:
    def fetch(child_table: str, parent_key: str, parent_ids: list[Any], order_by: str) -> list[dict[str, Any]]:
        # The list view loads every child row of the tenant once (as before).
        return db_fetch_all(conn, child_table, order_by=order_by)

    return fetch


def load_collection_etag(name: str) -> str:
    table_name = JSON_COLLECTION_TABLES.get(name)
    if not table_name:
        return ""

    tenant_id = get_current_tenant_id()

    def _table_signature(conn: Any, cur: Any, target_table: str) -> str:
        has_org_column = table_has_organization_id(conn, target_table)
        try:
            if has_org_column:
                cur.execute(
                    psql.SQL(
                        "SELECT COUNT(*), COALESCE(md5(string_agg(xmin::text, ',' ORDER BY xmin::text)), '') "
                        "FROM {} WHERE organization_id = %s"
                    ).format(psql.Identifier(target_table)),
                    (tenant_id,),
                )
            else:
                cur.execute(
                    psql.SQL(
                        "SELECT COUNT(*), COALESCE(md5(string_agg(xmin::text, ',' ORDER BY xmin::text)), '') FROM {}"
                    ).format(psql.Identifier(target_table))
                )
        except Exception:
            try:
                if has_org_column:
                    cur.execute(
                        psql.SQL(
                            "SELECT COUNT(*), COALESCE(MAX(updated_at)::text, '') FROM {} WHERE organization_id = %s"
                        ).format(psql.Identifier(target_table)),
                        (tenant_id,),
                    )
                else:
                    cur.execute(
                        psql.SQL("SELECT COUNT(*), COALESCE(MAX(updated_at)::text, '') FROM {}").format(
                            psql.Identifier(target_table)
                        )
                    )
            except Exception:
                if has_org_column:
                    cur.execute(
                        psql.SQL(
                            "SELECT COUNT(*), COALESCE(MAX(id)::text, '') FROM {} WHERE organization_id = %s"
                        ).format(psql.Identifier(target_table)),
                        (tenant_id,),
                    )
                else:
                    cur.execute(
                        psql.SQL("SELECT COUNT(*), COALESCE(MAX(id)::text, '') FROM {}").format(
                            psql.Identifier(target_table)
                        )
                    )
        row = cur.fetchone() or (0, "")
        return f"{target_table}:{row[0]}:{row[1]}"

    with psycopg.connect(db_connection_string(), autocommit=True) as conn:
        with conn.cursor() as cur:
            signatures = [_table_signature(conn, cur, table_name)]
            signatures.extend(
                _table_signature(conn, cur, child_table)
                for child_table in DB_CHILD_TABLES.get(name, ())
            )

    # The representation version makes old-format payloads miss 304 (R09).
    digest_base = f"{API_DATETIME_FORMAT_VERSION}:{tenant_id}:{name}:" + "|".join(signatures)
    return hashlib.sha256(digest_base.encode("utf-8")).hexdigest()


def upsert_auth_device(device: dict[str, Any], *, stamp: tuple[str, ...] = ()) -> dict[str, Any]:
    """Insert or replace the session row of one device (login).

    ``stamp`` names timestamp columns set from the DB clock (``clock_timestamp()``)
    instead of the app clock (JST spec R02: persisted times come from the DB).
    """
    table_name = "auth_devices"
    tenant_id = get_current_tenant_id()
    row = dict(device)
    device_id = str(row.get("device_id") or "").strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required")

    with psycopg.connect(db_connection_string(), autocommit=False, connect_timeout=10) as conn:
        has_org_column = table_has_organization_id(conn, table_name)
        with conn.cursor() as cur:
            if stamp:
                cur.execute("SELECT clock_timestamp()")
                db_now = format_instant(cur.fetchone()[0])
                for column in stamp:
                    row[column] = db_now
            if has_org_column:
                cur.execute(
                    psql.SQL(
                        "SELECT id, created_at FROM {} WHERE organization_id = %s AND device_id = %s ORDER BY id LIMIT 1"
                    ).format(psql.Identifier(table_name)),
                    (tenant_id, device_id),
                )
            else:
                cur.execute(
                    psql.SQL("SELECT id, created_at FROM {} WHERE device_id = %s ORDER BY id LIMIT 1").format(
                        psql.Identifier(table_name)
                    ),
                    (device_id,),
                )
            existing = cur.fetchone()
            if existing:
                row["id"] = existing[0]
                row["created_at"] = row.get("created_at") or existing[1]
            if has_org_column:
                row["organization_id"] = str(row.get("organization_id") or tenant_id)
            columns = DB_COLLECTION_COLUMNS[table_name]
            if has_org_column and "organization_id" not in columns:
                columns = (*columns, "organization_id")
            rows = [row]
            db_fill_missing_ids(cur, table_name, rows)
            db_prepare_timestamp_columns_for_upsert(table_name, rows)
            db_upsert_rows(cur, table_name, columns, rows)
        conn.commit()

    return row


def record_login(device: dict[str, Any]) -> dict[str, Any]:
    """Login: replace the device session with DB-clock authenticated_at/last_seen_at."""
    return upsert_auth_device(device, stamp=("authenticated_at", "last_seen_at"))


def touch_auth_device(device_id: str, member_id: Any, member_fields: dict[str, Any]) -> dict[str, Any] | None:
    """Record a session check without rewinding a newer login (JST spec R08, N03).

    Only ``last_seen_at`` (monotonic, DB clock) and the member-derived columns
    are written, and only while the row still belongs to ``member_id``. A
    concurrent re-login (possibly for another member) or a logout is never
    overwritten by this older snapshot; ``None`` tells the caller to re-read.
    ``authenticated_at`` (used as the session generation by tuner/metronome)
    is never changed here.
    """
    table_name = "auth_devices"
    tenant_id = get_current_tenant_id()
    allowed = ("member_name", "member_part", "permission", "system_access_until", "is_recording_manager", "is_sheet_manager")
    values = {column: member_fields[column] for column in allowed if column in member_fields}
    with psycopg.connect(db_connection_string(), autocommit=False, connect_timeout=10) as conn:
        has_org_column = table_has_organization_id(conn, table_name)
        assignments = [psql.SQL("{} = %s").format(psql.Identifier(column)) for column in values]
        assignments.append(psql.SQL("last_seen_at = GREATEST(COALESCE(last_seen_at, clock_timestamp()), clock_timestamp())"))
        assignments.append(psql.SQL("updated_at = GREATEST(updated_at + interval '1 microsecond', clock_timestamp())"))
        where = [psql.SQL("device_id = %s"), psql.SQL("member_id IS NOT DISTINCT FROM %s")]
        params: list[Any] = [db_write_value(table_name, column, value) for column, value in values.items()]
        params.extend([device_id, db_write_value(table_name, "member_id", member_id)])
        # The same member may log in again on this device. Member ID alone
        # cannot distinguish that newer session from this stale check.
        generation_column = "authenticated_at" if member_fields.get("authenticated_at") else "created_at"
        if member_fields.get(generation_column):
            where.append(psql.SQL("{} IS NOT DISTINCT FROM %s").format(psql.Identifier(generation_column)))
            params.append(db_write_value(table_name, generation_column, member_fields[generation_column]))
        if has_org_column:
            where.insert(0, psql.SQL("organization_id = %s"))
            params.insert(len(values), tenant_id)
        with conn.cursor() as cur:
            cur.execute(
                psql.SQL("UPDATE {} SET {} WHERE {} RETURNING *").format(
                    psql.Identifier(table_name), psql.SQL(", ").join(assignments), psql.SQL(" AND ").join(where)
                ),
                tuple(params),
            )
            row = cur.fetchone()
            columns = [desc[0] for desc in cur.description] if cur.description else []
        conn.commit()
    if row is None:
        return None
    from .db_row_repository import db_row_to_json

    result = db_row_to_json(dict(zip(columns, row)), table_name)
    result.pop("organization_id", None)
    return result


def delete_auth_device(device_id: str) -> None:
    table_name = "auth_devices"
    normalized_id = str(device_id or "").strip()
    if not normalized_id:
        return
    tenant_id = get_current_tenant_id()
    with psycopg.connect(db_connection_string(), autocommit=True) as conn:
        has_org_column = table_has_organization_id(conn, table_name)
        with conn.cursor() as cur:
            if has_org_column:
                cur.execute(
                    psql.SQL("DELETE FROM {} WHERE organization_id = %s AND device_id = %s").format(
                        psql.Identifier(table_name)
                    ),
                    (tenant_id, normalized_id),
                )
            else:
                cur.execute(
                    psql.SQL("DELETE FROM {} WHERE device_id = %s").format(psql.Identifier(table_name)),
                    (normalized_id,),
                )


def replace_collection(name: str, data: list[dict[str, Any]], *, allow_bulk: bool = False) -> None:
    """Replace a whole collection (list-saved collections, migrations).

    Row-level collections refuse this in normal operation (JST spec R05): a
    whole-list write would overwrite rows written meanwhile by other
    requests. ``allow_bulk`` is only for the locked path below and explicit
    maintenance-time migrations.
    """
    if name == "promotions":
        raise HTTPException(status_code=409, detail="Promotions require the row-level API")
    if name in ROW_LEVEL_COLLECTIONS and name not in LIST_LOCKED_COLLECTIONS and not allow_bulk:
        raise HTTPException(status_code=409, detail=f"{name} requires the row-level API")
    table_name = JSON_COLLECTION_TABLES.get(name)
    if table_name not in DB_WRITABLE_COLLECTIONS:
        raise HTTPException(status_code=500, detail=f"DB write is not implemented for {name}")
    with psycopg.connect(db_connection_string(), autocommit=False, connect_timeout=10) as conn:
        _replace_collection_in(conn, name, data)
        conn.commit()


def _replace_collection_in(conn: Any, name: str, data: list[dict[str, Any]]) -> None:
    table_name = JSON_COLLECTION_TABLES[name]
    rows = db_collection_rows_for_save(name, data)
    tenant_id = get_current_tenant_id()
    has_org_column = table_has_organization_id(conn, table_name)
    with conn.cursor() as cur:
        if not rows:
            if has_org_column:
                cur.execute(psql.SQL("DELETE FROM {} WHERE organization_id = %s").format(psql.Identifier(table_name)), (tenant_id,))
            else:
                cur.execute(psql.SQL("DELETE FROM {}").format(psql.Identifier(table_name)))
            db_delete_collection_children(cur, name)
            return

        columns = DB_COLLECTION_COLUMNS[table_name]
        if has_org_column and "organization_id" not in columns:
            columns = (*columns, "organization_id")
        if has_org_column:
            for row in rows:
                row["organization_id"] = str(row.get("organization_id") or tenant_id)
        db_fill_missing_ids(cur, table_name, rows)

        kept_ids = [db_write_value(table_name, "id", item.get("id")) for item in rows if item.get("id") is not None]
        if kept_ids:
            if has_org_column:
                cur.execute(
                    psql.SQL("DELETE FROM {} WHERE organization_id = %s AND NOT (id = ANY(%s))").format(psql.Identifier(table_name)),
                    (tenant_id, kept_ids),
                )
            else:
                cur.execute(psql.SQL("DELETE FROM {} WHERE NOT (id = ANY(%s))").format(psql.Identifier(table_name)), (kept_ids,))
        else:
            if has_org_column:
                cur.execute(psql.SQL("DELETE FROM {} WHERE organization_id = %s").format(psql.Identifier(table_name)), (tenant_id,))
            else:
                cur.execute(psql.SQL("DELETE FROM {}").format(psql.Identifier(table_name)))

        if table_name == "concert_record_videos":
            _stabilize_concert_record_video_sort_orders(cur, tenant_id)

        db_upsert_rows(cur, table_name, columns, rows)
        kept_ids = [db_write_value(table_name, "id", item.get("id")) for item in rows if item.get("id") is not None]
        for child_table, child_rows in db_child_rows_for_collection(name, rows).items():
            child_has_org_column = table_has_organization_id(conn, child_table)
            child_columns = DB_CHILD_COLUMNS[child_table]
            child_parent_key = DB_CHILD_PARENT_KEYS.get(child_table)
            if not child_parent_key:
                continue
            if child_has_org_column and "organization_id" not in child_columns:
                child_columns = (*child_columns, "organization_id")
            if child_has_org_column:
                for child_row in child_rows:
                    child_row["organization_id"] = str(child_row.get("organization_id") or tenant_id)

            if kept_ids:
                if child_has_org_column:
                    cur.execute(
                        psql.SQL("DELETE FROM {} WHERE organization_id = %s AND NOT ({} = ANY(%s))").format(
                            psql.Identifier(child_table),
                            psql.Identifier(child_parent_key),
                        ),
                        (tenant_id, kept_ids),
                    )
                else:
                    cur.execute(
                        psql.SQL("DELETE FROM {} WHERE NOT ({} = ANY(%s))").format(
                            psql.Identifier(child_table),
                            psql.Identifier(child_parent_key),
                        ),
                        (kept_ids,),
                    )
            else:
                if child_has_org_column:
                    cur.execute(
                        psql.SQL("DELETE FROM {} WHERE organization_id = %s").format(psql.Identifier(child_table)),
                        (tenant_id,),
                    )
                else:
                    cur.execute(psql.SQL("DELETE FROM {}").format(psql.Identifier(child_table)))

            if child_table == "performance_pieces":
                # performance_pieces are intentionally rebuilt with fresh IDs.
                # Remove existing rows for all saved performances before inserting
                # replacements so UNIQUE (performance_id, sort_order) cannot collide.
                affected_parent_ids = list(kept_ids)
                if affected_parent_ids:
                    if child_has_org_column:
                        cur.execute(
                            psql.SQL(
                                "DELETE FROM {} WHERE organization_id = %s AND {} = ANY(%s)"
                            ).format(
                                psql.Identifier(child_table),
                                psql.Identifier(child_parent_key),
                            ),
                            (tenant_id, affected_parent_ids),
                        )
                    else:
                        cur.execute(
                            psql.SQL("DELETE FROM {} WHERE {} = ANY(%s)").format(
                                psql.Identifier(child_table),
                                psql.Identifier(child_parent_key),
                            ),
                            (affected_parent_ids,),
                        )

            if not child_rows:
                continue

            db_fill_missing_ids(cur, child_table, child_rows)
            if "id" in DB_CHILD_COLUMNS[child_table]:
                db_upsert_rows(cur, child_table, child_columns, child_rows)
                incoming_child_ids = [
                    db_write_value(child_table, "id", row.get("id"))
                    for row in child_rows
                    if row.get("id") is not None
                ]
                affected_parent_ids = list({row.get(child_parent_key) for row in child_rows if row.get(child_parent_key) is not None})
                if affected_parent_ids:
                    if incoming_child_ids:
                        if child_has_org_column:
                            cur.execute(
                                psql.SQL(
                                    "DELETE FROM {} WHERE organization_id = %s AND {} = ANY(%s) AND NOT (id = ANY(%s))"
                                ).format(psql.Identifier(child_table), psql.Identifier(child_parent_key)),
                                (tenant_id, affected_parent_ids, incoming_child_ids),
                            )
                        else:
                            cur.execute(
                                psql.SQL("DELETE FROM {} WHERE {} = ANY(%s) AND NOT (id = ANY(%s))").format(
                                    psql.Identifier(child_table),
                                    psql.Identifier(child_parent_key),
                                ),
                                (affected_parent_ids, incoming_child_ids),
                            )
                    else:
                        if child_has_org_column:
                            cur.execute(
                                psql.SQL("DELETE FROM {} WHERE organization_id = %s AND {} = ANY(%s)").format(
                                    psql.Identifier(child_table),
                                    psql.Identifier(child_parent_key),
                                ),
                                (tenant_id, affected_parent_ids),
                            )
                        else:
                            cur.execute(
                                psql.SQL("DELETE FROM {} WHERE {} = ANY(%s)").format(
                                    psql.Identifier(child_table),
                                    psql.Identifier(child_parent_key),
                                ),
                                (affected_parent_ids,),
                            )
            else:
                affected_parent_ids = list({row.get(child_parent_key) for row in child_rows if row.get(child_parent_key) is not None})
                if affected_parent_ids:
                    if child_has_org_column:
                        cur.execute(
                            psql.SQL("DELETE FROM {} WHERE organization_id = %s AND {} = ANY(%s)").format(
                                psql.Identifier(child_table),
                                psql.Identifier(child_parent_key),
                            ),
                            (tenant_id, affected_parent_ids),
                        )
                    else:
                        cur.execute(
                            psql.SQL("DELETE FROM {} WHERE {} = ANY(%s)").format(
                                psql.Identifier(child_table),
                                psql.Identifier(child_parent_key),
                            ),
                            (affected_parent_ids,),
                        )
                db_insert_rows(cur, child_table, child_columns, child_rows)


def mutate_collection_locked(name: str, mutator: Any) -> list[dict[str, Any]]:
    """Read-modify-write of a list-saved collection under one DB lock (JST spec R05, C04).

    The advisory lock ``portal:<tenant>:<name>:collection`` is the same key
    the row-level writers of a mixed collection take (db_item_repository), so
    a startup seed, a list save and a row write of the same collection never
    interleave. The list is read from the DB inside the lock (never from the
    per-process cache) and the cache entry is dropped after COMMIT.
    """
    tenant_id = get_current_tenant_id()
    generic = name not in JSON_COLLECTION_TABLES
    with psycopg.connect(db_connection_string(), autocommit=False, connect_timeout=10) as conn:
        with conn.cursor() as cur:
            cur.execute("SET LOCAL lock_timeout = '5s'")
            cur.execute("SET LOCAL statement_timeout = '15s'")
            cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"portal:{tenant_id}:{name}:collection",))
            if generic:
                cur.execute("SELECT items FROM portal_json_collections WHERE collection_name = %s FOR UPDATE", (name,))
                row = cur.fetchone()
                current = [item for item in (row[0] if row and isinstance(row[0], list) else []) if isinstance(item, dict)]
            else:
                current = attach_collection_children(
                    conn, name, db_fetch_all(conn, JSON_COLLECTION_TABLES[name], order_by=DB_COLLECTION_ORDER_BY.get(name, "id"))
                )
        updated = list(mutator([dict(item) for item in current]))
        if generic:
            payload = Jsonb(updated) if Jsonb is not None else json.dumps(updated, ensure_ascii=False)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO portal_json_collections (collection_name, items, updated_at) VALUES (%s, %s, clock_timestamp()) "
                    "ON CONFLICT (collection_name) DO UPDATE SET items = EXCLUDED.items, updated_at = clock_timestamp()",
                    (name, payload),
                )
        else:
            _replace_collection_in(conn, name, updated)
        conn.commit()
    try:
        from ..core.compat_gateway import get_memory_cache_instance

        get_memory_cache_instance().invalidate(name)
    except Exception:  # pragma: no cover - cache refresh never fails a committed save
        pass
    return updated
