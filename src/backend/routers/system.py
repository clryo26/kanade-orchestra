from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

try:
    import psycopg
    from psycopg import sql as psql
except Exception:  # pragma: no cover - optional dependency guard
    psycopg = None
    psql = None

from ..core import assert_db_ready
from ..core.auth_dependencies import get_production_operation_auth, get_system_admin_device_auth
from ..services import system_service
from ..services import production_ops_service

router = APIRouter()


class RolePermissionUpdate(BaseModel):
    role_name: str
    permission_key: str
    enabled: bool = True


class PromoteRequest(BaseModel):
    target_git_sha: str
    target_image_digest: str = ""


class ProdToTestSyncRequest(BaseModel):
    target_git_sha: str = ""


@router.get("/api/system/database/tables")
async def list_database_tables(_system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth)) -> dict[str, Any]:
    assert_db_ready(psycopg, psql)
    return system_service.list_database_tables()


@router.get("/api/system/database/records")
async def list_database_records(
    table: str,
    limit: int = 50,
    offset: int = 0,
    _system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, Any]:
    assert_db_ready(psycopg, psql)
    return system_service.list_database_records(table, limit, offset)


@router.get("/api/system/database/migrations")
async def list_database_migrations(
    limit: int = 100,
    offset: int = 0,
    _system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, Any]:
    assert_db_ready(psycopg, psql)
    return system_service.list_database_migrations(limit, offset)


@router.get("/api/system/audit-logs")
async def list_audit_logs(
    limit: int = 100,
    offset: int = 0,
    actor_device_id: str = "",
    path: str = "",
    _system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, Any]:
    assert_db_ready(psycopg, psql)
    return system_service.list_audit_logs(limit, offset, actor_device_id, path)


@router.get("/api/system/role-permissions")
async def list_role_permissions(_system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth)) -> dict[str, Any]:
    assert_db_ready(psycopg, psql)
    return system_service.list_role_permissions()


@router.put("/api/system/role-permissions")
async def upsert_role_permission(
    body: RolePermissionUpdate,
    _system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, Any]:
    assert_db_ready(psycopg, psql)
    return system_service.upsert_role_permission(body.role_name, body.permission_key, body.enabled)


@router.post("/api/system/cache/clear")
async def clear_system_cache(_system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth)) -> dict[str, Any]:
    return system_service.clear_system_cache()


@router.get("/api/system/readiness-summary")
async def get_readiness_summary(_system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth)) -> dict[str, Any]:
    return system_service.get_readiness_summary()


@router.get("/api/system/environment/status")
async def get_environment_status(_authorized_device: dict[str, Any] = Depends(get_production_operation_auth)) -> dict[str, Any]:
    return production_ops_service.environment_status()


@router.get("/api/system/release/history")
async def get_release_history(_authorized_device: dict[str, Any] = Depends(get_production_operation_auth)) -> dict[str, Any]:
    return production_ops_service.list_release_history()


@router.post("/api/system/release/promote")
async def promote_release(
    payload: PromoteRequest,
    authorized_device: dict[str, Any] = Depends(get_production_operation_auth),
) -> dict[str, Any]:
    result = production_ops_service.request_release_promote(
        device=authorized_device,
        target_git_sha=payload.target_git_sha,
        target_image_digest=payload.target_image_digest,
    )
    if not result.get("accepted"):
        raise HTTPException(status_code=503, detail=str(result.get("message") or "本番リリース実行に失敗しました"))
    return result


@router.get("/api/system/sync/history")
async def get_sync_history(_authorized_device: dict[str, Any] = Depends(get_production_operation_auth)) -> dict[str, Any]:
    return production_ops_service.list_sync_history()


@router.post("/api/system/sync/prod-to-test")
async def sync_prod_to_test(
    payload: ProdToTestSyncRequest,
    authorized_device: dict[str, Any] = Depends(get_production_operation_auth),
) -> dict[str, Any]:
    result = production_ops_service.request_sync_prod_to_test(
        device=authorized_device,
        target_git_sha=payload.target_git_sha,
    )
    if not result.get("accepted"):
        raise HTTPException(status_code=503, detail=str(result.get("message") or "本番データ同期実行に失敗しました"))
    return result
