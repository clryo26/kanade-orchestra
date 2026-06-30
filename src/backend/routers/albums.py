from __future__ import annotations

# ruff: noqa: F403,F405
from fastapi import APIRouter

from ..app_core import *

router = APIRouter()


@router.get("/api/extra/{name}")
async def get_extra_items(name: str) -> list[dict[str, Any]]:
    return collection_items(name)


@router.post("/api/extra/{name}")
async def create_extra_item(
    name: str,
    request: Request,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    device = require_device(x_device_id)
    items = collection_items(name)
    upsert = parse_extra_upsert_request(await read_json_body(request))
    normalized_body = normalize_extra_for_collection(name, upsert.payload)
    assert_extra_collection_permission(name, device, payload=normalized_body)
    payload = normalize_extra_payload(normalized_body, next_id(items))
    items.append(payload)
    save_json_data(name, items)
    return payload


@router.put("/api/extra/{name}/{item_id}")
async def update_extra_item(
    name: str,
    item_id: int,
    request: Request,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    device = require_device(x_device_id)
    items = collection_items(name)
    index, current = find_item(items, item_id)
    upsert = parse_extra_upsert_request(await read_json_body(request))
    ensure_expected_updated_at(current, upsert.expected_updated_at)
    normalized_body = normalize_extra_for_collection(name, upsert.payload)
    assert_extra_collection_permission(name, device, payload=normalized_body, current=current)
    payload = normalize_extra_payload(normalized_body, item_id, current)
    items[index] = payload
    save_json_data(name, items)
    return payload


@router.delete("/api/extra/{name}/{item_id}")
async def delete_extra_item(
    name: str,
    item_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    device = require_device(x_device_id)
    items = collection_items(name)
    _, current = find_item(items, item_id)
    assert_extra_collection_permission(name, device, current=current)
    save_json_data(name, [item for item in items if item.get("id") != item_id])
    return {"message": "Deleted"}


@router.post("/api/extra/albums/{album_id}/photos")
async def upload_album_photo(
    album_id: int,
    file: UploadFile = File(...),
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    device = require_device(x_device_id)
    albums = load_json_data("albums")
    index, album = find_item(albums, album_id)

    member_id = device.get("member_id")
    member_name = device.get("member_name") or str(device.get("member_id") or "")
    now = datetime.now().isoformat()
    photos = album.get("photos") or []
    next_photo_id = max([p.get("id", 0) for p in photos], default=0) + 1
    filename = safe_upload_name(file.filename or "photo.jpg")
    date_dir = datetime.now().strftime("%Y-%m-%d")
    file_content = await file.read()

    if storage_enabled():
        try:
            bucket = get_storage_bucket()
            object_name = f"albums/{album_id}/{date_dir}/{next_photo_id}_{filename}"
            blob = bucket.blob(object_name)
            blob.upload_from_string(
                file_content,
                content_type=file.content_type or "application/octet-stream",
            )
            photo_metadata = {
                "id": next_photo_id,
                "filename": filename,
                "url": f"/api/albums/{album_id}/photos/{next_photo_id}",
                "uploaded_by_member_id": member_id,
                "uploaded_by_member_name": member_name,
                "uploaded_at": now,
                "object_name": object_name,
            }
        except Exception as exc:
            logger.exception("Album photo upload to GCS failed")
            raise HTTPException(status_code=502, detail=f"Photo upload failed: {exc}") from exc
    else:
        photo_dir = UPLOAD_DIR / "albums" / str(album_id) / date_dir
        photo_dir.mkdir(parents=True, exist_ok=True)
        photo_path = photo_dir / f"{next_photo_id}_{filename}"
        photo_path.write_bytes(file_content)
        photo_metadata = {
            "id": next_photo_id,
            "filename": filename,
            "url": f"/api/albums/{album_id}/photos/{next_photo_id}",
            "uploaded_by_member_id": member_id,
            "uploaded_by_member_name": member_name,
            "uploaded_at": now,
            "path": str(photo_path.relative_to(UPLOAD_DIR).as_posix()),
        }

    album.setdefault("photos", []).append(photo_metadata)
    album["updated_at"] = now
    albums[index] = album
    save_json_data("albums", albums)
    return photo_metadata


@router.get("/api/albums/{album_id}/photos/{photo_id}")
async def get_album_photo(album_id: int, photo_id: int) -> Response:
    albums = load_json_data("albums")
    _, album = find_item(albums, album_id)
    photos = album.get("photos") or []
    photo = next((item for item in photos if item.get("id") == photo_id), None)
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")

    filename = str(photo.get("filename") or "photo")
    content_type, _ = mimetypes.guess_type(filename)
    media_type = content_type or "application/octet-stream"

    object_name = str(photo.get("object_name") or "").strip()
    if object_name:
        try:
            bucket = get_storage_bucket()
            blob = bucket.blob(object_name)
            if not blob.exists():
                raise HTTPException(status_code=404, detail="Photo object not found")
            return Response(content=blob.download_as_bytes(), media_type=media_type)
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("Album photo fetch from GCS failed")
            raise HTTPException(status_code=502, detail=f"Photo fetch failed: {exc}") from exc

    rel_path = str(photo.get("path") or "").strip()
    if rel_path:
        local_path = (UPLOAD_DIR / rel_path).resolve()
        upload_root = UPLOAD_DIR.resolve()
        if upload_root not in local_path.parents and local_path != upload_root:
            raise HTTPException(status_code=400, detail="Invalid photo path")
        if not local_path.exists() or not local_path.is_file():
            raise HTTPException(status_code=404, detail="Photo file not found")
        return FileResponse(local_path, media_type=media_type)

    raise HTTPException(status_code=404, detail="Photo source not found")


@router.delete("/api/extra/albums/{album_id}/photos/{photo_id}")
async def delete_album_photo(
    album_id: int,
    photo_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    require_admin_device(x_device_id)
    albums = load_json_data("albums")
    index, album = find_item(albums, album_id)
    photos = album.get("photos") or []
    photo_to_delete = next((p for p in photos if p.get("id") == photo_id), None)
    if not photo_to_delete:
        raise HTTPException(status_code=404, detail="Photo not found")

    if storage_enabled() and photo_to_delete.get("object_name"):
        try:
            bucket = get_storage_bucket()
            bucket.blob(photo_to_delete["object_name"]).delete()
        except Exception:
            logger.exception("Album photo deletion from GCS failed")

    if photo_to_delete.get("path"):
        try:
            (UPLOAD_DIR / photo_to_delete["path"]).unlink()
        except Exception:
            logger.exception("Album photo deletion from local storage failed")

    album["photos"] = [p for p in photos if p.get("id") != photo_id]
    album["updated_at"] = datetime.now().isoformat()
    albums[index] = album
    save_json_data("albums", albums)
    return {"message": "Photo deleted"}
