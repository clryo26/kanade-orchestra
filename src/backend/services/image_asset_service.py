from __future__ import annotations

import base64
import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from fastapi import HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from google.api_core.exceptions import NotFound

from ..core.runtime_paths import UPLOAD_DIR
from ..drive_storage import get_storage_bucket, storage_enabled


DATA_IMAGE_RE = re.compile(r"^data:(image/[^;]+);base64,(.*)$", re.IGNORECASE | re.DOTALL)

MIME_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
}


@dataclass(frozen=True)
class StoredImageRef:
    """Internal reference to an uploaded image variant."""

    object_name: str
    local_path: Path
    media_type: str


def _image_extension(media_type: str) -> str:
    return MIME_EXTENSIONS.get(media_type.lower(), ".png")


def _decode_data_image(data_url: str) -> tuple[bytes, str, str]:
    match = DATA_IMAGE_RE.match(str(data_url or "").strip())
    if not match:
        raise HTTPException(status_code=400, detail="Image payload must be a data URL")
    media_type = match.group(1).lower()
    encoded = match.group(2).strip()
    try:
        content = base64.b64decode(encoded, validate=True)
    except Exception as exc:  # pragma: no cover - defensive guard for malformed base64
        raise HTTPException(status_code=400, detail="Invalid base64 image payload") from exc
    return content, media_type, _image_extension(media_type)


def is_data_image(value: Any) -> bool:
    return bool(DATA_IMAGE_RE.match(str(value or "").strip()))


def _split_stored_url(value: str) -> tuple[str, str]:
    parsed = urlsplit(str(value or "").strip())
    query = parse_qs(parsed.query)
    ext = str(query.get("ext", [""])[0] or "").strip().lstrip(".")
    return parsed.path, ext


def _storage_ref(object_prefix: str, ext: str) -> StoredImageRef:
    normalized_ext = f".{ext.lstrip('.')}" if ext else ".png"
    object_name = f"{object_prefix}{normalized_ext}"
    local_path = UPLOAD_DIR / object_name
    media_type = mimetypes.types_map.get(normalized_ext.lower(), "image/png")
    return StoredImageRef(object_name=object_name, local_path=local_path, media_type=media_type)


def _write_image_bytes(content: bytes, *, ref: StoredImageRef, media_type: str) -> None:
    if storage_enabled():
        bucket = get_storage_bucket()
        bucket.blob(ref.object_name).upload_from_string(content, content_type=media_type)
        return

    ref.local_path.parent.mkdir(parents=True, exist_ok=True)
    ref.local_path.write_bytes(content)


def store_data_image(
    value: str,
    *,
    object_prefix: str,
    route_path: str,
) -> str:
    """Persist a data URL image and return the public route URL.

    The backend stores image bytes in GCS or local uploads, while the DB keeps
    only the lightweight route URL. This keeps bootstrap payloads small and lets
    the route serve either legacy inline data or the stored blob.
    """

    if not is_data_image(value):
        return str(value or "").strip()

    content, media_type, ext = _decode_data_image(value)
    ref = _storage_ref(object_prefix, ext)
    _write_image_bytes(content, ref=ref, media_type=media_type)

    return f"{route_path}?ext={ext.lstrip('.')}"


async def store_uploaded_image(
    file: UploadFile,
    *,
    object_prefix: str,
    route_path: str,
) -> str:
    """Persist an uploaded image file and return the public route URL."""

    filename = str(file.filename or "").strip()
    media_type = str(file.content_type or mimetypes.guess_type(filename)[0] or "").lower()
    if not media_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Please upload an image file")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Image file is empty")

    ext = _image_extension(media_type)
    ref = _storage_ref(object_prefix, ext)
    _write_image_bytes(content, ref=ref, media_type=media_type)
    return route_image_url(route_path, ext=ext)


def delete_stored_image(value: str, *, object_prefix: str) -> None:
    """Delete a stored image if the value points at an uploaded variant."""

    _, ext = _split_stored_url(value)
    if not ext:
        return

    ref = _storage_ref(object_prefix, ext)
    if storage_enabled():
        try:
            blob = get_storage_bucket().blob(ref.object_name)
            if blob.exists():
                blob.delete()
        except Exception:
            # Deletion is best-effort. The record itself is already being removed.
            return
        return

    try:
        if ref.local_path.exists():
            ref.local_path.unlink()
    except Exception:
        return


def _read_file_response(path: Path, media_type: str) -> FileResponse:
    return FileResponse(path, media_type=media_type)


def serve_stored_image(
    value: str,
    *,
    object_prefix: str,
    fallback_media_type: str = "image/png",
) -> Response:
    """Return a response for either legacy inline data or stored image bytes."""

    raw_value = str(value or "").strip()
    if not raw_value:
        raise HTTPException(status_code=404, detail="Image not found")

    if is_data_image(raw_value):
        content, media_type, _ = _decode_data_image(raw_value)
        return Response(content=content, media_type=media_type)

    _, ext = _split_stored_url(raw_value)
    ref = _storage_ref(object_prefix, ext or "png")
    media_type = mimetypes.guess_type(ref.object_name)[0] or fallback_media_type

    if storage_enabled():
        blob = get_storage_bucket().blob(ref.object_name)
        try:
            content = blob.download_as_bytes()
        except NotFound as exc:
            raise HTTPException(status_code=404, detail="Image not found") from exc
        return Response(content=content, media_type=media_type)

    if ref.local_path.exists():
        return _read_file_response(ref.local_path, media_type)

    raise HTTPException(status_code=404, detail="Image not found")


def route_image_url(route_path: str, *, ext: str) -> str:
    normalized_ext = ext.lstrip(".").strip()
    if not normalized_ext:
        return route_path
    return f"{route_path}?ext={normalized_ext}"


def stored_image_url_from_data_url(route_path: str, value: str) -> str:
    if not is_data_image(value):
        return str(value or "").strip()
    _, _, ext = _decode_data_image(value)
    return route_image_url(route_path, ext=ext)


def ensure_public_image_url(
    value: str,
    *,
    route_path: str,
) -> str:
    """Return a small URL for bootstrap payloads instead of inline base64."""

    raw_value = str(value or "").strip()
    if not raw_value:
        return ""
    if is_data_image(raw_value):
        return stored_image_url_from_data_url(route_path, raw_value)
    return raw_value
