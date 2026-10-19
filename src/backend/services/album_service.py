from __future__ import annotations

import logging
import mimetypes
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response
from google.api_core.exceptions import NotFound

from ..core.runtime_paths import UPLOAD_DIR
from ..drive_storage import get_storage_bucket, storage_enabled
from .file_service import safe_upload_name
from .storage_service import load_json_data
from ..utils.datetime_utils import jst_today
from ..repositories.album_repository import AlbumRepository
from ..utils.collection_utils import find_item

_repo = AlbumRepository()
logger = logging.getLogger(__name__)


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


def get_album_photo_response(album_id: int, photo_id: int) -> Response:
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
            return Response(content=blob.download_as_bytes(), media_type=media_type)
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
        return FileResponse(local_path, media_type=media_type)

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
