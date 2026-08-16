from __future__ import annotations

import json
import logging
import os
from typing import Any

try:
    from ..core.db_pool import pooled_psycopg as psycopg
    from psycopg import sql as psql
except Exception:  # pragma: no cover - optional dependency guard
    psycopg = None  # type: ignore[assignment]
    psql = None

from ..core.database import db_configured
from ..core.db_config import db_connection_string
from ..services.auth_service import device_auth_record
from ..utils.serialization import fk_int

logger = logging.getLogger(__name__)

MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def audit_db_connect_timeout() -> int:
    try:
        return max(1, int(os.getenv("AUDIT_DB_CONNECT_TIMEOUT_SECONDS", "2")))
    except ValueError:
        return 2


def audit_enabled() -> bool:
    return os.getenv("AUDIT_LOG_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"}


def should_audit(method: str, path: str) -> bool:
    if not audit_enabled():
        return False
    if method.upper() not in MUTATING_METHODS:
        return False
    if path.startswith("/api/system/audit-logs"):
        return False
    return path.startswith("/api/")


def infer_action(method: str, path: str) -> str:
    method = method.upper()
    if method == "POST":
        return "create_or_execute"
    if method in {"PUT", "PATCH"}:
        return "update"
    if method == "DELETE":
        return "delete"
    return method.lower()


def infer_target(path: str) -> tuple[str, str]:
    parts = [part for part in path.split("/") if part]
    if len(parts) < 2:
        return "", ""
    target = parts[1]
    target_id = parts[2] if len(parts) >= 3 else ""
    return target, target_id


def write_audit_log(
    *,
    method: str,
    path: str,
    status_code: int | None,
    device_id: str,
    user_agent: str,
    ip_address: str,
    request_id: str = "",
    detail: dict[str, Any] | None = None,
) -> None:
    if not should_audit(method, path):
        return
    try:
        if not db_configured(psycopg, psql):
            return
        actor: dict[str, Any] = {}
        if device_id:
            try:
                actor = device_auth_record(device_id)
            except Exception:
                actor = {}
        target_table, target_id = infer_target(path)
        with psycopg.connect(db_connection_string(), autocommit=True, connect_timeout=audit_db_connect_timeout()) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO audit_logs (
                        actor_device_id,
                        actor_member_id,
                        actor_member_name,
                        actor_permission,
                        action,
                        method,
                        path,
                        status_code,
                        target_table,
                        target_id,
                        request_id,
                        user_agent,
                        ip_address,
                        detail
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        device_id or "",
                        fk_int(actor.get("member_id")),
                        str(actor.get("member_name") or actor.get("name") or ""),
                        str(actor.get("permission") or ""),
                        infer_action(method, path),
                        method.upper(),
                        path,
                        status_code,
                        target_table,
                        target_id,
                        request_id,
                        user_agent,
                        ip_address,
                        json.dumps(detail or {}, ensure_ascii=False),
                    ),
                )
    except Exception:
        logger.exception("Failed to write audit log")


def write_diagnostic_access_log(
    *,
    path: str,
    status_code: int | None,
    device_id: str,
    user_agent: str,
    ip_address: str,
    request_id: str = "",
    detail: dict[str, Any] | None = None,
) -> None:
    try:
        if not audit_enabled():
            return
        if not db_configured(psycopg, psql):
            return

        actor: dict[str, Any] = {}
        if device_id:
            try:
                actor = device_auth_record(device_id)
            except Exception:
                actor = {}

        with psycopg.connect(db_connection_string(), autocommit=True, connect_timeout=audit_db_connect_timeout()) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO audit_logs (
                        actor_device_id,
                        actor_member_id,
                        actor_member_name,
                        actor_permission,
                        action,
                        method,
                        path,
                        status_code,
                        target_table,
                        target_id,
                        request_id,
                        user_agent,
                        ip_address,
                        detail
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        device_id or "",
                        fk_int(actor.get("member_id")),
                        str(actor.get("member_name") or actor.get("name") or ""),
                        str(actor.get("permission") or ""),
                        "diagnostic_view",
                        "GET",
                        path,
                        status_code,
                        "diagnostic",
                        "config-status",
                        request_id,
                        user_agent,
                        ip_address,
                        json.dumps(detail or {}, ensure_ascii=False),
                    ),
                )
    except Exception:
        logger.exception("Failed to write diagnostic access log")
