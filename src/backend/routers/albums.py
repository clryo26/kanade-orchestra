from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import Response

from ..core.auth_dependencies import get_device_auth
from ..services.extra_collection_helpers import read_json_body
from ..services import album_service, extra_service

router = APIRouter()


@router.get("/api/extra/{name}")
async def get_extra_items(name: str) -> list[dict[str, Any]]:
    return extra_service.list_items(name)


@router.post("/api/extra/{name}")
async def create_extra_item(
    name: str,
    request: Request,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    return extra_service.create_item(name, await read_json_body(request), device)


@router.put("/api/extra/{name}/{item_id}")
async def update_extra_item(
    name: str,
    item_id: int,
    request: Request,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, Any]:
    return extra_service.update_item(name, item_id, await read_json_body(request), device)


@router.delete("/api/extra/{name}/{item_id}")
async def delete_extra_item(
    name: str,
    item_id: int,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, str]:
    extra_service.delete_item(name, item_id, device)
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
async def get_album_photo(album_id: int, photo_id: int) -> Response:
    return album_service.get_album_photo_response(album_id, photo_id)


@router.delete("/api/extra/albums/{album_id}/photos/{photo_id}")
async def delete_album_photo(
    album_id: int,
    photo_id: int,
    device: dict[str, Any] = Depends(get_device_auth),
) -> dict[str, str]:
    return album_service.delete_album_photo(album_id, photo_id, device)
