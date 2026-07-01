from __future__ import annotations

from fastapi import FastAPI

from .compat_gateway import get_compat_app, run_db_startup_self_check, seed_cloud_data_from_local
from .lifespan import build_lifespan
from .middleware import configure_middlewares
from .router_registry import register_routes


def create_app() -> FastAPI:
    """Create the application instance via compatibility bridge."""
    app = configure_middlewares(get_compat_app())
    app.router.lifespan_context = build_lifespan(
        startup_self_check=run_db_startup_self_check,
        seed_startup_data=seed_cloud_data_from_local,
    )
    return register_routes(app)
