from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Callable, cast
from urllib.parse import quote

from fastapi import HTTPException

from ..core.runtime_paths import CONVERTED_DIR, UPLOAD_DIR
from ..drive_storage import get_storage_bucket, storage_enabled


LoadJsonData = Callable[[str], list[dict[str, Any]]]
SaveJsonData = Callable[[str, list[dict[str, Any]]], None]
NextId = Callable[[list[dict[str, Any]]], int]
FormatDuration = Callable[[float | int | None], str]


def _looks_like_date(value: str) -> bool:
    text = value.strip()
    if not text:
        return False
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            datetime.strptime(text, fmt)
            return True
        except ValueError:
            continue
    return False


def _infer_date_and_piece(value: str | None) -> tuple[str, str]:
    text = str(value or "").strip().replace("\\", "/")
    if not text:
        return "", ""
    segments = [segment for segment in text.split("/") if segment]
    if not segments:
        return "", ""
    for index, segment in enumerate(segments):
        if _looks_like_date(segment):
            return segment, segments[index + 1] if index + 1 < len(segments) else ""
    if len(segments) >= 2:
        return segments[0], segments[1]
    return "", ""


def recording_metadata_map(*, load_json_data: LoadJsonData) -> dict[str, dict[str, Any]]:
    items = load_json_data("recording_metadata")
    return {str(item.get("path") or item.get("object_name") or item.get("id") or ""): item for item in items}


def remember_recording_duration(
    path_key: str,
    duration_seconds: float | None,
    *,
    load_json_data: LoadJsonData,
    save_json_data: SaveJsonData,
    next_id: NextId,
    format_duration: FormatDuration,
) -> None:
    if not path_key or duration_seconds is None:
        return

    items = load_json_data("recording_metadata")
    now = datetime.now().isoformat()
    for item in items:
        item_key = str(item.get("path") or item.get("object_name") or item.get("id") or "")
        if item_key == path_key:
            item["duration_seconds"] = duration_seconds
            item["duration"] = format_duration(duration_seconds)
            item["updated_at"] = now
            save_json_data("recording_metadata", items)
            return

    items.append(
        {
            "id": next_id(items),
            "path": path_key,
            "duration_seconds": duration_seconds,
            "duration": format_duration(duration_seconds),
            "created_at": now,
            "updated_at": now,
        }
    )
    save_json_data("recording_metadata", items)


def local_recording_metadata(
    path: Path,
    *,
    metadata_by_key: dict[str, dict[str, Any]],
    format_duration: FormatDuration,
) -> dict[str, Any]:
    stat = path.stat()
    rel = path.relative_to(UPLOAD_DIR).as_posix()
    parts = path.relative_to(CONVERTED_DIR).parts if path.is_relative_to(CONVERTED_DIR) else path.parts
    recording_date = parts[0] if len(parts) >= 3 else ""
    piece = parts[1] if len(parts) >= 3 else ""
    meta = metadata_by_key.get(rel, {})
    duration_seconds = meta.get("duration_seconds")
    duration_label = meta.get("duration") or format_duration(duration_seconds)
    return {
        "name": path.name,
        "date": recording_date,
        "piece": piece,
        "size": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        "path": rel,
        "play_url": f"/api/recordings/play/{rel}",
        "download_url": f"/api/recordings/download/{rel}",
        "source": "local",
        "duration_seconds": duration_seconds,
        "duration": duration_label,
    }


def cloud_recording_metadata(
    item: dict[str, Any],
    *,
    metadata_by_key: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    normalized = dict(item)
    object_name = normalized.get("object_name") or normalized.get("id")
    if normalized.get("source") != "google_cloud_storage" or not object_name:
        return normalized

    encoded_object_name = quote(str(object_name), safe="/")
    normalized["object_name"] = object_name
    inferred_date, inferred_piece = _infer_date_and_piece(str(object_name))
    normalized["date"] = normalized.get("date") or inferred_date
    normalized["piece"] = normalized.get("piece") or inferred_piece
    cached = metadata_by_key.get(str(object_name), {}) or metadata_by_key.get(str(normalized.get("id") or ""), {})
    if cached and not normalized.get("duration"):
        normalized["duration_seconds"] = cached.get("duration_seconds")
        normalized["duration"] = cached.get("duration")
    normalized["play_url"] = f"/api/recordings/cloud/play/{encoded_object_name}"
    normalized["download_url"] = f"/api/recordings/cloud/download/{encoded_object_name}"
    return normalized


def remember_drive_file(item: dict[str, Any], *, load_json_data: LoadJsonData, save_json_data: SaveJsonData) -> None:
    object_name = str(item.get("object_name") or item.get("id") or "").strip()
    now = datetime.now().isoformat()
    normalized_item = dict(item)
    normalized_item["created_at"] = normalized_item.get("created_at") or now
    normalized_item["updated_at"] = now
    if object_name and normalized_item.get("source") == "google_cloud_storage":
        inferred_date, inferred_piece = _infer_date_and_piece(object_name)
        normalized_item["date"] = normalized_item.get("date") or inferred_date
        normalized_item["piece"] = normalized_item.get("piece") or inferred_piece
    items = load_json_data("drive_files")
    items = [
        existing
        for existing in items
        if str(existing.get("object_name") or existing.get("id") or "").strip() != object_name
    ]
    items.insert(0, normalized_item)
    save_json_data("drive_files", items[:500])


def forget_drive_file(object_name: str, *, load_json_data: LoadJsonData, save_json_data: SaveJsonData) -> None:
    items = load_json_data("drive_files")
    save_json_data(
        "drive_files",
        [
            item
            for item in items
            if item.get("object_name") != object_name and item.get("id") != object_name
        ],
    )


def local_recording_path(path: str) -> Path:
    requested = (UPLOAD_DIR / path).resolve()
    if not requested.is_file() or UPLOAD_DIR.resolve() not in requested.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return requested


def recording_file_bytes(item: dict[str, Any]) -> bytes | None:
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
        return local_recording_path(path).read_bytes()
    except HTTPException:
        return None


def recording_payload(*, load_json_data: LoadJsonData, format_duration: FormatDuration) -> dict[str, list[dict[str, Any]]]:
    metadata_by_key = recording_metadata_map(load_json_data=load_json_data)
    drive_files = [
        cloud_recording_metadata(item, metadata_by_key=metadata_by_key)
        for item in load_json_data("drive_files")
    ]
    mirrored_local_paths = {
        f"converted/{object_name}"
        for item in drive_files
        for object_name in [str(item.get("object_name") or item.get("id") or "").strip("/")]
        if object_name
    }
    local_paths = sorted(
        [*CONVERTED_DIR.rglob("*.mp3"), *CONVERTED_DIR.rglob("*.m4a")],
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    local_files = [
        local_recording_metadata(path, metadata_by_key=metadata_by_key, format_duration=format_duration)
        for path in local_paths
        if path.relative_to(UPLOAD_DIR).as_posix() not in mirrored_local_paths
    ]
    return {"files": drive_files + local_files}