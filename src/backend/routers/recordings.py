from __future__ import annotations

import io
import mimetypes
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from ..app_core import (
    CONVERTED_DIR,
    UPLOAD_DIR,
    cloud_recording_metadata,
    ensure_audio_file,
    forget_drive_file,
    format_duration,
    get_audio_duration_seconds,
    load_json_data,
    local_recording_metadata,
    logger,
    recording_file_bytes,
    remember_drive_file,
    remember_recording_duration,
    require_recording_manager_device,
    safe_segment,
    safe_upload_name,
    save_upload_to_path,
    unique_zip_name,
)
from ..drive_storage import get_storage_bucket, storage_enabled, upload_file_to_drive
from ..models.schemas import RecordingDeleteRequest
from ..services.blob_streaming_service import stream_storage_blob

router = APIRouter()

@router.post("/api/convert")
async def convert_audio(
    file: UploadFile = File(...),
    date: str = Form(""),
    piece: str = Form(""),
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_recording_manager_device(x_device_id)
    ensure_audio_file(file)

    date_dir = safe_segment(date, datetime.now().date().isoformat())
    piece_dir = safe_segment(piece, "uncategorized")
    output_dir = CONVERTED_DIR / date_dir / piece_dir
    output_path = save_upload_to_path(file, output_dir)

    duration_seconds = get_audio_duration_seconds(output_path)
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


def recording_payload() -> dict[str, list[dict[str, Any]]]:
    drive_files = [cloud_recording_metadata(item) for item in load_json_data("drive_files")]
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
        local_recording_metadata(path)
        for path in local_paths
        if path.relative_to(UPLOAD_DIR).as_posix() not in mirrored_local_paths
    ]
    return {"files": drive_files + local_files}


@router.get("/api/recordings")
async def get_recordings() -> dict[str, list[dict[str, Any]]]:
    return recording_payload()


@router.get("/api/recordings/download-zip")
async def download_recordings_zip(date: str = "", piece: str = "") -> Response:
    recordings = [
        item
        for item in recording_payload()["files"]
        if (not date or str(item.get("date") or "") == date)
        and (not piece or str(item.get("piece") or "") == piece)
    ]
    if not recordings:
        raise HTTPException(status_code=404, detail="Recordings not found")

    buffer = io.BytesIO()
    used_names: set[str] = set()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in recordings:
            data = recording_file_bytes(item)
            if data is None:
                continue
            filename = safe_upload_name(str(item.get("name") or "recording.mp3"))
            if not Path(filename).suffix:
                filename = f"{filename}.mp3"
            filename = unique_zip_name(filename, used_names)
            archive.writestr(filename, data)

    if not buffer.tell():
        raise HTTPException(status_code=404, detail="Recording files not found")

    zip_name = safe_segment(f"recordings_{date or 'all'}_{piece or 'all'}", "recordings") + ".zip"
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(zip_name)}",
            "Cache-Control": "private, max-age=60",
        },
    )


def local_recording_path(path: str) -> Path:
    requested = (UPLOAD_DIR / path).resolve()
    if not requested.is_file() or UPLOAD_DIR.resolve() not in requested.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return requested


@router.get("/api/recordings/play/{path:path}")
async def play_recording(path: str) -> FileResponse:
    requested = local_recording_path(path)
    return FileResponse(
        requested,
        media_type=mimetypes.guess_type(requested.name)[0] or "application/octet-stream",
    )


@router.get("/api/recordings/download/{path:path}")
async def download_recording(path: str) -> FileResponse:
    requested = local_recording_path(path)
    return FileResponse(requested, filename=requested.name)


@router.delete("/api/recordings")
async def delete_recording(payload: RecordingDeleteRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    require_recording_manager_device(x_device_id)
    if payload.source == "google_cloud_storage":
        object_name = payload.object_name.strip()
        if not object_name:
            raise HTTPException(status_code=400, detail="object_name is required")

        blob = get_storage_bucket().blob(object_name)
        if blob.exists():
            blob.delete()
        forget_drive_file(object_name)
        return {"message": "Deleted"}

    path = payload.path.strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")

    requested = local_recording_path(path)
    requested.unlink()
    return {"message": "Deleted"}



@router.get("/api/recordings/cloud/play/{object_name:path}")
async def play_cloud_recording(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=False, request=request)


@router.get("/api/recordings/cloud/download/{object_name:path}")
async def download_cloud_recording(object_name: str, request: Request) :
    return stream_storage_blob(object_name, download=True, request=request)


@router.post("/api/drive/upload")
async def upload_to_drive(
    file: UploadFile = File(...),
    date: str = Form(""),
    piece: str = Form(""),
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_recording_manager_device(x_device_id)
    ensure_audio_file(file)

    date_dir = safe_segment(date, datetime.now().date().isoformat())
    logger.info(f"date={date}")
    logger.info(f"piece={piece}")
    piece_dir = safe_segment(piece, "uncategorized")
    output_path = save_upload_to_path(file, CONVERTED_DIR / date_dir / piece_dir)
    duration_seconds = get_audio_duration_seconds(output_path)
    rel_path = output_path.relative_to(UPLOAD_DIR).as_posix()
    remember_recording_duration(rel_path, duration_seconds)

    if not storage_enabled():
        return {
            "drive_file_id": None,
            "share_link": f"/api/recordings/download/{rel_path}",
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


@router.get("/api/drive/files")
async def get_drive_files() -> dict[str, list[dict[str, Any]]]:
    return {"files": load_json_data("drive_files")}


