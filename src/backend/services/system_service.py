from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from ..core import db_connection_string, get_memory_cache, mask_db_value
from ..core.database import db_configured
from ..core.db_runtime import db_expected, local_json_fallback_enabled
from ..core.runtime_paths import DATA_DIR, UPLOAD_DIR
from ..core.db_schema import PORTAL_DB_TABLES
from ..repositories.system_repository import SystemRepository

try:
    import psycopg
    from psycopg import sql as psql
except Exception:  # pragma: no cover - optional dependency guard
    psycopg = None
    psql = None

logger = logging.getLogger(__name__)
PROJECT_ROOT = Path(__file__).resolve().parents[3]


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


def get_readiness_summary() -> dict[str, Any]:
    data_backend = str(os.getenv("DATA_BACKEND", "db") or "db").strip().lower() or "db"
    db_ready = db_configured(psycopg, psql)
    expected_db = db_expected()
    fallback_enabled = local_json_fallback_enabled()

    app_core_path = PROJECT_ROOT / "src" / "backend" / "app_core.py"
    app_core_lines = len(app_core_path.read_text(encoding="utf-8").splitlines()) if app_core_path.exists() else 0
    app_core_budget = 520

    required_release_files = [
        PROJECT_ROOT / "scripts" / "source_zip_safety_rules.json",
        PROJECT_ROOT / "scripts" / "check_release_safety.py",
        PROJECT_ROOT / "scripts" / "check_app_core_slimming.py",
        PROJECT_ROOT / "docs" / "PRODUCTION_RELEASE_CHECKLIST.md",
        PROJECT_ROOT / "docs" / "SOURCE_SHARE_ZIP.md",
    ]
    release_missing = [str(path.relative_to(PROJECT_ROOT)).replace("\\", "/") for path in required_release_files if not path.exists()]

    checks = [
        {
            "key": "db_ready_when_expected",
            "label": "DB期待時にDB設定が有効",
            "passed": (not expected_db) or db_ready,
            "detail": "DB expected" if expected_db else "DB optional",
        },
        {
            "key": "release_files",
            "label": "リリース安全ファイルが揃っている",
            "passed": not release_missing,
            "detail": ", ".join(release_missing) if release_missing else "ok",
        },
        {
            "key": "app_core_budget",
            "label": "app_core 行数が予算内",
            "passed": app_core_lines <= app_core_budget,
            "detail": f"{app_core_lines}/{app_core_budget}",
        },
        {
            "key": "upload_dir_exists",
            "label": "アップロードディレクトリが存在",
            "passed": UPLOAD_DIR.exists(),
            "detail": str(UPLOAD_DIR),
        },
        {
            "key": "data_dir_exists",
            "label": "データディレクトリが存在",
            "passed": DATA_DIR.exists(),
            "detail": str(DATA_DIR),
        },
    ]

    overall = all(bool(item.get("passed")) for item in checks)
    return {
        "overall_status": "ok" if overall else "warning",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "runtime": {
            "data_backend": data_backend,
            "db_expected": expected_db,
            "db_ready": db_ready,
            "local_json_fallback_enabled": fallback_enabled,
        },
        "governance": {
            "app_core_lines": app_core_lines,
            "app_core_budget": app_core_budget,
            "missing_release_files": release_missing,
        },
        "checks": checks,
    }
