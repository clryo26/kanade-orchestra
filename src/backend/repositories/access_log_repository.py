from __future__ import annotations

from typing import Any

import psycopg
from psycopg import sql as psql

from ..core.db_schema import DB_COLLECTION_COLUMNS
from ..core.tenant_context import get_current_tenant_id
from ..db.database import db_connection_string
from .db_row_repository import db_row_tuple, table_has_organization_id


def insert_access_log(payload: dict[str, Any], max_items: int = 2000) -> dict[str, Any]:
    table_name = "access_logs"
    tenant_id = get_current_tenant_id()
    safe_max_items = max(int(max_items), 1)
    result = dict(payload)
    result.pop("organization_id", None)

    with psycopg.connect(db_connection_string(), autocommit=False) as conn:
        has_org_column = table_has_organization_id(conn, table_name)
        columns = tuple(column for column in DB_COLLECTION_COLUMNS[table_name] if column != "id")
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

            if has_org_column:
                cur.execute(
                    psql.SQL(
                        """
                        DELETE FROM {}
                        WHERE organization_id = %s
                          AND id IN (
                              SELECT id
                              FROM {}
                              WHERE organization_id = %s
                              ORDER BY accessed_at DESC, id DESC
                              OFFSET %s
                          )
                        """
                    ).format(
                        psql.Identifier(table_name),
                        psql.Identifier(table_name),
                    ),
                    (tenant_id, tenant_id, safe_max_items),
                )
            else:
                cur.execute(
                    psql.SQL(
                        """
                        DELETE FROM {}
                        WHERE id IN (
                            SELECT id
                            FROM {}
                            ORDER BY accessed_at DESC, id DESC
                            OFFSET %s
                        )
                        """
                    ).format(
                        psql.Identifier(table_name),
                        psql.Identifier(table_name),
                    ),
                    (safe_max_items,),
                )

        conn.commit()

    return result
