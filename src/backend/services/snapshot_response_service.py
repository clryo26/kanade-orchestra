"""PERF-R04/R05 integration with the existing route/HTTP cache contract."""
from __future__ import annotations

import hashlib
import json

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

from ..core.collection_clock_schema import CLOCK_SCHEMA_VERSION, READ_DEPENDENCIES, configured_paths
from ..core.read_context import ClockAnomaly, capacity_error, clock_error, read_scope
from ..repositories.collection_clock_repository import load_versions
from ..utils.datetime_utils import API_DATETIME_FORMAT_VERSION


def _principal(frame, device_id):
    actor = frame.auth_results.get(device_id)
    if not isinstance(actor, dict):
        return None
    fields = ("device_id", "member_id", "member_name", "permission", "system_access_until",
              "is_recording_manager", "is_sheet_manager", "hidden_user", "authenticated_at")
    return {key: actor.get(key) for key in fields}


def _scope(request, frame):
    return [CLOCK_SCHEMA_VERSION, API_DATETIME_FORMAT_VERSION, frame.tenant, request.url.path,
            list(request.query_params.multi_items()), request.headers.get("X-Device-Id", ""),
            _principal(frame, request.headers.get("X-Device-Id", ""))]


async def snapshot_response(request, original, apply_legacy_policy):
    from ..core.http_cache import etag_matches, merge_vary
    from ..services import auth_service, meta_service

    def vary(response):
        merge_vary(response)
        values = response.headers["Vary"]
        if "*" not in values and "accept-encoding" not in values.lower():
            response.headers["Vary"] = values + ", Accept-Encoding"

    _, clocks = configured_paths()
    path = request.url.path
    device_id = request.headers.get("X-Device-Id", "")
    if len(device_id) > 512 or "\x00" in device_id:
        raise HTTPException(422, detail="Invalid device header")
    if path == "/api/member-introductions" and not device_id:
        raise HTTPException(401, detail="X-Device-Id is required")
    try:
        async with read_scope() as frame:
            frame.collections = frozenset(READ_DEPENDENCIES[path])
            request.state.portal_read_context = frame
            if path in {"/api/bootstrap-lite", "/api/member-introductions"} and device_id:
                try:
                    await run_in_threadpool(auth_service.device_auth_record, device_id)
                except HTTPException as exc:
                    if path != "/api/bootstrap-lite" or exc.status_code not in {401, 403}:
                        raise
            if path in clocks and frame.auth_trusted:
                await run_in_threadpool(load_versions, frame, READ_DEPENDENCIES[path])
                scope = _scope(request, frame) + [frame.generation, sorted(frame.versions.items())]
                if path in {"/api/bootstrap-lite", "/api/bootstrap-core"}:
                    scope.append(meta_service.cloud_run_revision())
                digest = hashlib.sha256(json.dumps(scope, sort_keys=True, default=str).encode()).hexdigest()
                frame.response_etag = 'W/"' + digest + '"'
                if etag_matches(request.headers.get("If-None-Match", ""), frame.response_etag):
                    response = Response(status_code=304, headers={"ETag": frame.response_etag,
                                                                 "Cache-Control": "private, no-cache"})
                    vary(response)
                    return response

            # Bootstrap's historical early validator must not short-circuit a
            # snapshot-body fallback or replace the new clock namespace.
            scope = dict(request.scope)
            scope["headers"] = [(k, v) for k, v in request.scope.get("headers", []) if k.lower() != b"if-none-match"]
            inner = Request(scope, receive=request.receive)
            response = await original(inner)
            frame.remaining()
            if frame.raw.info.transaction_status.name == "INERROR":
                raise ClockAnomaly("Authentication left an aborted snapshot")
            if response.status_code != 200:
                return response
            if frame.response_etag:
                response.headers["ETag"] = frame.response_etag
            elif path in {"/api/bootstrap-lite", "/api/bootstrap-core"}:
                base = json.dumps(_scope(request, frame), sort_keys=True, default=str).encode()
                response.headers["ETag"] = 'W/"' + hashlib.sha256(base + b"\n" + response.body).hexdigest() + '"'
            elif path != "/api/member-introductions":
                response = apply_legacy_policy(request, response)
            response.headers["Cache-Control"] = "private, no-cache"
            vary(response)
            tag = response.headers.get("ETag", "")
            if tag and etag_matches(request.headers.get("If-None-Match", ""), tag):
                headers = dict(response.headers)
                headers.pop("content-length", None)
                headers.pop("content-type", None)
                return Response(status_code=304, headers=headers)
            return response
    except ClockAnomaly as exc:
        raise clock_error() from exc
    except Exception as exc:
        from psycopg.errors import QueryCanceled, LockNotAvailable, UndefinedColumn, UndefinedTable
        if isinstance(exc, (UndefinedColumn, UndefinedTable)):
            raise clock_error() from exc
        if isinstance(exc, (QueryCanceled, LockNotAvailable)):
            raise capacity_error() from exc
        raise
