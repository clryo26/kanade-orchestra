from __future__ import annotations

from importlib import import_module

from fastapi import FastAPI


def _import_router(relative_module: str, legacy_module: str):
    try:
        module = import_module(relative_module, package=__package__)
        return module.router
    except ModuleNotFoundError as exc:
        # Only fallback for top-level module path resolution issues.
        if exc.name not in {"src", "src.backend", "src.backend.routers", "src.backend.auth_api", "routers", "auth_api"}:
            raise
    except ImportError as exc:
        # Relative import may fail when executed as a plain script without package context.
        if "attempted relative import" not in str(exc):
            raise

    module = import_module(legacy_module)
    return module.router


def register_routes(app: FastAPI) -> FastAPI:
    if getattr(app.state, "routes_registered", False):
        return app

    access_logs_router = _import_router("..routers.access_logs", "routers.access_logs")
    bootstrap_router = _import_router("..routers.bootstrap", "routers.bootstrap")
    albums_router = _import_router("..routers.albums", "routers.albums")
    announcements_router = _import_router("..routers.announcements", "routers.announcements")
    events_router = _import_router("..routers.events", "routers.events")
    maintenance_router = _import_router("..routers.maintenance", "routers.maintenance")
    members_router = _import_router("..routers.members", "routers.members")
    meta_router = _import_router("..routers.meta", "routers.meta")
    performances_router = _import_router("..routers.performances", "routers.performances")
    recordings_router = _import_router("..routers.recordings", "routers.recordings")
    schedules_router = _import_router("..routers.schedules", "routers.schedules")
    scores_router = _import_router("..routers.scores", "routers.scores")
    system_router = _import_router("..routers.system", "routers.system")
    auth_router = _import_router("..auth_api", "auth_api")

    for router in (
        performances_router,
        schedules_router,
        members_router,
        events_router,
        announcements_router,
        recordings_router,
        scores_router,
        albums_router,
        system_router,
        access_logs_router,
        maintenance_router,
        bootstrap_router,
        meta_router,
        auth_router,
    ):
        app.include_router(router)

    app.state.routes_registered = True
    return app
