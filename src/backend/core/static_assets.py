from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles


class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: dict[str, Any]) -> Response:
        response = await super().get_response(path, scope)
        if path.endswith((".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".webmanifest", ".ico")):
            response.headers["Cache-Control"] = "public, max-age=3600"
        else:
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
        return response


def mount_static_files(app: FastAPI, directory: Any) -> None:
    app.mount("/static", NoCacheStaticFiles(directory=directory), name="static")
