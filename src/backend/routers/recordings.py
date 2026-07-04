from __future__ import annotations

import io
import logging
import mimetypes
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from ..core.auth_dependencies import get_recording_manager_device_auth
from ..drive_storage import get_storage_bucket
from ..models.schemas import RecordingDeleteRequest
from ..services.blob_streaming_service import stream_storage_blob
from ..services.file_service import format_duration, safe_segment, safe_upload_name
from ..services.recording_asset_service import (
    forget_drive_file,
    local_recording_path,
    recording_file_bytes,
    recording_payload,
    remember_drive_file,
)
from ..services.recording_service import duration_seconds_for_file, remember_recording_duration
from ..services.recording_upload_service import convert_audio_upload, upload_to_drive_only
from ..services.sheet_asset_service import unique_zip_name
from ..services.storage_service import load_json_data, save_json_data

router = APIRouter()
logger = logging.getLogger(__name__)

@router.post("/api/convert")
async def convert_audio(
    file: UploadFile = File(...),
    date: str = Form(""),
    piece: str = Form(""),
    _recording_manager: dict[str, Any] = Depends(get_recording_manager_device_auth),
) -> dict[str, Any]:
    return convert_audio_upload(
        file,
        date,
        piece,
        duration_getter=duration_seconds_for_file,
        remember_recording_duration=remember_recording_duration,
        format_duration=format_duration,
        remember_drive_file=lambda item: remember_drive_file(item, load_json_data=load_json_data, save_json_data=save_json_data),
        logger=logger,
    )

@router.get("/api/recordings")
async def get_recordings() -> dict[str, list[dict[str, Any]]]:
    return recording_payload(load_json_data=load_json_data, format_duration=format_duration)


@router.get("/api/recordings/download-zip")
async def download_recordings_zip(date: str = "", piece: str = "") -> Response:
    recordings = [
        item
        for item in recording_payload(load_json_data=load_json_data, format_duration=format_duration)["files"]
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
async def delete_recording(
    payload: RecordingDeleteRequest,
    _recording_manager: dict[str, Any] = Depends(get_recording_manager_device_auth),
) -> dict[str, str]:
    if payload.source == "google_cloud_storage":
        object_name = payload.object_name.strip()
        if not object_name:
            raise HTTPException(status_code=400, detail="object_name is required")

        blob = get_storage_bucket().blob(object_name)
        if blob.exists():
            blob.delete()
        forget_drive_file(object_name, load_json_data=load_json_data, save_json_data=save_json_data)
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
    _recording_manager: dict[str, Any] = Depends(get_recording_manager_device_auth),
) -> dict[str, Any]:
    return upload_to_drive_only(
        file,
        date,
        piece,
        duration_getter=duration_seconds_for_file,
        remember_recording_duration=remember_recording_duration,
        format_duration=format_duration,
        remember_drive_file=lambda item: remember_drive_file(item, load_json_data=load_json_data, save_json_data=save_json_data),
        logger=logger,
    )


@router.get("/api/drive/files")
async def get_drive_files() -> dict[str, list[dict[str, Any]]]:
    return {"files": load_json_data("drive_files")}


