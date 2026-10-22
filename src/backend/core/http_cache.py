"""PERF-R01: validators over the serialized representation, before GZip.

This does not skip repository reads or response validation. DB generation
shortcuts belong to stage 3; the route wrapper must preserve existing bodies.
"""
from __future__ import annotations

import hashlib
import re

from fastapi import Request
from fastapi.routing import APIRoute
from starlette.responses import Response

from .tenant_context import get_current_tenant_id
from ..utils.datetime_utils import API_DATETIME_FORMAT_VERSION

LIST_CACHE_PATHS = frozenset({
    "/api/performances", "/api/schedules", "/api/announcements", "/api/events", "/api/members",
})
PRIVATE_CACHE_PATHS = LIST_CACHE_PATHS | {"/api/bootstrap-lite", "/api/bootstrap-core", "/api/member-introductions"}
PRIVATE_VARY = ("X-Device-Id", "X-Organization-Id", "X-Tenant-Id")


def merge_vary(response: Response) -> None:
    values = [value.strip() for value in response.headers.get("Vary", "").split(",") if value.strip()]
    if "*" in values:
        return
    for name in PRIVATE_VARY:
        if name.lower() not in {value.lower() for value in values}:
            values.append(name)
    response.headers["Vary"] = ", ".join(values)


def etag_matches(value: str, etag: str) -> bool:
    """GET uses weak comparison; quoted commas remain part of an opaque tag.

    Existing v1 bootstrap validators were unquoted hashes. Keep their exact
    match as a compatibility case without treating arbitrary text as a tag.
    """
    value = value.strip()
    if value == "*":
        return True
    if not etag.startswith(('"', 'W/"')):
        if value == etag:
            return True
        etag = f'"{etag}"'
    current = etag.removeprefix("W/")
    tag_pattern = r'(?:W/)?"[\x21\x23-\x7e\x80-\xff]*"'
    if not re.fullmatch(rf'{tag_pattern}(?:\s*,\s*{tag_pattern})*', value):
        return False
    return any(tag.removeprefix("W/") == current for tag in re.findall(tag_pattern, value))


class PortalCacheRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            from .collection_clock_schema import configured_paths
            from .db_runtime import local_json_fallback_enabled
            reads, _ = configured_paths()
            if request.method == "GET" and request.url.path in reads and not local_json_fallback_enabled():
                from ..services.snapshot_response_service import snapshot_response
                return await snapshot_response(request, original, apply_policy)
            return apply_policy(request, await original(request))

        def apply_policy(request: Request, response: Response) -> Response:
            path = request.url.path
            if request.method != "GET" or path not in PRIVATE_CACHE_PATHS or response.status_code not in {200, 304}:
                return response
            response.headers["Cache-Control"] = "private, no-cache"
            merge_vary(response)
            if path in LIST_CACHE_PATHS and response.status_code == 200:
                scope = "\n".join((API_DATETIME_FORMAT_VERSION, path, get_current_tenant_id(), request.headers.get("X-Device-Id", ""))).encode()
                etag = 'W/"' + hashlib.sha256(scope + b"\n" + response.body).hexdigest() + '"'
                response.headers["ETag"] = etag
                if etag_matches(request.headers.get("If-None-Match", ""), etag):
                    headers = dict(response.headers)
                    headers.pop("content-length", None)
                    headers.pop("content-type", None)
                    return Response(status_code=304, headers=headers)
            return response

        return handler


def no_store_api(path: str) -> bool:
    return (path.startswith("/api/auth/") or path == "/api/bootstrap" or path == "/api/portal-file-actor"
            or path.startswith("/api/portal-file-operations/") or path == "/api/extra/promotions"
            or path.startswith("/api/extra/promotions/") or path.startswith("/api/promotions/operations/"))
