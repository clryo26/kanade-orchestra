from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
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
JSON_DATA_NAMES = ("performances", "schedules", "announcements", "drive_files", "events", "members")

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
    performance_id: int | None = None
    performance_title: str = ""
    pieces: str = ""
    notes: str = ""
    created_at: str | None = None
    updated_at: str | None = None


class Announcement(BaseModel):
    id: int | None = None
    date: str
    content: str
    created_at: str | None = None
    updated_at: str | None = None


class EventAdjustment(BaseModel):
    id: int | None = None
    title: str
    date: str = ""
    deadline: str = ""
    url: str = ""
    notes: str = ""
    created_at: str | None = None
    updated_at: str | None = None


class Member(BaseModel):
    id: int | None = None
    name: str
    part: str = ""
    comment: str = ""
    created_at: str | None = None
    updated_at: str | None = None


class RecordingDeleteRequest(BaseModel):
    source: str
    object_name: str = ""
    path: str = ""


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
        try:
            cloud_data = load_json_from_storage(name)
        except json.JSONDecodeError as exc:
            logger.error("Invalid JSON in Cloud Storage data %s: %s", name, exc)
            raise HTTPException(status_code=500, detail=f"Cloud Storage {name}.json is invalid")
        except Exception as exc:
            logger.exception("Failed to load %s.json from Cloud Storage", name)
            raise HTTPException(
                status_code=502,
                detail=f"Failed to load {name}.json from Cloud Storage: {exc}",
            ) from exc
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
        "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        "path": rel,
        "play_url": f"/api/recordings/play/{rel}",
        "download_url": f"/api/recordings/download/{rel}",
        "source": "local",
    }


def cloud_recording_metadata(item: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(item)
    object_name = normalized.get("object_name") or normalized.get("id")
    if normalized.get("source") != "google_cloud_storage" or not object_name:
        return normalized

    encoded_object_name = quote(str(object_name), safe="/")
    normalized["object_name"] = object_name
    normalized["play_url"] = f"/api/recordings/cloud/play/{encoded_object_name}"
    normalized["download_url"] = f"/api/recordings/cloud/download/{encoded_object_name}"
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




@app.get("/api/members", response_model=list[Member])
async def get_members() -> list[dict[str, Any]]:
    return load_json_data("members")


@app.post("/api/members", response_model=Member)
async def create_member(member: Member) -> dict[str, Any]:
    items = load_json_data("members")
    now = datetime.now().isoformat()
    payload = model_dump(member)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("members", items)
    return payload


@app.put("/api/members/{member_id}", response_model=Member)
async def update_member(member_id: int, member: Member) -> dict[str, Any]:
    items = load_json_data("members")
    index, current = find_item(items, member_id)
    payload = model_dump(member)
    payload.update({
        "id": member_id,
        "created_at": current.get("created_at"),
        "updated_at": datetime.now().isoformat(),
    })
    items[index] = payload
    save_json_data("members", items)
    return payload


@app.delete("/api/members/{member_id}")
async def delete_member(member_id: int) -> dict[str, str]:
    items = load_json_data("members")
    find_item(items, member_id)
    save_json_data("members", [item for item in items if item.get("id") != member_id])
    return {"message": "Deleted"}


@app.get("/api/events", response_model=list[EventAdjustment])
async def get_events() -> list[dict[str, Any]]:
    return load_json_data("events")


@app.post("/api/events", response_model=EventAdjustment)
async def create_event(event: EventAdjustment) -> dict[str, Any]:
    items = load_json_data("events")
    now = datetime.now().isoformat()
    payload = model_dump(event)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("events", items)
    return payload


@app.put("/api/events/{event_id}", response_model=EventAdjustment)
async def update_event(event_id: int, event: EventAdjustment) -> dict[str, Any]:
    items = load_json_data("events")
    index, current = find_item(items, event_id)
    payload = model_dump(event)
    payload.update({
        "id": event_id,
        "created_at": current.get("created_at"),
        "updated_at": datetime.now().isoformat(),
    })
    items[index] = payload
    save_json_data("events", items)
    return payload


@app.delete("/api/events/{event_id}")
async def delete_event(event_id: int) -> dict[str, str]:
    items = load_json_data("events")
    find_item(items, event_id)
    save_json_data("events", [item for item in items if item.get("id") != event_id])
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

    response = {
        "filename": output_path.name,
        "path": str(output_path.relative_to(UPLOAD_DIR).as_posix()),
        "bitrate": bitrate,
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
async def get_recordings() -> dict[str, list[dict[str, Any]]]:
    drive_files = [cloud_recording_metadata(item) for item in load_json_data("drive_files")]
    local_files = [
        local_recording_metadata(path)
        for path in sorted(CONVERTED_DIR.rglob("*.mp3"), key=lambda item: item.stat().st_mtime, reverse=True)
    ]
    return {"files": drive_files + local_files}


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


def parse_range_header(range_header: str, total_size: int) -> tuple[int, int] | None:
    if not range_header or not range_header.startswith("bytes="):
        return None
    first_range = range_header.removeprefix("bytes=").split(",", 1)[0].strip()
    if "-" not in first_range:
        return None
    start_text, end_text = first_range.split("-", 1)
    if not start_text and not end_text:
        return None
    if start_text:
        start = int(start_text)
        end = int(end_text) if end_text else total_size - 1
    else:
        suffix_length = int(end_text)
        start = max(total_size - suffix_length, 0)
        end = total_size - 1
    if start >= total_size:
        return None
    return max(start, 0), min(end, total_size - 1)


def stream_storage_blob(object_name: str, download: bool, request: Request) -> Response | StreamingResponse:
    if not storage_enabled():
        raise HTTPException(status_code=503, detail="Google Cloud Storage is not configured")
    if not object_name:
        raise HTTPException(status_code=404, detail="File not found")

    blob = get_storage_bucket().blob(object_name)
    if not blob.exists():
        raise HTTPException(status_code=404, detail="File not found")

    blob.reload()
    filename = Path(object_name).name
    total_size = int(blob.size or 0)
    disposition = "attachment" if download else "inline"
    content_type = blob.content_type or mimetypes.guess_type(filename)[0] or "audio/mpeg"
    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(filename)}",
        "Cache-Control": "private, max-age=3600",
    }

    requested_range = None if download else parse_range_header(request.headers.get("range", ""), total_size)
    if requested_range:
        start, end = requested_range
        data = blob.download_as_bytes(start=start, end=end)
        headers = {
            **base_headers,
            "Content-Range": f"bytes {start}-{end}/{total_size}",
            "Content-Length": str(len(data)),
        }
        return Response(content=data, status_code=206, media_type=content_type, headers=headers)

    headers = dict(base_headers)
    if total_size:
        headers["Content-Length"] = str(total_size)

    def chunks():
        with blob.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(chunks(), media_type=content_type, headers=headers)


@app.get("/api/recordings/cloud/play/{object_name:path}")
async def play_cloud_recording(object_name: str, request: Request) -> Response | StreamingResponse:
    return stream_storage_blob(object_name, download=False, request=request)


@app.get("/api/recordings/cloud/download/{object_name:path}")
async def download_cloud_recording(object_name: str, request: Request) -> Response | StreamingResponse:
    return stream_storage_blob(object_name, download=True, request=request)


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

    if not storage_enabled():
        return {
            "drive_file_id": None,
            "share_link": f"/api/recordings/download/{output_path.relative_to(UPLOAD_DIR).as_posix()}",
            "source": "local",
            "message": "Google Cloud Storage is not configured. Saved locally.",
        }

    try:
        drive_item = upload_file_to_drive(output_path, date_dir, piece_dir)
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


@app.get("/api/drive/files")
async def get_drive_files() -> dict[str, list[dict[str, Any]]]:
    return {"files": load_json_data("drive_files")}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
