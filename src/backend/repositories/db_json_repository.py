from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException

try:
    import psycopg
    from psycopg import sql as psql
    from psycopg.types.json import Jsonb
except Exception:  # pragma: no cover - optional dependency guard
    psycopg = None
    psql = None
    Jsonb = None

from ..core.db_schema import (
    DB_CHILD_COLUMNS,
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
        if name == "performances":
            pieces = db_fetch_all(conn, "performance_pieces", order_by="sort_order")
            by_performance: dict[Any, list[dict[str, Any]]] = {}
            for piece in pieces:
                by_performance.setdefault(piece.get("performance_id"), []).append(piece)
            for item in items:
                item["pieces"] = by_performance.get(item.get("id"), [])
        elif name == "concert_record_videos":
            items.sort(
                key=lambda item: (
                    int(item.get("performance_id") or 0),
                    int(item.get("sort_order") or 0),
                    int(item.get("id") or 0),
                )
            )
        elif name == "date_adjustments":
            candidates = db_fetch_all(conn, "date_adjustment_candidates", order_by="sort_order")
            by_adjustment: dict[Any, list[dict[str, Any]]] = {}
            for candidate in candidates:
                candidate["id"] = candidate.get("candidate_key") or candidate.get("id")
                by_adjustment.setdefault(candidate.get("adjustment_id"), []).append(candidate)
            for item in items:
                item["candidates"] = by_adjustment.get(item.get("id"), [])
        elif name == "payments":
            fees = db_fetch_all(conn, "payment_performance_fees", order_by="")
            by_payment: dict[Any, list[dict[str, Any]]] = {}
            for fee in fees:
                by_payment.setdefault(fee.get("payment_id"), []).append(fee)
            for item in items:
                performance_fees: dict[str, bool] = {}
                performance_fee_amounts: dict[str, Any] = {}
                for fee in by_payment.get(item.get("id"), []):
                    performance_id = str(fee.get("performance_id"))
                    performance_fees[performance_id] = bool(fee.get("is_paid"))
                    performance_fee_amounts[performance_id] = fee.get("fee_amount")
                item["performance_fees"] = performance_fees
                item["performance_fee_amounts"] = performance_fee_amounts
        elif name == "castings":
            casting_members = db_fetch_all(conn, "casting_members", order_by="sort_order")
            casting_extras = db_fetch_all(conn, "casting_extras", order_by="sort_order")
            members_by_casting: dict[Any, list[dict[str, Any]]] = {}
            extras_by_casting: dict[Any, list[dict[str, Any]]] = {}
            for member in casting_members:
                members_by_casting.setdefault(member.get("casting_id"), []).append(member)
            for extra in casting_extras:
                extras_by_casting.setdefault(extra.get("casting_id"), []).append(extra)
            for item in items:
                item["members"] = members_by_casting.get(item.get("id"), [])
                item["extras"] = extras_by_casting.get(item.get("id"), [])
        elif name == "desired_pieces":
            votes = db_fetch_all(conn, "desired_piece_votes", order_by="id")
            by_piece: dict[Any, list[dict[str, Any]]] = {}
            for vote in votes:
                by_piece.setdefault(vote.get("desired_piece_id"), []).append(vote)
            for item in items:
                item["votes"] = by_piece.get(item.get("id"), [])
        elif name == "albums":
            photos = db_fetch_all(conn, "album_photos", order_by="id")
            by_album: dict[Any, list[dict[str, Any]]] = {}
            for photo in photos:
                by_album.setdefault(photo.get("album_id"), []).append(photo)
            for item in items:
                item["photos"] = by_album.get(item.get("id"), [])
        return items


def upsert_auth_device(device: dict[str, Any]) -> dict[str, Any]:
    table_name = "auth_devices"
    tenant_id = get_current_tenant_id()
    row = dict(device)
    device_id = str(row.get("device_id") or "").strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required")

    with psycopg.connect(db_connection_string(), autocommit=False) as conn:
        has_org_column = table_has_organization_id(conn, table_name)
        with conn.cursor() as cur:
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


def replace_collection(name: str, data: list[dict[str, Any]]) -> None:
    table_name = JSON_COLLECTION_TABLES.get(name)
    if table_name not in DB_WRITABLE_COLLECTIONS:
        raise HTTPException(status_code=500, detail=f"DB write is not implemented for {name}")

    rows = db_collection_rows_for_save(name, data)
    tenant_id = get_current_tenant_id()
    with psycopg.connect(db_connection_string(), autocommit=False) as conn:
        has_org_column = table_has_organization_id(conn, table_name)
        with conn.cursor() as cur:
            db_delete_collection_children(cur, name)
            if not rows:
                if has_org_column:
                    cur.execute(psql.SQL("DELETE FROM {} WHERE organization_id = %s").format(psql.Identifier(table_name)), (tenant_id,))
                else:
                    cur.execute(psql.SQL("DELETE FROM {}").format(psql.Identifier(table_name)))
                conn.commit()
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
            for child_table, child_rows in db_child_rows_for_collection(name, rows).items():
                child_has_org_column = table_has_organization_id(conn, child_table)
                child_columns = DB_CHILD_COLUMNS[child_table]
                if child_has_org_column and "organization_id" not in child_columns:
                    child_columns = (*child_columns, "organization_id")
                if child_has_org_column:
                    for child_row in child_rows:
                        child_row["organization_id"] = str(child_row.get("organization_id") or tenant_id)
                db_fill_missing_ids(cur, child_table, child_rows)
                db_insert_rows(cur, child_table, child_columns, child_rows)
        conn.commit()
