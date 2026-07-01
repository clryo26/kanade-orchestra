from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi import Request

from .tenant_context import reset_current_tenant_id, set_current_tenant_id


def _normalize_tenant_id(value: str) -> str:
    tenant_id = str(value or "").strip()
    return tenant_id or os.getenv("DEFAULT_TENANT_ID", "default")


def configure_middlewares(app: FastAPI) -> FastAPI:
    """Attach cross-cutting middlewares that are safe with legacy app_core.

    We keep this middleware non-breaking by only attaching tenant context to
    request.state without changing auth or routing behavior.
    """

    if getattr(app.state, "tenant_context_middleware_attached", False):
        return app

    @app.middleware("http")
    async def tenant_context_middleware(request: Request, call_next):
        tenant_header = request.headers.get("X-Organization-Id") or request.headers.get("X-Tenant-Id") or ""
        tenant_id = _normalize_tenant_id(tenant_header)
        request.state.tenant_context = {
            "tenant_id": tenant_id,
            "source": "header" if tenant_header else "default",
        }
        token = set_current_tenant_id(tenant_id)
        try:
            response = await call_next(request)
        finally:
            reset_current_tenant_id(token)
        response.headers.setdefault("X-Tenant-Id", tenant_id)
        return response

    app.state.tenant_context_middleware_attached = True
    return app
