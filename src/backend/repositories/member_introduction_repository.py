"""Read projection for introductions; no shared collection/cache changes."""
from __future__ import annotations

from typing import Any

from ..core.read_context import repository_read_connection
from ..core.db_config import db_connection_string
from ..core.db_pool import pooled_psycopg as psycopg
from ..core.db_runtime import local_json_fallback_enabled
from ..core.tenant_context import get_current_tenant_id
from .db_row_repository import db_row_to_json, table_has_organization_id

FIELDS = ("id", "name", "last_name", "first_name", "maiden_name", "last_name_kana",
          "first_name_kana", "part", "is_founder", "joined_at", "introducer", "role",
          "instrument_history", "past_orchestras", "comment", "photo_url")


def list_introductions(*, connection=None) -> list[dict[str, Any]]:
    if local_json_fallback_enabled():
        from ..core.compat_gateway import row_store
        return [dict(item) for item in row_store().list("members") if item.get("permission") != "エキストラ"]
    # Whitelist columns; never transfer inline base64 or private member fields
    # from DB to the application merely to discard them in a serializer.
    columns = ", ".join('"' + f + '"' for f in FIELDS if f != "photo_url")
    columns += ", CASE WHEN photo_url LIKE 'data:image/%%' THEN '/api/members/' || id::text || '/photo' ELSE COALESCE(photo_url,'') END AS photo_url"
    with repository_read_connection(connection, factory=lambda: psycopg.connect(db_connection_string(), autocommit=True, connect_timeout=10)) as conn:
        tenant_clause = "organization_id = %s AND " if table_has_organization_id(conn, "members") else ""
        with conn.cursor() as cur:
            cur.execute(f"SELECT {columns} FROM members WHERE {tenant_clause}COALESCE(permission,'') <> 'エキストラ' ORDER BY id",
                        (get_current_tenant_id(),) if tenant_clause else ())
            names = [d[0] for d in cur.description]
            return [db_row_to_json(dict(zip(names, row)), "members") for row in cur.fetchall()]
