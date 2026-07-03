from __future__ import annotations

import json
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


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
        from .. import app_core

        if not app_core.db_configured():
            return
        actor: dict[str, Any] = {}
        if device_id:
            try:
                actor = app_core.device_auth_record(device_id)
            except Exception:
                actor = {}
        target_table, target_id = infer_target(path)
        with app_core.psycopg.connect(app_core.db_connection_string(), autocommit=True) as conn:
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
                        app_core.fk_int(actor.get("member_id")),
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
