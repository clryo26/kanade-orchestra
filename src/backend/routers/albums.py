from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Request, UploadFile, HTTPException
from fastapi.responses import Response

from ..core.auth_dependencies import get_device_auth
from ..services.extra_collection_helpers import read_json_body
from ..services import album_service, extra_service
from ..services import promotion_service
from ..services import portal_file_asset_service
from ..services.image_asset_service import serve_stored_image

router = APIRouter()


@router.get("/api/extra/{name}")
async def get_extra_items(name: str, response: Response) -> list[dict[str, Any]]:
    if name == "promotions":
        response.headers["Cache-Control"] = "no-store"
        return promotion_service.list_items()
    return extra_service.list_items(name)


@router.post("/api/extra/{name}", response_model=dict[str, Any])
async def create_extra_item(
    name: str,
    request: Request,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any] | Response:
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        raw_body = dict(await request.form())
    else:
        raw_body = await read_json_body(request)
    if name == "promotions":
        return promotion_service.http_result(*await promotion_service.mutate("POST", None, raw_body, device, request.headers.get("Idempotency-Key")))
    return await extra_service.create_item(name, raw_body, device, idempotency_key=request.headers.get("Idempotency-Key"))


@router.put("/api/extra/{name}/{item_id}", response_model=dict[str, Any])
async def update_extra_item(
    name: str,
    item_id: int,
    request: Request,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any] | Response:
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        raw_body = dict(await request.form())
    else:
        raw_body = await read_json_body(request)
    if name == "promotions":
        return promotion_service.http_result(*await promotion_service.mutate("PUT", item_id, raw_body, device, request.headers.get("Idempotency-Key")))
    return await extra_service.update_item(name, item_id, raw_body, device, idempotency_key=request.headers.get("Idempotency-Key"))


@router.delete("/api/extra/{name}/{item_id}", response_model=dict[str, str])
async def delete_extra_item(
    name: str,
    item_id: int,
    request: Request,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, str] | Response:
    if name == "promotions":
        return promotion_service.http_result(*await promotion_service.mutate("DELETE", item_id, await read_json_body(request), device, request.headers.get("Idempotency-Key")))
    result = await extra_service.delete_item(name, item_id, device, idempotency_key=request.headers.get("Idempotency-Key"))
    if isinstance(result, Response):
        return result
    return {"message": "Deleted"}


@router.post("/api/extra/albums/{album_id}/photos")
async def upload_album_photo(
    album_id: int,
    file: UploadFile = File(...),
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    return album_service.upload_album_photo(
        album_id=album_id,
        filename=file.filename or "photo.jpg",
        content_type=file.content_type or "application/octet-stream",
        file_content=await file.read(),
        device=device,
    )


@router.get("/api/albums/{album_id}/photos/{photo_id}")
def get_album_photo(album_id: int, photo_id: int) -> Response:
    return album_service.get_album_photo_response(album_id, photo_id)


@router.get("/api/albums/{album_id}/photos/{photo_id}/thumbnail")
def get_album_thumbnail(album_id: int, photo_id: int) -> Response:
    # Storage I/O and image decoding run in FastAPI's worker pool, leaving the
    # event loop available for navigation/API calls while a gallery loads.
    return album_service.get_album_photo_response(album_id, photo_id, thumbnail=True)


@router.delete("/api/extra/albums/{album_id}/photos/{photo_id}")
async def delete_album_photo(
    album_id: int,
    photo_id: int,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, str]:
    return album_service.delete_album_photo(album_id, photo_id, device)


@router.get("/api/extra/promotions/{promotion_id}/image")
async def get_promotion_image(promotion_id: int, asset: str = "") -> Response:
    from uuid import UUID
    from ..repositories import promotion_repository
    from ..services import promotion_image_service
    try:
        item = promotion_repository.get_item(promotion_id)
        # Read existing pre-migration images without weakening v2 asset validation.
        # Do not migrate/delete user files as a side effect of an image GET.
        if not asset and item and not item.get("image_asset_id"):
            return serve_stored_image(
                str(item.get("image_url") or ""),
                object_prefix=f"promotion-images/{promotion_id}/image",
            )
        try:
            asset_id = str(UUID(asset))
        except ValueError as exc:
            raise HTTPException(404, detail="Image not found") from exc
        return promotion_image_service.response(item, asset_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, detail="Image temporarily unavailable") from exc


@router.get("/api/promotions/operations/{operation_id}")
async def get_promotion_operation(operation_id: str, device: dict[str, Any] = Depends(get_device_auth)):
    try:
        return promotion_service.http_result(*promotion_service.operation_status(device, operation_id))
    except ValueError as exc:
        raise HTTPException(422, detail="Invalid operation ID") from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, detail="Operation status temporarily unavailable") from exc


@router.get("/api/extra/org_settings/{setting_id}/icon")
async def get_org_setting_icon(setting_id: int, asset: str = "") -> Response:
    # Only a DB-confirmed asset (or legacy inline data stored in the row) is
    # served; never a guessed fixed-name file (JST spec R06-5).
    try:
        setting = extra_service.get_item_raw("org_settings", setting_id)
    except Exception:
        setting = {}
    return portal_file_asset_service.deliver(
        "org_icon", setting_id, asset or None, inline_value=str(setting.get("icon_url") or "")
    )


@router.get("/api/extra/desired_pieces/{item_id}/reference_score")
async def get_desired_piece_reference_score(item_id: int, asset: str = "") -> Response:
    extra_service.get_item_raw("desired_pieces", item_id)  # 404 for an unknown piece
    return portal_file_asset_service.deliver("desired_piece_reference_score", item_id, asset or None)


@router.get("/api/portal-file-operations/{operation_id}")
async def get_portal_file_operation(operation_id: str, device: dict[str, Any] = Depends(get_device_auth)) -> Response:
    """Authenticated status of a file operation (JST spec R05-A/R05-B)."""
    try:
        status, body = portal_file_asset_service.operation_status(device, operation_id)
    except HTTPException:
        raise
    except Exception as exc:
        # DB not reachable: unknown, never "not found" or "not executed".
        raise HTTPException(503, detail={"code": "file_operation_unknown_now", "message": "操作の状態を確認できません。少し待ってから再確認してください"}) from exc
    return portal_file_asset_service.http_result(status, body)


@router.get("/api/portal-file-actor")
async def get_portal_file_actor(device: dict[str, Any] = Depends(get_device_auth)) -> Response:
    """Stable, opaque browser scope for this tenant/account generation only."""
    try:
        scope = portal_file_asset_service.public_actor_scope(device)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, detail="操作主体を確認できません。再試行してください") from exc
    return portal_file_asset_service.http_result(200, {"scope": scope})
