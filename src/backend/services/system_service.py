from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

from ..core import db_connection_string, get_memory_cache, mask_db_value
from ..core.database import db_configured
from ..core.db_schema import PORTAL_DB_TABLES
from ..repositories.system_repository import SystemRepository

try:
    import psycopg
    from psycopg import sql as psql
except Exception:  # pragma: no cover - optional dependency guard
    psycopg = None
    psql = None

logger = logging.getLogger(__name__)


def _repository() -> SystemRepository:
    return SystemRepository(db_connection_string())


def validate_paging(limit: int, offset: int) -> None:
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 500")
    if offset < 0:
        raise HTTPException(status_code=400, detail="offset must be >= 0")


def list_database_tables() -> dict[str, Any]:
    tables = _repository().list_tables(PORTAL_DB_TABLES)
    return {"tables": tables, "total": len(tables)}


def list_database_records(table: str, limit: int, offset: int) -> dict[str, Any]:
    normalized_table = str(table or "").strip()
    if not normalized_table:
        raise HTTPException(status_code=400, detail="table is required")
    if normalized_table not in PORTAL_DB_TABLES:
        raise HTTPException(status_code=404, detail="table not found")
    validate_paging(limit, offset)

    column_names, fetched, total = _repository().list_table_records(normalized_table, limit, offset)
    if not column_names:
        raise HTTPException(status_code=404, detail="table not found")

    rows: list[dict[str, Any]] = []
    for values in fetched:
        item: dict[str, Any] = {}
        for idx, col_name in enumerate(column_names):
            item[col_name] = mask_db_value(col_name, values[idx])
        rows.append(item)

    return {
        "table": normalized_table,
        "columns": column_names,
        "rows": rows,
        "limit": limit,
        "offset": offset,
        "total": total,
    }


def list_database_migrations(limit: int, offset: int) -> dict[str, Any]:
    validate_paging(limit, offset)
    rows, total = _repository().list_migrations(limit, offset)
    return {"items": rows, "total": total, "limit": limit, "offset": offset}


def list_audit_logs(limit: int, offset: int, actor_device_id: str = "", path: str = "") -> dict[str, Any]:
    validate_paging(limit, offset)
    rows, total = _repository().list_audit_logs(limit, offset, actor_device_id, path)
    return {"items": rows, "total": total, "limit": limit, "offset": offset}


def list_role_permissions() -> dict[str, Any]:
    rows = _repository().list_role_permissions()
    return {"items": rows, "total": len(rows)}


def upsert_role_permission(role_name: str, permission_key: str, enabled: bool) -> dict[str, Any]:
    role_name = role_name.strip()
    permission_key = permission_key.strip()
    if not role_name or not permission_key:
        raise HTTPException(status_code=400, detail="role_name and permission_key are required")
    _repository().upsert_role_permission(role_name, permission_key, enabled)
    return {
        "status": "ok",
        "role_name": role_name,
        "permission_key": permission_key,
        "enabled": enabled,
    }


def clear_system_cache() -> dict[str, Any]:
    get_memory_cache().invalidate()
    if db_configured(psycopg, psql):
        try:
            _repository().record_cache_invalidation("*", "manual_clear")
        except Exception:
            logger.exception("Failed to record cache invalidation event")
    return {"status": "ok"}
