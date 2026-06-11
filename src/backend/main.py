from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import shutil
import json
from google.oauth2 import service_account
from datetime import datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.auth import default as google_auth_default
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload
from pydantic import BaseModel, Field

try:
    from .drive_storage import upload_file_to_drive
except ImportError:  # pragma: no cover - allows running main.py directly.
    from drive_storage import upload_file_to_drive

try:
    from pydub import AudioSegment
except ImportError:  # pragma: no cover
    AudioSegment = None


load_dotenv()
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR = BASE_DIR / "uploads"
DATA_DIR = BASE_DIR / "data"
CONVERTED_DIR = UPLOAD_DIR / "converted"
DRIVE_STAGING_DIR = UPLOAD_DIR / "drive-staging"

DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"]
DRIVE_FOLDER_ID = os.getenv("GOOGLE_DRIVE_FOLDER_ID", "").strip()
DRIVE_PERMISSION_TYPE = os.getenv("GOOGLE_DRIVE_PERMISSION_TYPE", "anyone").strip()
DRIVE_PERMISSION_ROLE = os.getenv("GOOGLE_DRIVE_PERMISSION_ROLE", "reader").strip()
DRIVE_PERMISSION_DOMAIN = os.getenv("GOOGLE_DRIVE_PERMISSION_DOMAIN", "").strip()

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
    pieces: list[str] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None


class Schedule(BaseModel):
    id: int | None = None
    date: str
    time: str
    venue: str
    available_hours: str = ""
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


def model_dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump() if hasattr(model, "model_dump") else model.dict()


def data_file(name: str) -> Path:
    return DATA_DIR / f"{name}.json"


def load_json_data(name: str) -> list[dict[str, Any]]:
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


def save_json_data(name: str, data: list[dict[str, Any]]) -> None:
    path = data_file(name)
    tmp_path = path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
    tmp_path.replace(path)


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
        "download_url": f"/api/recordings/download/{rel}",
        "source": "local",
    }


def drive_enabled() -> bool:
    return bool(DRIVE_FOLDER_ID)


def drive_service():
    service_account_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()

    if not service_account_json:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON is not set")

    info = json.loads(service_account_json)

    credentials = service_account.Credentials.from_service_account_info(
        info,
        scopes=DRIVE_SCOPES,
    )

    logger.info(
        "Using Drive service account: %s",
        info.get("client_email"),
    )

    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def escape_drive_query(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def find_or_create_drive_folder(service, name: str, parent_id: str) -> str:
    safe_name = escape_drive_query(name)
    query = (
        "mimeType='application/vnd.google-apps.folder' "
        f"and name='{safe_name}' "
        f"and '{parent_id}' in parents "
        "and trashed=false"
    )
    result = (
        service.files()
        .list(
            q=query,
            spaces="drive",
            fields="files(id,name)",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        .execute()
    )
    folders = result.get("files", [])
    if folders:
        return folders[0]["id"]

    metadata = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    folder = (
        service.files()
        .create(body=metadata, fields="id", supportsAllDrives=True)
        .execute()
    )
    return folder["id"]


def apply_drive_permission(service, file_id: str) -> None:
    if DRIVE_PERMISSION_TYPE == "none":
        return

    permission: dict[str, str] = {
        "type": DRIVE_PERMISSION_TYPE,
        "role": DRIVE_PERMISSION_ROLE,
    }
    if DRIVE_PERMISSION_TYPE == "domain":
        if not DRIVE_PERMISSION_DOMAIN:
            raise HTTPException(status_code=500, detail="GOOGLE_DRIVE_PERMISSION_DOMAIN is required")
        permission["domain"] = DRIVE_PERMISSION_DOMAIN

    service.permissions().create(
        fileId=file_id,
        body=permission,
        fields="id",
        supportsAllDrives=True,
    ).execute()


def upload_path_to_drive(path: Path, date: str, piece: str) -> dict[str, Any]:
    if not drive_enabled():
        raise HTTPException(status_code=503, detail="Google Drive is not configured")

    service = drive_service()
    date_folder_id = find_or_create_drive_folder(service, safe_segment(date, "undated"), DRIVE_FOLDER_ID)
    piece_folder_id = find_or_create_drive_folder(service, safe_segment(piece, "uncategorized"), date_folder_id)
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    metadata = {"name": path.name, "parents": [piece_folder_id]}
    media = MediaFileUpload(str(path), mimetype=mime_type, resumable=True)

    file = (
        service.files()
        .create(
            body=metadata,
            media_body=media,
            fields="id,name,size,mimeType,webViewLink,webContentLink,modifiedTime",
            supportsAllDrives=True,
        )
        .execute()
    )
    apply_drive_permission(service, file["id"])

    item = {
        "id": file["id"],
        "name": file.get("name", path.name),
        "date": date,
        "piece": piece,
        "size": int(file.get("size", path.stat().st_size)),
        "mime_type": file.get("mimeType", mime_type),
        "modified_at": file.get("modifiedTime", datetime.now().isoformat()),
        "web_view_link": file.get("webViewLink"),
        "download_url": file.get("webContentLink") or file.get("webViewLink"),
        "source": "google_drive",
    }
    remember_drive_file(item)
    return item


def remember_drive_file(item: dict[str, Any]) -> None:
    items = load_json_data("drive_files")
    items = [existing for existing in items if existing.get("id") != item.get("id")]
    items.insert(0, item)
    save_json_data("drive_files", items[:500])


def save_upload_to_path(file: UploadFile, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    output_path = directory / safe_upload_name(file.filename or "audio")
    with output_path.open("wb") as target:
        shutil.copyfileobj(file.file, target)
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
        "drive_configured": str(drive_enabled()).lower(),
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
    bitrate: int = 192,
    date: str = "",
    piece: str = "",
) -> dict[str, Any]:
    suffix = ensure_audio_file(file)
    if bitrate not in {128, 192, 320}:
        raise HTTPException(status_code=400, detail="bitrate must be 128, 192, or 320")

    date_dir = safe_segment(date, datetime.now().date().isoformat())
    piece_dir = safe_segment(piece, "uncategorized")
    output_dir = CONVERTED_DIR / date_dir / piece_dir
    source_path = save_upload_to_path(file, output_dir)
    output_path = source_path.with_suffix(".mp3")

    if suffix == ".mp3":
        if source_path != output_path:
            source_path.replace(output_path)
    else:
        if AudioSegment is None:
            raise HTTPException(status_code=500, detail="pydub is not available")
        try:
            audio = AudioSegment.from_file(source_path)
            audio.export(output_path, format="mp3", bitrate=f"{bitrate}k")
            source_path.unlink(missing_ok=True)
        except Exception as exc:
            logger.exception("Audio conversion failed")
            raise HTTPException(
                status_code=500,
                detail="Audio conversion failed. Make sure ffmpeg is installed.",
            ) from exc

    response = {
        "filename": output_path.name,
        "path": str(output_path.relative_to(UPLOAD_DIR).as_posix()),
        "bitrate": bitrate,
        "download_url": f"/api/recordings/download/{output_path.relative_to(UPLOAD_DIR).as_posix()}",
        "source": "local",
        "message": "Converted",
    }

    drive_file = upload_file_to_drive(
        local_path=output_path,
        practice_date=date_dir,
        song_name=piece_dir,
    )
    print("Google Drive upload complete:", drive_file)
    response.update(
        {
            "drive_file_id": drive_file["id"],
            "share_link": drive_file.get("view_url") or drive_file.get("download_url"),
            "download_url": drive_file.get("download_url") or response["download_url"],
            "source": "google_drive",
            "message": "Converted and uploaded to Google Drive",
        }
    )

    return response


@app.get("/api/recordings")
async def get_recordings() -> dict[str, list[dict[str, Any]]]:
    drive_files = load_json_data("drive_files")
    local_files = [
        local_recording_metadata(path)
        for path in sorted(CONVERTED_DIR.rglob("*.mp3"), key=lambda item: item.stat().st_mtime, reverse=True)
    ]
    return {"files": drive_files + local_files}


@app.get("/api/recordings/download/{path:path}")
async def download_recording(path: str) -> FileResponse:
    requested = (UPLOAD_DIR / path).resolve()
    if not requested.is_file() or UPLOAD_DIR.resolve() not in requested.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(requested, filename=requested.name)


@app.post("/api/drive/upload")
async def upload_to_drive(
    file: UploadFile = File(...),
    date: str = "",
    piece: str = "",
) -> dict[str, Any]:
    ensure_audio_file(file)
    date_dir = safe_segment(date, datetime.now().date().isoformat())
    piece_dir = safe_segment(piece, "uncategorized")
    staging_path = save_upload_to_path(file, DRIVE_STAGING_DIR / date_dir / piece_dir)

    if not drive_enabled():
        return {
            "drive_file_id": None,
            "share_link": f"/api/recordings/download/{staging_path.relative_to(UPLOAD_DIR).as_posix()}",
            "source": "local",
            "message": "Google Drive is not configured. Saved locally.",
        }

    try:
        drive_item = upload_path_to_drive(staging_path, date_dir, piece_dir)
    except HttpError as exc:
        logger.exception("Google Drive upload failed")
        raise HTTPException(status_code=502, detail=f"Google Drive upload failed: {exc}") from exc

    return {
        "drive_file_id": drive_item["id"],
        "share_link": drive_item.get("web_view_link") or drive_item.get("download_url"),
        "download_url": drive_item.get("download_url"),
        "source": "google_drive",
        "message": "Uploaded to Google Drive",
    }


@app.get("/api/drive/files")
async def get_drive_files() -> dict[str, list[dict[str, Any]]]:
    return {"files": load_json_data("drive_files")}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
