from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import Request


def create_audit_log_middleware(logger: Any):
    async def audit_log_middleware(request: Request, call_next: Callable[..., Any]):
        response = None
        try:
            response = await call_next(request)
            return response
        finally:
            try:
                from ..services.audit_service import should_audit, write_audit_log

                path = request.url.path
                method = request.method.upper()
                if should_audit(method, path):
                    write_audit_log(
                        method=method,
                        path=path,
                        status_code=getattr(response, "status_code", None),
                        device_id=request.headers.get("X-Device-Id", ""),
                        user_agent=request.headers.get("User-Agent", ""),
                        ip_address=request.client.host if request.client else "",
                        request_id=request.headers.get("X-Request-Id", ""),
                        detail={"query": str(request.url.query or "")},
                    )
            except Exception:
                logger.exception("Audit middleware failed")

    return audit_log_middleware
