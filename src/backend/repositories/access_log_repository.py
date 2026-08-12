from __future__ import annotations

from datetime import datetime
from typing import Any

import psycopg
from psycopg import sql as psql

from ..core.db_schema import DB_COLLECTION_COLUMNS
from ..core.tenant_context import get_current_tenant_id
from ..db.database import db_connection_string
from .db_row_repository import db_row_to_json, db_row_tuple, table_has_organization_id


ACCESS_LOG_PAGE_SIZE = 100


def insert_access_log(payload: dict[str, Any]) -> dict[str, Any]:
    table_name = "access_logs"
    tenant_id = get_current_tenant_id()
    result = dict(payload)
    result.pop("organization_id", None)

    with psycopg.connect(db_connection_string(), autocommit=False) as conn:
        has_org_column = table_has_organization_id(conn, table_name)
        columns = tuple(
            column for column in DB_COLLECTION_COLUMNS[table_name] if column != "id"
        )
        row = dict(payload)
        row.pop("id", None)

        if has_org_column:
            row["organization_id"] = tenant_id
            if "organization_id" not in columns:
                columns = (*columns, "organization_id")

        insert_query = psql.SQL(
            "INSERT INTO {} ({}) VALUES ({}) RETURNING id"
        ).format(
            psql.Identifier(table_name),
            psql.SQL(", ").join(psql.Identifier(column) for column in columns),
            psql.SQL(", ").join(psql.Placeholder() for _ in columns),
        )

        with conn.cursor() as cur:
            cur.execute(insert_query, db_row_tuple(table_name, columns, row))
            inserted = cur.fetchone()
            if not inserted:
                raise RuntimeError("Access log insert did not return an id")
            result["id"] = int(inserted[0])

        conn.commit()

    return result


def query_access_logs(
    *,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    member_id: int | None = None,
    member_part: str = "",
    page: int = 1,
) -> dict[str, Any]:
    table_name = "access_logs"
    tenant_id = get_current_tenant_id()
    safe_page = max(int(page or 1), 1)
    normalized_part = str(member_part or "").strip()

    with psycopg.connect(db_connection_string(), autocommit=True) as conn:
        has_org_column = table_has_organization_id(conn, table_name)
        conditions: list[Any] = []
        params: list[Any] = []

        if has_org_column:
            conditions.append(psql.SQL("organization_id = %s"))
            params.append(tenant_id)
        if date_from is not None:
            conditions.append(psql.SQL("accessed_at >= %s"))
            params.append(date_from)
        if date_to is not None:
            conditions.append(psql.SQL("accessed_at < %s"))
            params.append(date_to)
        if member_id is not None:
            conditions.append(psql.SQL("member_id = %s"))
            params.append(member_id)
        if normalized_part:
            conditions.append(psql.SQL("member_part = %s"))
            params.append(normalized_part)

        where_sql = psql.SQL("")
        if conditions:
            where_sql = psql.SQL(" WHERE ") + psql.SQL(" AND ").join(conditions)

        count_query = psql.SQL("SELECT COUNT(*) FROM {}{}").format(
            psql.Identifier(table_name),
            where_sql,
        )
        with conn.cursor() as cur:
            cur.execute(count_query, tuple(params))
            count_row = cur.fetchone()
            total = int(count_row[0]) if count_row else 0

        total_pages = max(
            (total + ACCESS_LOG_PAGE_SIZE - 1) // ACCESS_LOG_PAGE_SIZE,
            1,
        )
        safe_page = min(safe_page, total_pages)
        offset = (safe_page - 1) * ACCESS_LOG_PAGE_SIZE

        list_query = psql.SQL(
            "SELECT * FROM {}{} ORDER BY accessed_at DESC, id DESC LIMIT %s OFFSET %s"
        ).format(
            psql.Identifier(table_name),
            where_sql,
        )
        list_params = [*params, ACCESS_LOG_PAGE_SIZE, offset]

        with conn.cursor() as cur:
            cur.execute(list_query, tuple(list_params))
            rows = cur.fetchall()
            columns = [desc[0] for desc in cur.description]

    items = [db_row_to_json(dict(zip(columns, row))) for row in rows]
    return {
        "items": items,
        "page": safe_page,
        "page_size": ACCESS_LOG_PAGE_SIZE,
        "total": total,
        "total_pages": total_pages,
    }
