from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .audit_middleware import create_audit_log_middleware
from .static_assets import mount_static_files


def create_base_app(*, logger: Any, static_dir: Path, cors_origins: list[str]) -> FastAPI:
    app = FastAPI(
        title="Orchestra Activity Tool",
        description="Performance, practice schedule, announcement, and recording management.",
        version="1.0.0",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.middleware("http")(create_audit_log_middleware(logger))
    mount_static_files(app, static_dir)
    return app
