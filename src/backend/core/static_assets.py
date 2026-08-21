from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles


class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: dict[str, Any]) -> Response:
        response = await super().get_response(path, scope)
        if path.endswith((".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".webmanifest", ".ico")):
                query_string = scope.get("query_string", b"").decode("ascii", errors="ignore")
                has_revision = any(part.startswith("rev=") for part in query_string.split("&"))
                if has_revision:
                    # Revisioned URLs are content-addressed by deployment revision.
                    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
                else:
                    # Dynamically injected assets may not have the index rewrite's rev query.
                    response.headers["Cache-Control"] = "public, max-age=3600"
        else:
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
        return response


def mount_static_files(app: FastAPI, directory: Any) -> None:
    app.mount("/static", NoCacheStaticFiles(directory=directory), name="static")
