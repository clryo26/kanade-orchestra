from __future__ import annotations

import io
import json
import logging
import mimetypes
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from .drive_storage import (
        get_storage_bucket,
        load_json_from_storage,
        save_json_to_storage,
        storage_enabled,
        upload_file_to_drive,
    )
except ImportError:  # pragma: no cover - allows running main.py directly.
    from drive_storage import (
        get_storage_bucket,
        load_json_from_storage,
        save_json_to_storage,
        storage_enabled,
        upload_file_to_drive,
    )

try:
    import imageio_ffmpeg
except ImportError:  # pragma: no cover
    imageio_ffmpeg = None

try:
    from pydub import AudioSegment
except ImportError:  # pragma: no cover
    AudioSegment = None


load_dotenv()
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

if AudioSegment is not None and imageio_ffmpeg is not None:
    AudioSegment.converter = imageio_ffmpeg.get_ffmpeg_exe()

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR = BASE_DIR / "uploads"
DATA_DIR = BASE_DIR / "data"
CONVERTED_DIR = UPLOAD_DIR / "converted"
DRIVE_STAGING_DIR = UPLOAD_DIR / "drive-staging"
JSON_DATA_NAMES = ("performances", "schedules", "announcements", "drive_files")
PORTAL_DATA_NAMES = (
    "absences",
    "sheet_library",
    "payments",
    "rosters",
    "events",
    "event_responses",
    "song_info",
    "albums",
)

for directory in (UPLOAD_DIR, DATA_DIR, CONVERTED_DIR, DRIVE_STAGING_DIR):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="Orchestra Activity Tool",
    description="Performance, practice schedule, announcement, and recording management.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class Performance(BaseModel):
    id: int | None = None
    title: str
    date: str
    open_time: str
    start_time: str
    venue: str
    conductor: str
    pieces: list[Any] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None


class Schedule(BaseModel):
    id: int | None = None
    date: str
    time: str = ""
    start_time: str = ""
    end_time: str = ""
    venue: str
    available_hours: str = ""
    available_start_time: str = ""
    available_end_time: str = ""
    pieces: str = ""
    notes: str = ""
    conductor_training: bool = False
    created_at: str | None = None
    updated_at: str | None = None


class Announcement(BaseModel):
    id: int | None = None
    date: str
    content: str
    created_at: str | None = None
    updated_at: str | None = None


class RecordingDeleteRequest(BaseModel):
    source: str
    object_name: str = ""
    path: str = ""


class RecordingDownloadItem(BaseModel):
    source: str = "local"
    object_name: str = ""
    path: str = ""
    name: str = "recording.mp3"


class RecordingDownloadZipRequest(BaseModel):
    filename: str = "recordings.zip"
    files: list[RecordingDownloadItem] = Field(default_factory=list)


class DirectUploadSessionRequest(BaseModel):
    filename: str
    content_type: str = ""
    size: int = 0
    date: str = ""
    piece: str = ""
    duration_seconds: float = 0
    bitrate: int = 192


class DirectUploadCompleteRequest(BaseModel):
    object_name: str
    filename: str
    content_type: str = ""
    size: int = 0
    date: str = ""
    piece: str = ""
    duration_seconds: float = 0
    bitrate: int = 192


class PortalItem(BaseModel):
    id: int | None = None
    created_at: str | None = None
    updated_at: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)


def model_dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump() if hasattr(model, "model_dump") else model.dict()


def data_file(name: str) -> Path:
    return DATA_DIR / f"{name}.json"


def load_local_json_data(name: str) -> list[dict[str, Any]]:
    path = data_file(name)
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as file:
            loaded = json.load(file)
        return loaded if isinstance(loaded, list) else []
    except json.JSONDecodeError as exc:
        logger.error("Invalid JSON in %s: %s", path, exc)
        raise HTTPException(status_code=500, detail=f"{name}.json is invalid")


def load_json_data(name: str) -> list[dict[str, Any]]:
    if storage_enabled():
        cloud_data = None
        try:
            cloud_data = load_json_from_storage(name)
        except json.JSONDecodeError as exc:
            logger.error("Invalid JSON in Cloud Storage data %s: %s", name, exc)
            raise HTTPException(status_code=500, detail=f"Cloud Storage {name}.json is invalid")
        except Exception as exc:
            logger.warning("Failed to load %s.json from Cloud Storage. Falling back to local data: %s", name, exc)
        if cloud_data is not None:
            return cloud_data

    return load_local_json_data(name)


def save_json_data(name: str, data: list[dict[str, Any]]) -> None:
    path = data_file(name)
    tmp_path = path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
    tmp_path.replace(path)

    if storage_enabled():
        try:
            save_json_to_storage(name, data)
        except Exception as exc:
            logger.exception("Failed to save %s.json to Cloud Storage", name)
            raise HTTPException(
                status_code=502,
                detail=f"Failed to save {name}.json to Cloud Storage: {exc}",
            ) from exc


@app.on_event("startup")
async def seed_cloud_data_from_local() -> None:
    if not storage_enabled():
        return

    for name in JSON_DATA_NAMES:
        if not data_file(name).exists():
            continue
        try:
            if load_json_from_storage(name) is None:
                save_json_to_storage(name, load_local_json_data(name))
                logger.info("Seeded %s.json to Cloud Storage", name)
        except Exception:
            logger.exception("Failed to seed %s.json to Cloud Storage", name)


def next_id(items: list[dict[str, Any]]) -> int:
    return max((int(item.get("id", 0)) for item in items), default=0) + 1


def find_item(items: list[dict[str, Any]], item_id: int) -> tuple[int, dict[str, Any]]:
    for index, item in enumerate(items):
        if item.get("id") == item_id:
            return index, item
    raise HTTPException(status_code=404, detail="Data not found")


def safe_segment(value: str, default: str) -> str:
    value = (value or default).strip()
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value or default


def safe_upload_name(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    stem = safe_segment(Path(filename).stem, "audio")
    return f"{stem}{suffix}"


def storage_object_name(practice_date: str, song_name: str, filename: str) -> str:
    return "/".join(
        segment.strip("/")
        for segment in (practice_date, song_name, safe_upload_name(filename))
        if segment.strip("/")
    )


def ensure_audio_file(file: UploadFile) -> str:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".wav", ".mp3"}:
        raise HTTPException(status_code=400, detail="Please upload a WAV or MP3 file")
    return suffix


def local_recording_metadata(path: Path) -> dict[str, Any]:
    stat = path.stat()
    rel = path.relative_to(UPLOAD_DIR).as_posix()
    parts = path.relative_to(CONVERTED_DIR).parts if path.is_relative_to(CONVERTED_DIR) else path.parts
    date = parts[0] if len(parts) >= 3 else ""
    piece = parts[1] if len(parts) >= 3 else ""
    return {
        "name": path.name,
        "date": date,
        "piece": piece,
        "size": stat.st_size,
        "duration_seconds": 0,
        "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        "path": rel,
        "play_url": f"/api/recordings/play/{rel}",
        "download_url": f"/api/recordings/download/{rel}",
        "source": "local",
    }


def cloud_recording_metadata(item: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(item)
    object_name = normalized.get("object_name") or normalized.get("id")
    duration_seconds = (
        normalized.get("duration_seconds")
        or normalized.get("durationSeconds")
        or normalized.get("duration")
        or normalized.get("audio_duration_seconds")
        or 0
    )
    try:
        duration_seconds = float(duration_seconds or 0)
    except (TypeError, ValueError):
        duration_seconds = 0

    if normalized.get("source") != "google_cloud_storage" or not object_name:
        normalized["duration_seconds"] = duration_seconds
        return normalized

    encoded_object_name = quote(str(object_name), safe="/")
    normalized["object_name"] = object_name
    normalized["play_url"] = f"/api/recordings/cloud/play/{encoded_object_name}"
    normalized["download_url"] = f"/api/recordings/cloud/download/{encoded_object_name}"

    # 旧データなどで曲の長さが未保存の場合は、一覧表示時にGCS上の音声から取得する。
    # 取得できない場合でも画面側で「未取得」と表示できるよう0を返す。
    if not duration_seconds and storage_enabled():
        try:
            blob = get_storage_bucket().blob(str(object_name))
            if blob.exists():
                suffix = Path(str(object_name)).suffix or ".audio"
                with tempfile.NamedTemporaryFile(suffix=suffix) as temp_file:
                    blob.download_to_filename(temp_file.name)
                    duration_seconds = audio_duration_seconds(Path(temp_file.name))
        except Exception:
            logger.exception("Failed to read cloud audio duration: %s", object_name)
            duration_seconds = 0

    normalized["duration_seconds"] = duration_seconds
    return normalized



def audio_duration_seconds(path: Path) -> float:
    if AudioSegment is None:
        return 0
    try:
        audio = AudioSegment.from_file(path)
        return round(len(audio) / 1000, 3)
    except Exception:
        logger.exception("Failed to read audio duration: %s", path)
        return 0


def cloud_recording_metadata(item: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(item)
    object_name = normalized.get("object_name") or normalized.get("id")
    duration_seconds = (
        normalized.get("duration_seconds")
        or normalized.get("durationSeconds")
        or normalized.get("duration")
        or normalized.get("audio_duration_seconds")
        or 0
    )
    try:
        duration_seconds = float(duration_seconds or 0)
    except (TypeError, ValueError):
        duration_seconds = 0

    if normalized.get("source") != "google_cloud_storage" or not object_name:
        normalized["duration_seconds"] = duration_seconds
        return normalized

    encoded_object_name = quote(str(object_name), safe="/")
    direct_url = (
        normalized.get("download_url")
        or normalized.get("web_view_link")
        or normalized.get("view_url")
    )
    normalized["object_name"] = object_name
    if direct_url and os.getenv("GOOGLE_CLOUD_STORAGE_DIRECT_PLAY", "true").strip().lower() == "true":
        normalized["play_url"] = direct_url
        normalized["download_url"] = direct_url
    else:
        normalized["play_url"] = f"/api/recordings/cloud/play/{encoded_object_name}"
        normalized["download_url"] = f"/api/recordings/cloud/download/{encoded_object_name}"

    normalized["duration_seconds"] = duration_seconds
    return normalized

def remember_drive_file(item: dict[str, Any]) -> None:
    items = load_json_data("drive_files")
    items = [existing for existing in items if existing.get("id") != item.get("id")]
    items.insert(0, item)
    save_json_data("drive_files", items[:500])


def forget_drive_file(object_name: str) -> None:
    items = load_json_data("drive_files")
    save_json_data(
        "drive_files",
        [
            item
            for item in items
            if item.get("object_name") != object_name and item.get("id") != object_name
        ],
    )


def save_upload_to_path(file: UploadFile, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    output_path = directory / safe_upload_name(file.filename or "audio")
    with output_path.open("wb") as target:
        shutil.copyfileobj(file.file, target)
    return output_path


def convert_path_to_mp3(source_path: Path, suffix: str, bitrate: int) -> Path:
    output_path = source_path.with_suffix(".mp3")
    if suffix == ".mp3":
        if source_path != output_path:
            source_path.replace(output_path)
        return output_path

    if AudioSegment is None:
        raise HTTPException(status_code=500, detail="pydub is not available")

    try:
        audio = AudioSegment.from_file(source_path, format=suffix.lstrip("."))
        audio.export(output_path, format="mp3", bitrate=f"{bitrate}k")
        source_path.unlink(missing_ok=True)
    except Exception as exc:
        logger.exception("Audio conversion failed")
        raise HTTPException(
            status_code=500,
            detail="Audio conversion failed. Make sure ffmpeg is installed.",
        ) from exc

    return output_path


def storage_public_url(bucket_name: str, object_name: str) -> str:
    return f"https://storage.googleapis.com/{bucket_name}/{object_name}"


def make_blob_public_if_configured(blob: Any) -> None:
    if os.getenv("GOOGLE_CLOUD_STORAGE_PUBLIC", "false").strip().lower() == "true":
        blob.make_public()


def convert_uploaded_storage_wav_to_mp3(
    bucket: Any,
    source_blob: Any,
    date_dir: str,
    piece_dir: str,
    filename: str,
    bitrate: int,
) -> tuple[Any, float]:
    """Download a directly uploaded WAV from GCS, convert it, upload the MP3, and delete the WAV."""
    if bitrate not in {128, 192, 320}:
        raise HTTPException(status_code=400, detail="bitrate must be 128, 192, or 320")

    temp_dir = Path(tempfile.mkdtemp(prefix="direct-audio-", dir=DRIVE_STAGING_DIR))
    try:
        source_path = temp_dir / safe_upload_name(filename or Path(source_blob.name).name)
        if source_path.suffix.lower() != ".wav":
            source_path = source_path.with_suffix(".wav")

        source_blob.download_to_filename(str(source_path))
        output_path = convert_path_to_mp3(source_path, ".wav", bitrate)
        duration_seconds = audio_duration_seconds(output_path)

        converted_object_name = storage_object_name(date_dir, piece_dir, output_path.name)
        target_blob = bucket.blob(converted_object_name)
        target_blob.upload_from_filename(str(output_path), content_type="audio/mpeg")
        make_blob_public_if_configured(target_blob)
        target_blob.reload()

        if source_blob.name != target_blob.name and source_blob.exists():
            source_blob.delete()

        return target_blob, duration_seconds
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(BASE_DIR / "index.html")


@app.get("/api/health")
async def health_check() -> dict[str, str]:
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "service": "Orchestra Activity Tool",
        "storage_configured": str(storage_enabled()).lower(),
    }


@app.get("/api/performances", response_model=list[Performance])
async def get_performances() -> list[dict[str, Any]]:
    return load_json_data("performances")


@app.post("/api/performances", response_model=Performance)
async def create_performance(performance: Performance) -> dict[str, Any]:
    items = load_json_data("performances")
    now = datetime.now().isoformat()
    payload = model_dump(performance)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("performances", items)
    return payload


@app.get("/api/performances/{performance_id}", response_model=Performance)
async def get_performance(performance_id: int) -> dict[str, Any]:
    _, item = find_item(load_json_data("performances"), performance_id)
    return item


@app.put("/api/performances/{performance_id}", response_model=Performance)
async def update_performance(performance_id: int, performance: Performance) -> dict[str, Any]:
    items = load_json_data("performances")
    index, current = find_item(items, performance_id)
    payload = model_dump(performance)
    payload.update(
        {
            "id": performance_id,
            "created_at": current.get("created_at"),
            "updated_at": datetime.now().isoformat(),
        }
    )
    items[index] = payload
    save_json_data("performances", items)
    return payload


@app.delete("/api/performances/{performance_id}")
async def delete_performance(performance_id: int) -> dict[str, str]:
    items = load_json_data("performances")
    find_item(items, performance_id)
    save_json_data("performances", [item for item in items if item.get("id") != performance_id])
    return {"message": "Deleted"}


@app.get("/api/schedules", response_model=list[Schedule])
async def get_schedules() -> list[dict[str, Any]]:
    return load_json_data("schedules")


@app.post("/api/schedules", response_model=Schedule)
async def create_schedule(schedule: Schedule) -> dict[str, Any]:
    items = load_json_data("schedules")
    now = datetime.now().isoformat()
    payload = model_dump(schedule)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("schedules", items)
    return payload


@app.get("/api/schedules/{schedule_id}", response_model=Schedule)
async def get_schedule(schedule_id: int) -> dict[str, Any]:
    _, item = find_item(load_json_data("schedules"), schedule_id)
    return item


@app.put("/api/schedules/{schedule_id}", response_model=Schedule)
async def update_schedule(schedule_id: int, schedule: Schedule) -> dict[str, Any]:
    items = load_json_data("schedules")
    index, current = find_item(items, schedule_id)
    payload = model_dump(schedule)
    payload.update(
        {
            "id": schedule_id,
            "created_at": current.get("created_at"),
            "updated_at": datetime.now().isoformat(),
        }
    )
    items[index] = payload
    save_json_data("schedules", items)
    return payload


@app.delete("/api/schedules/{schedule_id}")
async def delete_schedule(schedule_id: int) -> dict[str, str]:
    items = load_json_data("schedules")
    find_item(items, schedule_id)
    save_json_data("schedules", [item for item in items if item.get("id") != schedule_id])
    return {"message": "Deleted"}


@app.get("/api/announcements", response_model=list[Announcement])
async def get_announcements() -> list[dict[str, Any]]:
    return load_json_data("announcements")


@app.post("/api/announcements", response_model=Announcement)
async def create_announcement(announcement: Announcement) -> dict[str, Any]:
    items = load_json_data("announcements")
    now = datetime.now().isoformat()
    payload = model_dump(announcement)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("announcements", items)
    return payload


@app.get("/api/announcements/{announcement_id}", response_model=Announcement)
async def get_announcement(announcement_id: int) -> dict[str, Any]:
    _, item = find_item(load_json_data("announcements"), announcement_id)
    return item


@app.put("/api/announcements/{announcement_id}", response_model=Announcement)
async def update_announcement(announcement_id: int, announcement: Announcement) -> dict[str, Any]:
    items = load_json_data("announcements")
    index, current = find_item(items, announcement_id)
    payload = model_dump(announcement)
    payload.update(
        {
            "id": announcement_id,
            "created_at": current.get("created_at"),
            "updated_at": datetime.now().isoformat(),
        }
    )
    items[index] = payload
    save_json_data("announcements", items)
    return payload


@app.delete("/api/announcements/{announcement_id}")
async def delete_announcement(announcement_id: int) -> dict[str, str]:
    items = load_json_data("announcements")
    find_item(items, announcement_id)
    save_json_data("announcements", [item for item in items if item.get("id") != announcement_id])
    return {"message": "Deleted"}


@app.post("/api/convert")
async def convert_audio(
    file: UploadFile = File(...),
    bitrate: int = Form(192),
    date: str = Form(""),
    piece: str = Form(""),
) -> dict[str, Any]:
    suffix = ensure_audio_file(file)
    if bitrate not in {128, 192, 320}:
        raise HTTPException(status_code=400, detail="bitrate must be 128, 192, or 320")

    date_dir = safe_segment(date, datetime.now().date().isoformat())
    piece_dir = safe_segment(piece, "uncategorized")
    output_dir = CONVERTED_DIR / date_dir / piece_dir
    source_path = save_upload_to_path(file, output_dir)
    output_path = convert_path_to_mp3(source_path, suffix, bitrate)

    duration_seconds = audio_duration_seconds(output_path)

    response = {
        "filename": output_path.name,
        "path": str(output_path.relative_to(UPLOAD_DIR).as_posix()),
        "bitrate": bitrate,
        "duration_seconds": duration_seconds,
        "download_url": f"/api/recordings/download/{output_path.relative_to(UPLOAD_DIR).as_posix()}",
        "source": "local",
        "message": "Converted",
    }

    if storage_enabled():
        storage_file = upload_file_to_drive(
            local_path=output_path,
            practice_date=date_dir,
            song_name=piece_dir,
        )
        storage_file["duration_seconds"] = duration_seconds
        logger.info("Google Cloud Storage upload complete: %s", storage_file)
        remember_drive_file(storage_file)
        response.update(
            {
                "drive_file_id": storage_file["id"],
                "share_link": storage_file.get("view_url") or storage_file.get("download_url"),
                "download_url": storage_file.get("download_url") or response["download_url"],
                "source": "google_cloud_storage",
                "message": "Converted and uploaded to Google Cloud Storage",
            }
        )

    return response


@app.get("/api/recordings")
async def get_recordings(limit: int = 200) -> dict[str, list[dict[str, Any]]]:
    safe_limit = max(1, min(limit, 1000))
    drive_files = [cloud_recording_metadata(item) for item in load_json_data("drive_files")]
    local_paths = sorted(
        CONVERTED_DIR.rglob("*.mp3"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )[:safe_limit]
    local_files = [local_recording_metadata(path) for path in local_paths]

    seen: set[str] = set()
    files: list[dict[str, Any]] = []
    for item in drive_files + local_files:
        key = str(item.get("object_name") or item.get("path") or item.get("id") or item.get("download_url"))
        if key in seen:
            continue
        seen.add(key)
        files.append(item)
        if len(files) >= safe_limit:
            break
    return {"files": files}


def local_recording_path(path: str) -> Path:
    requested = (UPLOAD_DIR / path).resolve()
    if not requested.is_file() or UPLOAD_DIR.resolve() not in requested.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return requested


@app.get("/api/recordings/play/{path:path}")
async def play_recording(path: str) -> FileResponse:
    requested = local_recording_path(path)
    return FileResponse(
        requested,
        media_type=mimetypes.guess_type(requested.name)[0] or "application/octet-stream",
    )


@app.get("/api/recordings/download/{path:path}")
async def download_recording(path: str) -> FileResponse:
    requested = local_recording_path(path)
    return FileResponse(requested, filename=requested.name)



@app.post("/api/recordings/download-zip")
async def download_recordings_zip(payload: RecordingDownloadZipRequest) -> StreamingResponse:
    if not payload.files:
        raise HTTPException(status_code=400, detail="files is required")

    buffer = io.BytesIO()
    used_names: dict[str, int] = {}

    def unique_name(name: str) -> str:
        safe_name = safe_upload_name(name or "recording.mp3")
        count = used_names.get(safe_name, 0)
        used_names[safe_name] = count + 1
        if count == 0:
            return safe_name
        path = Path(safe_name)
        return f"{path.stem}_{count + 1}{path.suffix}"

    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in payload.files:
            arcname = unique_name(item.name)
            if item.source == "google_cloud_storage":
                object_name = item.object_name.strip()
                if not object_name:
                    continue
                blob = get_storage_bucket().blob(object_name)
                if blob.exists():
                    archive.writestr(arcname, blob.download_as_bytes())
                continue

            path = item.path.strip()
            if not path:
                continue
            requested = local_recording_path(path)
            archive.write(requested, arcname=arcname)

    buffer.seek(0)
    filename = safe_upload_name(payload.filename or "recordings.zip")
    if not filename.lower().endswith(".zip"):
        filename = f"{filename}.zip"
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"}
    return StreamingResponse(buffer, media_type="application/zip", headers=headers)


@app.delete("/api/recordings")
async def delete_recording(payload: RecordingDeleteRequest) -> dict[str, str]:
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


def stream_storage_blob(object_name: str, download: bool) -> StreamingResponse:
    if not storage_enabled():
        raise HTTPException(status_code=503, detail="Google Cloud Storage is not configured")
    if not object_name:
        raise HTTPException(status_code=404, detail="File not found")

    blob = get_storage_bucket().blob(object_name)
    if not blob.exists():
        raise HTTPException(status_code=404, detail="File not found")

    blob.reload()
    filename = Path(object_name).name
    disposition = "attachment" if download else "inline"
    content_type = blob.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    headers = {
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(filename)}",
    }
    if blob.size is not None:
        headers["Content-Length"] = str(blob.size)

    def chunks():
        with blob.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(chunks(), media_type=content_type, headers=headers)


@app.get("/api/recordings/cloud/play/{object_name:path}")
async def play_cloud_recording(object_name: str) -> StreamingResponse:
    return stream_storage_blob(object_name, download=False)


@app.get("/api/recordings/cloud/download/{object_name:path}")
async def download_cloud_recording(object_name: str) -> StreamingResponse:
    return stream_storage_blob(object_name, download=True)


@app.post("/api/drive/upload")
async def upload_to_drive(
    file: UploadFile = File(...),
    bitrate: int = Form(192),
    date: str = Form(""),
    piece: str = Form(""),
) -> dict[str, Any]:
    suffix = ensure_audio_file(file)
    if bitrate not in {128, 192, 320}:
        raise HTTPException(status_code=400, detail="bitrate must be 128, 192, or 320")

    date_dir = safe_segment(date, datetime.now().date().isoformat())
    logger.info(f"date={date}")
    logger.info(f"piece={piece}")
    piece_dir = safe_segment(piece, "uncategorized")
    staging_path = save_upload_to_path(file, DRIVE_STAGING_DIR / date_dir / piece_dir)
    output_path = convert_path_to_mp3(staging_path, suffix, bitrate)
    duration_seconds = audio_duration_seconds(output_path)

    if not storage_enabled():
        return {
            "drive_file_id": None,
            "share_link": f"/api/recordings/download/{output_path.relative_to(UPLOAD_DIR).as_posix()}",
            "duration_seconds": duration_seconds,
            "source": "local",
            "message": "Google Cloud Storage is not configured. Saved locally.",
        }

    try:
        drive_item = upload_file_to_drive(output_path, date_dir, piece_dir)
        drive_item["duration_seconds"] = duration_seconds
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
        "message": "Uploaded to Google Cloud Storage",
    }


@app.post("/api/drive/direct-upload-session")
async def create_direct_upload_session(
    payload: DirectUploadSessionRequest,
    request: Request,
) -> dict[str, Any]:
    """Create a GCS resumable upload session.

    Large audio files must not be sent through Cloud Run because Cloud Run has
    an HTTP request size limit. This endpoint only creates a short-lived upload
    URL, and the browser uploads the file body directly to Cloud Storage.
    """
    suffix = Path(payload.filename or "").suffix.lower()
    if suffix not in {".wav", ".mp3"}:
        raise HTTPException(status_code=400, detail="Please upload a WAV or MP3 file")
    if not payload.date.strip():
        raise HTTPException(status_code=400, detail="練習日は必須です")
    if not payload.piece.strip():
        raise HTTPException(status_code=400, detail="曲名は必須です")
    if payload.bitrate not in {128, 192, 320}:
        raise HTTPException(status_code=400, detail="bitrate must be 128, 192, or 320")
    if not storage_enabled():
        raise HTTPException(status_code=503, detail="Google Cloud Storage is not configured")

    date_dir = safe_segment(payload.date, datetime.now().date().isoformat())
    piece_dir = safe_segment(payload.piece, "uncategorized")
    object_name = storage_object_name(date_dir, piece_dir, payload.filename)
    content_type = payload.content_type or mimetypes.guess_type(payload.filename)[0] or "application/octet-stream"

    try:
        blob = get_storage_bucket().blob(object_name)
        upload_url = blob.create_resumable_upload_session(
            content_type=content_type,
            size=payload.size or None,
            origin=request.headers.get("origin"),
        )
    except Exception as exc:
        logger.exception("Failed to create direct upload session")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to create direct upload session: {exc}",
        ) from exc

    return {
        "upload_url": upload_url,
        "object_name": object_name,
        "bucket": get_storage_bucket().name,
        "content_type": content_type,
    }


@app.post("/api/drive/direct-upload-complete")
async def complete_direct_upload(payload: DirectUploadCompleteRequest) -> dict[str, Any]:
    """Register metadata after the browser has uploaded directly to GCS."""
    if not storage_enabled():
        raise HTTPException(status_code=503, detail="Google Cloud Storage is not configured")

    if not payload.date.strip():
        raise HTTPException(status_code=400, detail="練習日は必須です")
    if not payload.piece.strip():
        raise HTTPException(status_code=400, detail="曲名は必須です")

    date_dir = safe_segment(payload.date, datetime.now().date().isoformat())
    piece_dir = safe_segment(payload.piece, "uncategorized")
    object_name = payload.object_name.strip().strip("/")
    if not object_name:
        raise HTTPException(status_code=400, detail="object_name is required")

    try:
        bucket = get_storage_bucket()
        blob = bucket.blob(object_name)
        if not blob.exists():
            raise HTTPException(status_code=404, detail="Uploaded file was not found in Cloud Storage")
        blob.reload()

        suffix = Path(payload.filename or object_name).suffix.lower()
        if suffix == ".wav":
            logger.info("Converting directly uploaded WAV to MP3: %s", object_name)
            blob, duration_seconds = convert_uploaded_storage_wav_to_mp3(
                bucket=bucket,
                source_blob=blob,
                date_dir=date_dir,
                piece_dir=piece_dir,
                filename=payload.filename or Path(object_name).name,
                bitrate=payload.bitrate,
            )
            object_name = blob.name
            filename = Path(object_name).name
        else:
            make_blob_public_if_configured(blob)
            duration_seconds = payload.duration_seconds
            filename = Path(payload.filename or object_name).name

        blob.reload()
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to verify or convert direct upload")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to verify or convert direct upload: {exc}",
        ) from exc

    url = blob.public_url if blob.public_url else storage_public_url(bucket.name, object_name)
    drive_item = {
        "id": object_name,
        "name": filename,
        "date": date_dir,
        "piece": piece_dir,
        "size": blob.size or payload.size,
        "duration_seconds": duration_seconds,
        "mime_type": blob.content_type or mimetypes.guess_type(object_name)[0] or "application/octet-stream",
        "modified_at": blob.updated.isoformat() if blob.updated else datetime.now().isoformat(),
        "bucket": bucket.name,
        "object_name": object_name,
        "web_view_link": url,
        "download_url": url,
        "view_url": url,
        "source": "google_cloud_storage",
    }
    remember_drive_file(drive_item)

    return {
        "drive_file_id": drive_item["id"],
        "share_link": drive_item.get("web_view_link") or drive_item.get("download_url"),
        "download_url": drive_item.get("download_url"),
        "source": "google_cloud_storage",
        "message": "Uploaded directly to Google Cloud Storage",
    }


@app.get("/api/drive/files")
async def get_drive_files() -> dict[str, list[dict[str, Any]]]:
    return {"files": load_json_data("drive_files")}


def ensure_portal_collection(collection: str) -> str:
    if collection not in PORTAL_DATA_NAMES:
        raise HTTPException(status_code=404, detail="Collection not found")
    return collection


def normalize_portal_payload(item: PortalItem | dict[str, Any], item_id: int | None = None) -> dict[str, Any]:
    payload = model_dump(item) if isinstance(item, BaseModel) else dict(item)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    now = datetime.now().isoformat()
    return {
        "id": item_id if item_id is not None else payload.get("id"),
        "created_at": payload.get("created_at") or now,
        "updated_at": now,
        "data": data,
    }


@app.get("/api/portal/{collection}")
async def list_portal_items(collection: str) -> dict[str, list[dict[str, Any]]]:
    collection = ensure_portal_collection(collection)
    return {"items": load_json_data(collection)}


@app.post("/api/portal/{collection}")
async def create_portal_item(collection: str, item: PortalItem) -> dict[str, Any]:
    collection = ensure_portal_collection(collection)
    items = load_json_data(collection)
    payload = normalize_portal_payload(item, next_id(items))
    items.insert(0, payload)
    save_json_data(collection, items)
    return payload


@app.put("/api/portal/{collection}/{item_id}")
async def update_portal_item(collection: str, item_id: int, item: PortalItem) -> dict[str, Any]:
    collection = ensure_portal_collection(collection)
    items = load_json_data(collection)
    index, current = find_item(items, item_id)
    payload = normalize_portal_payload(item, item_id)
    payload["created_at"] = current.get("created_at") or payload["created_at"]
    items[index] = payload
    save_json_data(collection, items)
    return payload


@app.delete("/api/portal/{collection}/{item_id}")
async def delete_portal_item(collection: str, item_id: int) -> dict[str, str]:
    collection = ensure_portal_collection(collection)
    items = load_json_data(collection)
    find_item(items, item_id)
    save_json_data(collection, [item for item in items if item.get("id") != item_id])
    return {"message": "Deleted"}


def ensure_upload_kind(kind: str) -> str:
    if kind not in {"sheets", "albums"}:
        raise HTTPException(status_code=404, detail="Upload kind not found")
    return kind


def portal_upload_dir(kind: str) -> Path:
    path = UPLOAD_DIR / "portal" / ensure_upload_kind(kind)
    path.mkdir(parents=True, exist_ok=True)
    return path


@app.post("/api/portal-files/{kind}")
async def upload_portal_file(
    kind: str,
    file: UploadFile = File(...),
    performance: str = Form(""),
    piece: str = Form(""),
    title: str = Form(""),
    member: str = Form(""),
    note: str = Form(""),
) -> dict[str, Any]:
    kind = ensure_upload_kind(kind)
    suffix = Path(file.filename or "").suffix.lower()
    if kind == "sheets" and suffix != ".pdf":
        raise HTTPException(status_code=400, detail="PDFファイルを選択してください")
    if kind == "albums" and suffix not in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
        raise HTTPException(status_code=400, detail="画像ファイルを選択してください")

    target_dir = portal_upload_dir(kind) / safe_segment(performance or "common", "common")
    if piece:
        target_dir = target_dir / safe_segment(piece, "piece")
    saved_path = save_upload_to_path(file, target_dir)
    rel = saved_path.relative_to(portal_upload_dir(kind)).as_posix()
    item = {
        "title": title or saved_path.stem,
        "name": saved_path.name,
        "performance": performance,
        "piece": piece,
        "member": member,
        "note": note,
        "size": saved_path.stat().st_size,
        "url": f"/api/portal-files/{kind}/{quote(rel, safe='/')}",
        "download_url": f"/api/portal-files/{kind}/{quote(rel, safe='/')}?download=1",
        "uploaded_at": datetime.now().isoformat(),
    }
    collection = "sheet_library" if kind == "sheets" else "albums"
    items = load_json_data(collection)
    payload = normalize_portal_payload({"data": item}, next_id(items))
    items.insert(0, payload)
    save_json_data(collection, items)
    return payload


@app.get("/api/portal-files/{kind}/{path:path}")
async def get_portal_file(kind: str, path: str, download: bool = False) -> FileResponse:
    root = portal_upload_dir(kind).resolve()
    requested = (root / path).resolve()
    if not requested.is_file() or root not in requested.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        requested,
        filename=requested.name if download else None,
        media_type=mimetypes.guess_type(requested.name)[0] or "application/octet-stream",
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
