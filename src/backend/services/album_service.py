from __future__ import annotations

import logging
import mimetypes
import hashlib
import io
import os
from pathlib import Path
from threading import Semaphore
from typing import Any, cast
from uuid import uuid4

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response
from google.api_core.exceptions import NotFound, PreconditionFailed
from PIL import Image, ImageOps, UnidentifiedImageError

from ..core.runtime_paths import UPLOAD_DIR
from ..core.tenant_context import get_current_tenant_id
from ..drive_storage import get_storage_bucket, storage_enabled
from .file_service import safe_upload_name
from ..utils.datetime_utils import jst_today
from ..repositories.album_repository import AlbumRepository

_repo = AlbumRepository()
logger = logging.getLogger(__name__)
_thumbnail_workers = Semaphore(2)
# Numeric IDs may be reused after the last photo is deleted. Revalidate each
# URL against the DB rather than showing a browser-cached image of an old row.
_PHOTO_CACHE_HEADERS = {"Cache-Control": "private, no-cache"}


def list_albums() -> list[dict[str, Any]]:
    return _repo.list_all()


def create_album(payload: dict[str, Any]) -> dict[str, Any]:
    return _repo.create(payload)


def update_album(album_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return _repo.update(album_id, lambda current: {**current, **payload})


def delete_album(album_id: int) -> None:
    _repo.delete(album_id)


def _store() -> Any:
    from ..core.compat_gateway import row_store

    return row_store()


def _write_new_object(object_name: str, content: bytes, content_type: str) -> None:
    """Create-only write: a UUID key never overwrites another photo (N05, R06-3)."""
    if storage_enabled():
        blob = get_storage_bucket().blob(object_name)
        blob.upload_from_string(content, content_type=content_type or "application/octet-stream", if_generation_match=0, timeout=60)
        return
    path = UPLOAD_DIR / object_name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as target:
        target.write(content)


def _delete_unreferenced(photo: dict[str, Any]) -> None:
    """After COMMIT: delete exactly this photo's object, unless another photo row still uses it."""
    object_name = str(photo.get("object_name") or "").strip()
    rel_path = str(photo.get("path") or "").strip()
    for album in _store().list("albums"):
        for other in album.get("photos") or []:
            if (object_name and other.get("object_name") == object_name) or (rel_path and other.get("path") == rel_path):
                logger.warning("Album photo object is still referenced; not deleted")
                return
    try:
        if storage_enabled() and object_name:
            get_storage_bucket().blob(object_name).delete(timeout=60)
        elif rel_path:
            (UPLOAD_DIR / rel_path).unlink(missing_ok=True)
    except NotFound:
        return
    except Exception:
        # The DB change is committed; a failed delete leaves only an
        # unreferenced object (logged for the operations cleanup).
        logger.exception("Album photo object deletion failed after commit")


def upload_album_photo(
    album_id: int,
    filename: str,
    content_type: str,
    file_content: bytes,
    device: dict[str, Any],
) -> dict[str, Any]:
    store = _store()
    if store.get("albums", album_id) is None:
        raise HTTPException(status_code=404, detail="Data not found")
    member_id = device.get("member_id")
    member_name = device.get("member_name") or str(device.get("member_id") or "")
    filename = safe_upload_name(filename or "photo.jpg")
    # Operational date folder in JST; uniqueness comes from the UUID (L40).
    object_key = f"albums/{album_id}/{jst_today().isoformat()}/{uuid4().hex}_{filename}"
    try:
        _write_new_object(object_key, file_content, content_type)
    except Exception as exc:
        logger.exception("Album photo upload failed")
        raise HTTPException(status_code=502, detail=f"Photo upload failed: {exc}") from exc
    reference = {"object_name": object_key} if storage_enabled() else {"path": object_key}
    created: dict[str, Any] = {}
    try:
        with store.transaction() as ctx:
            photo_id = store.allocate_child_id(ctx, "album_photos")

            def mutate(current: dict[str, Any]) -> dict[str, Any]:
                photo = {
                    "id": photo_id,
                    "filename": filename,
                    "url": f"/api/albums/{album_id}/photos/{photo_id}",
                    "uploaded_by_member_id": member_id,
                    "uploaded_by_member_name": member_name,
                    **reference,
                }
                return {**current, "photos": [*(current.get("photos") or []), photo]}

            saved = store.update("albums", album_id, mutate, ctx=ctx)
            created = next(photo for photo in saved.get("photos") or [] if photo.get("id") == photo_id)
    except Exception:
        # Not committed: this request's own UUID object is unreferenced.
        _delete_unreferenced({**reference})
        raise
    keys = ("id", "filename", "url", "uploaded_by_member_id", "uploaded_by_member_name", "uploaded_at", "object_name", "path")
    return {key: created.get(key) for key in keys if key in created or key in reference}


def _find_photo(album_id: int, photo_id: int) -> dict[str, Any]:
    # Read only the requested album from committed storage. A per-process list
    # cache can retain deleted photos or miss uploads from another instance.
    album = _store().get("albums", album_id)
    if album is None:
        raise HTTPException(status_code=404, detail="Data not found")
    photos = album.get("photos") or []
    photo = next((item for item in photos if str(item.get("id")) == str(photo_id)), None)
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")

    return cast(dict[str, Any], photo)


def _thumbnail_key(photo: dict[str, Any]) -> str:
    # A derived cache only: no schema migration or mutation of original photos.
    # Tenant + source reference prevent collisions across albums/organizations.
    identity = repr((
        get_current_tenant_id(), photo.get("object_name"), photo.get("path"),
        photo.get("url"), photo.get("uploaded_at"),
    ))
    return f"album-thumbnails/v1/{hashlib.sha256(identity.encode()).hexdigest()}.webp"


def _make_thumbnail(content: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(content), formats=("JPEG", "PNG", "WEBP", "GIF", "BMP", "TIFF")) as image:
            # Draft/thumbnail before EXIF transpose avoids copying a full-size
            # camera image; the square bound stays correct after rotation.
            image.thumbnail((384, 384), Image.Resampling.LANCZOS)
            small = ImageOps.exif_transpose(image).convert("RGB")
            result = io.BytesIO()
            small.save(result, format="WEBP", quality=65, method=4)
            return result.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        # Never fall back to sending the original image to the gallery.
        raise HTTPException(status_code=422, detail="Photo preview unavailable") from exc


def _thumbnail_response(photo: dict[str, Any]) -> Response:
    key = _thumbnail_key(photo)
    # Bound simultaneous decodes of old high-resolution images. The second
    # cache read after entering this section also coalesces queued requests.
    with _thumbnail_workers:
        try:
            if storage_enabled():
                content = get_storage_bucket().blob(key).download_as_bytes(timeout=30)
            else:
                content = (UPLOAD_DIR / key).read_bytes()
        except (NotFound, FileNotFoundError):
            original = _original_response(photo)
            content = _make_thumbnail(
                Path(original.path).read_bytes() if isinstance(original, FileResponse) else original.body
            )
            try:
                if storage_enabled():
                    get_storage_bucket().blob(key).upload_from_string(
                        content, content_type="image/webp", if_generation_match=0, timeout=30
                    )
                else:
                    path = UPLOAD_DIR / key
                    path.parent.mkdir(parents=True, exist_ok=True)
                    temporary = path.with_name(f"{path.name}.{uuid4().hex}.tmp")
                    try:
                        temporary.write_bytes(content)
                        os.replace(temporary, path)
                    finally:
                        temporary.unlink(missing_ok=True)
            except PreconditionFailed:
                pass  # Another instance created the same derived image.
            except Exception:
                logger.warning("Album thumbnail cache write failed", exc_info=True)
        except Exception as exc:
            raise HTTPException(status_code=502, detail="Photo preview temporarily unavailable") from exc
    return Response(content=content, media_type="image/webp", headers=_PHOTO_CACHE_HEADERS)


def get_album_photo_response(album_id: int, photo_id: int, *, thumbnail: bool = False) -> Response:
    photo = _find_photo(album_id, photo_id)
    return _thumbnail_response(photo) if thumbnail else _original_response(photo)


def _original_response(photo: dict[str, Any]) -> Response:
    filename = str(photo.get("filename") or "photo")
    content_type, _ = mimetypes.guess_type(filename)
    media_type = content_type or "application/octet-stream"

    object_name = str(photo.get("object_name") or "").strip()
    if object_name:
        try:
            bucket = get_storage_bucket()
            blob = bucket.blob(object_name)
            return Response(content=blob.download_as_bytes(timeout=30), media_type=media_type, headers=_PHOTO_CACHE_HEADERS)
        except NotFound as exc:
            raise HTTPException(status_code=404, detail="Photo object not found") from exc
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
        return FileResponse(local_path, media_type=media_type, headers=_PHOTO_CACHE_HEADERS)

    raise HTTPException(status_code=404, detail="Photo source not found")


def _can_delete_photo(photo: dict[str, Any], device: dict[str, Any]) -> bool:
    permission = str(device.get("permission") or "")
    if permission in {"管理者", "システム管理者"}:
        return True
    owner_id = str(photo.get("uploaded_by_member_id") or "").strip()
    device_member_id = str(device.get("member_id") or "").strip()
    if owner_id and device_member_id and owner_id == device_member_id:
        return True
    return False


def delete_album_photo(album_id: int, photo_id: int, device: dict[str, Any]) -> dict[str, str]:
    removed: dict[str, Any] = {}

    def mutate(current: dict[str, Any]) -> dict[str, Any]:
        photos = current.get("photos") or []
        photo = next((p for p in photos if p.get("id") == photo_id), None)
        if not photo:
            raise HTTPException(status_code=404, detail="Photo not found")
        if not _can_delete_photo(photo, device):
            raise HTTPException(status_code=403, detail="Only uploader or admin can delete this photo")
        removed.clear()
        removed.update(photo)
        return {**current, "photos": [p for p in photos if p.get("id") != photo_id]}

    _store().update("albums", album_id, mutate)
    # Files are removed only after the DB change committed (R06-6).
    _delete_unreferenced(removed)
    return {"message": "Photo deleted"}
