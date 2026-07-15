from __future__ import annotations

import os
from collections.abc import Mapping

from fastapi import FastAPI
from fastapi import Request
from fastapi.responses import JSONResponse

from .maintenance_mode import resolve_maintenance_mode
from .tenant_context import reset_current_tenant_id, set_current_tenant_id


def _normalize_tenant_id(value: str) -> str:
    tenant_id = str(value or "").strip()
    return tenant_id or os.getenv("DEFAULT_TENANT_ID", "default")


def configure_middlewares(
    app: FastAPI,
    *,
    environ: Mapping[str, str | None] | None = None,
) -> FastAPI:
    """Attach startup-fixed cross-cutting middleware in its safety order."""

    if getattr(app.state, "maintenance_mode_configured", False):
        return app

    # Resolve once before mutating the middleware stack so invalid startup
    # configuration cannot leave a partially configured application behind.
    maintenance = resolve_maintenance_mode(os.environ if environ is None else environ)
    app.state.maintenance_mode_enabled = maintenance.enabled
    app.state.maintenance_mode_status = maintenance.status

    if not getattr(app.state, "tenant_context_middleware_attached", False):

        @app.middleware("http")
        async def tenant_context_middleware(request: Request, call_next):
            tenant_header = (
                request.headers.get("X-Organization-Id") or request.headers.get("X-Tenant-Id") or ""
            )
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

    if not getattr(app.state, "maintenance_mode_middleware_attached", False):

        @app.middleware("http")
        async def maintenance_mode_middleware(request: Request, call_next):
            if maintenance.enabled and not (
                request.method.upper() == "GET" and request.url.path == "/api/health"
            ):
                # Keep the public response deliberately generic; restore targets
                # and other operational details must never cross this boundary.
                return JSONResponse(
                    status_code=503,
                    content={"detail": "Service temporarily unavailable"},
                    headers={"Retry-After": "60", "Cache-Control": "no-store"},
                )
            return await call_next(request)

        app.state.maintenance_mode_middleware_attached = True

    app.state.maintenance_mode_configured = True
    return app
