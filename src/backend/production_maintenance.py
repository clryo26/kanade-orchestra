"""Standalone entry point: deliberately imports no app, DB, or startup hooks."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def maintenance(request: Request, call_next):
    if request.method == "GET" and request.url.path == "/api/health":
        return JSONResponse({"status": "ok", "mode": "production-maintenance"}, headers={"Cache-Control": "no-store"})
    return JSONResponse({"detail": "メンテナンス中です。しばらくしてから再度お試しください"}, status_code=503,
                        headers={"Cache-Control": "no-store", "Retry-After": "300"})
