from __future__ import annotations

from pathlib import Path
from typing import Any, cast
from urllib.parse import quote

from fastapi import HTTPException

from ..core.runtime_paths import SHEET_DIR, UPLOAD_DIR
from ..drive_storage import get_storage_bucket, storage_enabled
from .file_service import safe_upload_name


def local_sheet_path(path: str) -> Path:
    requested = (UPLOAD_DIR / path).resolve()
    if not requested.is_file() or SHEET_DIR.resolve() not in requested.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return requested


def sheet_metadata(item: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(item)
    source = normalized.get("source")
    if source == "google_cloud_storage":
        object_name = str(normalized.get("object_name") or "")
        if object_name:
            encoded_object_name = quote(object_name, safe="/")
            normalized["url"] = f"/api/sheets/cloud/view/{encoded_object_name}"
            normalized["view_url"] = normalized["url"]
            normalized["download_url"] = f"/api/sheets/cloud/download/{encoded_object_name}"
    elif normalized.get("path"):
        encoded_path = quote(str(normalized["path"]), safe="/")
        normalized["url"] = f"/api/sheets/view/{encoded_path}"
        normalized["view_url"] = normalized["url"]
        normalized["download_url"] = f"/api/sheets/download/{encoded_path}"
    return normalized


def sheet_payload(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [sheet_metadata(item) for item in items]


def delete_sheet_file(item: dict[str, Any]) -> None:
    if item.get("source") == "google_cloud_storage":
        object_name = str(item.get("object_name") or "")
        if object_name and storage_enabled():
            blob = get_storage_bucket().blob(object_name)
            if blob.exists():
                blob.delete()
        return

    path = str(item.get("path") or "")
    if path:
        try:
            local_sheet_path(path).unlink()
        except HTTPException:
            return


def sheet_file_bytes(item: dict[str, Any]) -> bytes | None:
    if item.get("source") == "google_cloud_storage":
        object_name = str(item.get("object_name") or "")
        if object_name and storage_enabled():
            blob = get_storage_bucket().blob(object_name)
            if blob.exists():
                return cast(bytes, blob.download_as_bytes())
        return None

    path = str(item.get("path") or "")
    if not path:
        return None
    try:
        return local_sheet_path(path).read_bytes()
    except HTTPException:
        return None


def unique_zip_name(name: str, used_names: set[str]) -> str:
    base_name = safe_upload_name(name or "score.pdf")
    if not Path(base_name).suffix:
        base_name = f"{base_name}.pdf"
    candidate = base_name
    counter = 2
    while candidate in used_names:
        path = Path(base_name)
        candidate = f"{path.stem}_{counter}{path.suffix}"
        counter += 1
    used_names.add(candidate)
    return candidate