from __future__ import annotations

import hashlib
import json

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from ..core.tenant_context import get_current_tenant_id
from ..models.schemas import MemberIntroduction
from ..repositories.member_introduction_repository import list_introductions
from .image_asset_service import ensure_public_image_url


def response(request: Request) -> Response:
    items = []
    for item in list_introductions():
        public = {key: value for key, value in item.items() if key in MemberIntroduction.model_fields and value is not None}
        public["photo_url"] = ensure_public_image_url(public.get("photo_url", ""), route_path=f"/api/members/{item['id']}/photo")
        items.append(MemberIntroduction.model_validate(public).model_dump())
    payload = json.dumps(items, ensure_ascii=False, sort_keys=True)
    etag = '"' + hashlib.sha256((get_current_tenant_id() + ":member-intro-v1:" + payload).encode()).hexdigest() + '"'
    headers = {"Cache-Control": "private, no-cache", "ETag": etag, "Vary": "X-Device-Id, X-Organization-Id"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(items, headers=headers)
