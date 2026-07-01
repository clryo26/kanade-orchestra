from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header
from pydantic import BaseModel

try:
    import psycopg
    from psycopg import sql as psql
except Exception:  # pragma: no cover - optional dependency guard
    psycopg = None
    psql = None

from ..core import assert_db_ready, require_system_admin_device
from ..services.auth_service import device_auth_record
from ..services import system_service

router = APIRouter()


class RolePermissionUpdate(BaseModel):
    role_name: str
    permission_key: str
    enabled: bool = True


@router.get("/api/system/database/tables")
async def list_database_tables(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_system_admin_device(x_device_id, device_auth_record)
    assert_db_ready(psycopg, psql)
    return system_service.list_database_tables()


@router.get("/api/system/database/records")
async def list_database_records(
    table: str,
    limit: int = 50,
    offset: int = 0,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_system_admin_device(x_device_id, device_auth_record)
    assert_db_ready(psycopg, psql)
    return system_service.list_database_records(table, limit, offset)


@router.get("/api/system/database/migrations")
async def list_database_migrations(
    limit: int = 100,
    offset: int = 0,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_system_admin_device(x_device_id, device_auth_record)
    assert_db_ready(psycopg, psql)
    return system_service.list_database_migrations(limit, offset)


@router.get("/api/system/audit-logs")
async def list_audit_logs(
    limit: int = 100,
    offset: int = 0,
    actor_device_id: str = "",
    path: str = "",
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_system_admin_device(x_device_id, device_auth_record)
    assert_db_ready(psycopg, psql)
    return system_service.list_audit_logs(limit, offset, actor_device_id, path)


@router.get("/api/system/role-permissions")
async def list_role_permissions(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_system_admin_device(x_device_id, device_auth_record)
    assert_db_ready(psycopg, psql)
    return system_service.list_role_permissions()


@router.put("/api/system/role-permissions")
async def upsert_role_permission(
    body: RolePermissionUpdate,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_system_admin_device(x_device_id, device_auth_record)
    assert_db_ready(psycopg, psql)
    return system_service.upsert_role_permission(body.role_name, body.permission_key, body.enabled)


@router.post("/api/system/cache/clear")
async def clear_system_cache(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_system_admin_device(x_device_id, device_auth_record)
    return system_service.clear_system_cache()
