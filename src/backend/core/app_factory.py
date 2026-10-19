from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ..utils.datetime_utils import FutureVersionAnomaly, InvalidDateTimeValue
from .compat_gateway import get_compat_app, run_db_startup_self_check, seed_cloud_data_from_local
from .db_pool import close_db_pool, open_db_pool
from .lifespan import build_lifespan
from .middleware import configure_middlewares
from .router_registry import register_routes

logger = logging.getLogger(__name__)


async def _invalid_datetime_handler(_request: Request, exc: Exception) -> JSONResponse:
    # Only the field name and the reason are returned; never the raw value.
    error = exc if isinstance(exc, InvalidDateTimeValue) else InvalidDateTimeValue("datetime", "invalid")
    return JSONResponse(status_code=422, content={"detail": f"{error.field}: {error.reason}"})


async def _future_version_handler(_request: Request, exc: Exception) -> JSONResponse:
    # R07: a stored version far in the future stops normal updates. Admins
    # investigate from the log; users only see that the save failed.
    if isinstance(exc, FutureVersionAnomaly):
        logger.error("Stored version is in the future: table=%s id=%s", exc.table, exc.item_id)
    return JSONResponse(
        status_code=503,
        content={"detail": {"code": "version_clock_anomaly", "message": "保存できませんでした。管理者に連絡してください"}},
        headers={"Cache-Control": "no-store"},
    )


def register_datetime_error_handlers(app: FastAPI) -> FastAPI:
    app.add_exception_handler(InvalidDateTimeValue, _invalid_datetime_handler)
    app.add_exception_handler(FutureVersionAnomaly, _future_version_handler)
    return app


def create_app() -> FastAPI:
    """Create the application instance via compatibility bridge."""
    app = configure_middlewares(get_compat_app())
    app.router.lifespan_context = build_lifespan(
        startup_self_check=run_db_startup_self_check,
        seed_startup_data=seed_cloud_data_from_local,
        open_db_pool=open_db_pool,
        close_db_pool=close_db_pool,
    )
    register_datetime_error_handlers(app)
    return register_routes(app)
