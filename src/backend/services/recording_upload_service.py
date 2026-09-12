from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException, UploadFile

from ..core.runtime_paths import CONVERTED_DIR, UPLOAD_DIR
from ..drive_storage import (
    create_resumable_upload_session,
    recording_item_from_blob,
    storage_enabled,
    upload_file_to_drive,
)
from .file_service import ensure_audio_file, safe_segment, safe_upload_name, save_upload_to_path


FormatDuration = Callable[[float | int | None], str]
DurationGetter = Callable[[Path], float | None]
RememberRecordingDuration = Callable[[str, float | None], None]
RememberDriveFile = Callable[[dict[str, Any]], None]
MAX_RECORDING_UPLOAD_BYTES = 1024 * 1024 * 1024


def _recording_object_name(file_name: str, date: str, piece: str) -> tuple[str, str, str, str]:
    safe_name = safe_upload_name(file_name)
    date_dir = safe_segment(date, datetime.now().date().isoformat())
    piece_dir = safe_segment(piece, "uncategorized")
    return f"{date_dir}/{piece_dir}/{safe_name}", safe_name, date_dir, piece_dir


def create_recording_upload_session(
    file_name: str,
    date: str,
    piece: str,
    size: int,
    content_type: str,
    origin: str | None = None,
) -> dict[str, Any]:
    if size <= 0 or size > MAX_RECORDING_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Recording file size must be between 1 byte and 1 GB")
    suffix = Path(file_name).suffix.lower()
    if suffix not in {".mp3", ".m4a"}:
        raise HTTPException(status_code=400, detail="Please upload an MP3 or M4A file")
    if not storage_enabled():
        return {"mode": "local"}

    object_name, safe_name, date_dir, piece_dir = _recording_object_name(file_name, date, piece)
    upload_url = create_resumable_upload_session(
        object_name,
        content_type=content_type or "application/octet-stream",
        size=size,
        origin=origin,
    )
    return {
        "mode": "gcs_resumable",
        "upload_url": upload_url,
        "object_name": object_name,
        "filename": safe_name,
        "date": date_dir,
        "piece": piece_dir,
        "size": size,
    }


def complete_recording_upload(
    object_name: str,
    file_name: str,
    date: str,
    piece: str,
    size: int,
    duration_seconds: float | None,
    *,
    remember_recording_duration: RememberRecordingDuration,
    remember_drive_file: RememberDriveFile,
    format_duration: FormatDuration,
) -> dict[str, Any]:
    expected_object_name, safe_name, date_dir, piece_dir = _recording_object_name(file_name, date, piece)
    if object_name != expected_object_name:
        raise HTTPException(status_code=400, detail="Upload metadata does not match the recording path")
    if not storage_enabled():
        raise HTTPException(status_code=503, detail="Google Cloud Storage is not configured")

    try:
        drive_item = recording_item_from_blob(
            object_name,
            practice_date=date_dir,
            song_name=piece_dir,
            filename=safe_name,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Uploaded recording was not found in Google Cloud Storage") from exc
    if drive_item["size"] != size:
        raise HTTPException(status_code=400, detail="Uploaded recording size does not match")

    drive_item["duration_seconds"] = duration_seconds
    drive_item["duration"] = format_duration(duration_seconds)
    if duration_seconds is not None:
        remember_recording_duration(object_name, duration_seconds)
    remember_drive_file(drive_item)
    return {
        "drive_file_id": drive_item["id"],
        "share_link": drive_item.get("web_view_link") or drive_item.get("download_url"),
        "download_url": drive_item.get("download_url"),
        "source": "google_cloud_storage",
        "duration_seconds": duration_seconds,
        "duration": format_duration(duration_seconds),
        "message": "Uploaded to Google Cloud Storage",
    }


def _store_local_upload(
    file: UploadFile,
    date: str,
    piece: str,
    *,
    duration_getter: DurationGetter,
    remember_recording_duration: RememberRecordingDuration,
    format_duration: FormatDuration,
) -> tuple[Path, float | None, str, str, dict[str, Any]]:
    ensure_audio_file(file)
    date_dir = safe_segment(date, datetime.now().date().isoformat())
    piece_dir = safe_segment(piece, "uncategorized")
    output_dir = CONVERTED_DIR / date_dir / piece_dir
    output_path = save_upload_to_path(file, output_dir)
    duration_seconds = duration_getter(output_path)
    rel_path = output_path.relative_to(UPLOAD_DIR).as_posix()
    remember_recording_duration(rel_path, duration_seconds)
    response = {
        "filename": output_path.name,
        "path": rel_path,
        "download_url": f"/api/recordings/download/{rel_path}",
        "source": "local",
        "duration_seconds": duration_seconds,
        "duration": format_duration(duration_seconds),
        "message": "Uploaded",
    }
    return output_path, duration_seconds, date_dir, piece_dir, response


def convert_audio_upload(
    file: UploadFile,
    date: str,
    piece: str,
    *,
    duration_getter: DurationGetter,
    remember_recording_duration: RememberRecordingDuration,
    format_duration: FormatDuration,
    remember_drive_file: RememberDriveFile,
    logger,
) -> dict[str, Any]:
    output_path, duration_seconds, date_dir, piece_dir, response = _store_local_upload(
        file,
        date,
        piece,
        duration_getter=duration_getter,
        remember_recording_duration=remember_recording_duration,
        format_duration=format_duration,
    )

    if storage_enabled():
        storage_file = upload_file_to_drive(
            local_path=output_path,
            practice_date=date_dir,
            song_name=piece_dir,
        )
        logger.info("Google Cloud Storage upload complete: %s", storage_file)
        storage_file["duration_seconds"] = duration_seconds
        storage_file["duration"] = format_duration(duration_seconds)
        remember_drive_file(storage_file)
        response.update(
            {
                "drive_file_id": storage_file["id"],
                "share_link": storage_file.get("view_url") or storage_file.get("download_url"),
                "download_url": storage_file.get("download_url") or response["download_url"],
                "source": "google_cloud_storage",
                "message": "Uploaded and mirrored to Google Cloud Storage",
            }
        )

    return response


def upload_to_drive_only(
    file: UploadFile,
    date: str,
    piece: str,
    *,
    duration_getter: DurationGetter,
    remember_recording_duration: RememberRecordingDuration,
    format_duration: FormatDuration,
    remember_drive_file: RememberDriveFile,
    logger,
) -> dict[str, Any]:
    output_path, duration_seconds, date_dir, piece_dir, response = _store_local_upload(
        file,
        date,
        piece,
        duration_getter=duration_getter,
        remember_recording_duration=remember_recording_duration,
        format_duration=format_duration,
    )

    logger.info("date=%s", date)
    logger.info("piece=%s", piece)

    if not storage_enabled():
        return {
            "drive_file_id": None,
            "share_link": response["download_url"],
            "source": "local",
            "duration_seconds": duration_seconds,
            "duration": format_duration(duration_seconds),
            "message": "Google Cloud Storage is not configured. Saved locally.",
        }

    try:
        drive_item = upload_file_to_drive(output_path, date_dir, piece_dir)
        drive_item["duration_seconds"] = duration_seconds
        drive_item["duration"] = format_duration(duration_seconds)
        remember_recording_duration(str(drive_item.get("object_name") or drive_item.get("id") or ""), duration_seconds)
        remember_drive_file(drive_item)
    except Exception as exc:
        logger.exception("Google Cloud Storage upload failed")
        raise HTTPException(
            status_code=502,
            detail=f"Google Cloud Storage upload failed: {exc}",
        ) from exc

    return {
        "drive_file_id": drive_item["id"],
        "share_link": drive_item.get("web_view_link") or drive_item.get("download_url"),
        "download_url": drive_item.get("download_url"),
        "source": "google_cloud_storage",
        "duration_seconds": duration_seconds,
        "duration": format_duration(duration_seconds),
        "message": "Uploaded to Google Cloud Storage",
    }