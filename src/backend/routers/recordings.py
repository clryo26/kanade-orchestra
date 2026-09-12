from __future__ import annotations

import logging
import mimetypes
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from fastapi.responses import FileResponse, StreamingResponse

from ..core.auth_dependencies import get_recording_manager_device_auth
from ..drive_storage import get_storage_bucket, storage_enabled
from ..models.schemas import RecordingDeleteRequest
from ..services.blob_streaming_service import stream_storage_blob
from ..services.file_service import format_duration, safe_segment, safe_upload_name
from ..services.recording_asset_service import (
    forget_drive_file,
    local_recording_path,
    recording_payload,
    remember_drive_file,
)
from ..services.recording_service import duration_seconds_for_file, remember_recording_duration
from ..services.recording_upload_service import (
    complete_recording_upload,
    convert_audio_upload,
    create_recording_upload_session,
    upload_to_drive_only,
)
from ..services.sheet_asset_service import unique_zip_name
from ..services.storage_service import load_json_data, save_json_data

router = APIRouter()
logger = logging.getLogger(__name__)


class RecordingUploadSessionRequest(BaseModel):
    filename: str
    date: str = ""
    piece: str = ""
    size: int
    content_type: str = "application/octet-stream"


class RecordingUploadCompleteRequest(BaseModel):
    object_name: str
    filename: str
    date: str = ""
    piece: str = ""
    size: int
    duration_seconds: float | None = None

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


ZIP_STREAM_CHUNK_SIZE = 1024 * 1024


class _StreamingZipWriter:
    def __init__(self) -> None:
        self._offset = 0
        self._chunks: list[bytes] = []

    def write(self, data: bytes) -> int:
        chunk = bytes(data)
        if chunk:
            self._chunks.append(chunk)
            self._offset += len(chunk)
        return len(chunk)

    def tell(self) -> int:
        return self._offset

    def flush(self) -> None:
        return None

    def seekable(self) -> bool:
        return False

    def drain(self) -> list[bytes]:
        chunks = self._chunks
        self._chunks = []
        return chunks


def _recording_exists(item: dict[str, Any]) -> bool:
    if item.get("source") == "google_cloud_storage":
        object_name = str(item.get("object_name") or "")
        if not object_name or not storage_enabled():
            return False
        return bool(get_storage_bucket().blob(object_name).exists())

    path = str(item.get("path") or "")
    if not path:
        return False
    try:
        local_recording_path(path)
    except HTTPException:
        return False
    return True


def _stream_recordings_zip(recordings: list[dict[str, Any]]):
    sink = _StreamingZipWriter()
    used_names: set[str] = set()

    with zipfile.ZipFile(
        sink,
        "w",
        compression=zipfile.ZIP_STORED,
        allowZip64=True,
    ) as archive:
        for item in recordings:
            filename = safe_upload_name(str(item.get("name") or "recording.mp3"))
            if not Path(filename).suffix:
                filename = f"{filename}.mp3"
            filename = unique_zip_name(filename, used_names)

            if item.get("source") == "google_cloud_storage":
                object_name = str(item.get("object_name") or "")
                source = get_storage_bucket().blob(object_name).open("rb")
            else:
                source = local_recording_path(str(item.get("path") or "")).open("rb")

            with source, archive.open(filename, "w", force_zip64=True) as target:
                while True:
                    chunk = source.read(ZIP_STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    target.write(chunk)
                    yield from sink.drain()
            yield from sink.drain()

    yield from sink.drain()


@router.get("/api/recordings/download-zip")
async def download_recordings_zip(date: str = "", piece: str = "") -> StreamingResponse:
    recordings = [
        item
        for item in recording_payload(load_json_data=load_json_data, format_duration=format_duration)["files"]
        if (not date or str(item.get("date") or "") == date)
        and (not piece or str(item.get("piece") or "") == piece)
    ]
    if not recordings:
        raise HTTPException(status_code=404, detail="Recordings not found")

    available_recordings = [item for item in recordings if _recording_exists(item)]
    if not available_recordings:
        raise HTTPException(status_code=404, detail="Recording files not found")

    zip_name = safe_segment(f"recordings_{date or 'all'}_{piece or 'all'}", "recordings") + ".zip"
    return StreamingResponse(
        _stream_recordings_zip(available_recordings),
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


@router.post("/api/drive/upload/session")
async def create_recording_upload_session_route(
    payload: RecordingUploadSessionRequest,
    request: Request,
    _recording_manager: dict[str, Any] = Depends(get_recording_manager_device_auth),
) -> dict[str, Any]:
    return create_recording_upload_session(
        payload.filename,
        payload.date,
        payload.piece,
        payload.size,
        payload.content_type,
        request.headers.get("origin"),
    )


@router.post("/api/drive/upload/complete")
async def complete_recording_upload_route(
    payload: RecordingUploadCompleteRequest,
    _recording_manager: dict[str, Any] = Depends(get_recording_manager_device_auth),
) -> dict[str, Any]:
    return complete_recording_upload(
        payload.object_name,
        payload.filename,
        payload.date,
        payload.piece,
        payload.size,
        payload.duration_seconds,
        remember_recording_duration=remember_recording_duration,
        remember_drive_file=lambda item: remember_drive_file(item, load_json_data=load_json_data, save_json_data=save_json_data),
        format_duration=format_duration,
    )


@router.get("/api/drive/files")
async def get_drive_files() -> dict[str, list[dict[str, Any]]]:
    return {"files": load_json_data("drive_files")}


