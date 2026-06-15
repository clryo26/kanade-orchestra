from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import shutil
import io
import zipfile
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
SHEET_DIR = UPLOAD_DIR / "sheets"
JSON_DATA_NAMES = ("performances", "schedules", "announcements", "drive_files", "events", "members", "absences", "event_responses", "sheet_library", "payments", "castings", "piece_infos", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "auth_devices")

for directory in (UPLOAD_DIR, DATA_DIR, CONVERTED_DIR, DRIVE_STAGING_DIR, SHEET_DIR):
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


class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: dict[str, Any]) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        return response


app.mount("/static", NoCacheStaticFiles(directory=STATIC_DIR), name="static")


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
    is_conductor_training: bool = False
    is_main_performance: bool = False
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
    start_time: str = ""
    deadline: str = ""
    url: str = ""
    notes: str = ""
    delete_phrase: str = ""
    created_at: str | None = None
    updated_at: str | None = None


class Member(BaseModel):
    id: int | None = None
    name: str = ""
    last_name: str = ""
    first_name: str = ""
    maiden_name: str = ""
    last_name_kana: str = ""
    first_name_kana: str = ""
    maiden_name_kana: str = ""
    part: str = ""
    photo_url: str = ""
    is_founder: bool = False
    is_recording_manager: bool = False
    is_sheet_manager: bool = False
    password: str = ""
    permission: str = "一般"
    joined_at: str = ""
    introducer: str = ""
    role: str = ""
    instrument_history: str = ""
    past_orchestras: str = ""
    comment: str = ""
    created_at: str | None = None
    updated_at: str | None = None


class RecordingDeleteRequest(BaseModel):
    source: str
    object_name: str = ""
    path: str = ""


class SheetDeleteRequest(BaseModel):
    performance_id: str
    piece: str = ""
    sheet_id: int | None = None


class SheetPartUpdateRequest(BaseModel):
    part: str = ""


class PortalLoginRequest(BaseModel):
    name: str = ""
    part: str = ""
    password: str
    device_id: str
    device_name: str = ""
    user_agent: str = ""


class MemberPasswordSetupRequest(BaseModel):
    name: str
    part: str = ""
    password: str


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


def compact_member_name(value: Any) -> str:
    return re.sub(r"[\s\u3000]+", "", str(value or "")).strip().lower()


def member_display_name(member: dict[str, Any]) -> str:
    full_name = f"{member.get('last_name') or ''}{member.get('first_name') or ''}"
    return full_name or str(member.get("name") or "")


def member_login_names(member: dict[str, Any]) -> set[str]:
    names = {
        member_display_name(member),
        f"{member.get('last_name') or ''}{member.get('first_name') or ''}",
        f"{member.get('last_name_kana') or ''}{member.get('first_name_kana') or ''}",
    }
    if member.get("maiden_name"):
        names.add(f"{member.get('maiden_name') or ''}{member.get('first_name') or ''}")
    if member.get("maiden_name_kana"):
        names.add(f"{member.get('maiden_name_kana') or ''}{member.get('first_name_kana') or ''}")
    return {compact_member_name(name) for name in names if compact_member_name(name)}


def find_member_by_login_name(items: list[dict[str, Any]], name: str, part: str = "") -> tuple[int, dict[str, Any]]:
    normalized = compact_member_name(name)
    if not normalized:
        raise HTTPException(status_code=400, detail="name is required")
    for index, item in enumerate(items):
        if normalized in member_login_names(item):
            if part and part != member_part(item):
                continue
            return index, item
    raise HTTPException(status_code=404, detail="Member not found")


def is_hidden_system_admin_login(login: PortalLoginRequest) -> bool:
    return login.name == "Administrator" and login.password == "systemadminadmin"


def member_part(member: dict[str, Any]) -> str:
    return str(member.get("part") or "")


@app.post("/api/auth/portal-login")
async def portal_login(login: PortalLoginRequest, request: Request) -> dict[str, Any]:
    if is_hidden_system_admin_login(login):
        member = {
            "id": None,
            "name": "Administrator",
            "part": "System",
            "permission": "システム管理者",
            "is_recording_manager": True,
            "is_sheet_manager": True,
            "hidden_user": True,
        }
    else:
        members = load_json_data("members")
        _, member = find_member_by_login_name(members, login.name, login.part)
        member_password = str(member.get("password") or "")
        if not member_password:
            return {
                "authenticated": False,
                "needs_password_setup": True,
                "member_id": member.get("id"),
            }
        if login.password != member_password:
            raise HTTPException(status_code=401, detail="Invalid member password")

    device_id = login.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required")

    devices = load_json_data("auth_devices")
    now = datetime.now().isoformat()
    existing = next((item for item in devices if item.get("device_id") == device_id), None)
    payload = {
        "device_id": device_id,
        "device_name": login.device_name or "Unknown device",
        "member_id": member.get("id"),
        "member_name": member_display_name(member),
        "member_part": member_part(member),
        "permission": member.get("permission") or "一般",
        "is_recording_manager": bool(member.get("is_recording_manager")),
        "is_sheet_manager": bool(member.get("is_sheet_manager")),
        "hidden_user": bool(member.get("hidden_user")),
        "user_agent": login.user_agent or request.headers.get("user-agent", ""),
        "authenticated_at": now,
        "last_seen_at": now,
    }
    if existing:
        existing.update(payload)
    else:
        payload["id"] = next_id(devices)
        devices.append(payload)
    save_json_data("auth_devices", devices)
    return {
        "authenticated": True,
        "device_id": device_id,
        "member_id": payload["member_id"],
        "member_name": payload["member_name"],
        "member_part": payload["member_part"],
        "permission": payload["permission"],
        "is_recording_manager": payload["is_recording_manager"],
        "is_sheet_manager": payload["is_sheet_manager"],
        "hidden_user": payload["hidden_user"],
    }


@app.post("/api/auth/member-password")
async def set_member_password(payload: MemberPasswordSetupRequest) -> dict[str, Any]:
    password = payload.password.strip()
    if not password:
        raise HTTPException(status_code=400, detail="password is required")
    members = load_json_data("members")
    index, member = find_member_by_login_name(members, payload.name, payload.part)
    if member.get("password"):
        raise HTTPException(status_code=409, detail="Member password is already set")
    member["password"] = password
    member["updated_at"] = datetime.now().isoformat()
    members[index] = member
    save_json_data("members", members)
    return {"password_registered": True, "member_id": member.get("id")}


@app.get("/api/auth/devices/{device_id}")
async def get_auth_device(device_id: str) -> dict[str, Any]:
    devices = load_json_data("auth_devices")
    item = next((device for device in devices if device.get("device_id") == device_id), None)
    if not item:
        return {"authenticated": False}
    item["last_seen_at"] = datetime.now().isoformat()
    save_json_data("auth_devices", devices)
    return {"authenticated": True, "device": item}


@app.get("/api/auth/devices")
async def get_auth_devices() -> list[dict[str, Any]]:
    return sorted(
        load_json_data("auth_devices"),
        key=lambda item: str(item.get("authenticated_at") or ""),
        reverse=True,
    )


@app.delete("/api/auth/devices/{device_id}")
async def delete_auth_device(device_id: str) -> dict[str, str]:
    devices = load_json_data("auth_devices")
    save_json_data("auth_devices", [item for item in devices if item.get("device_id") != device_id])
    return {"message": "Deleted"}


@app.get("/api/bootstrap")
async def get_bootstrap_data() -> dict[str, Any]:
    extra_names = ("absences", "event_responses", "sheet_library", "payments", "castings", "piece_infos", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings")
    extras = {name: load_json_data(name) for name in extra_names}
    return {
        "performances": load_json_data("performances"),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "events": load_json_data("events"),
        "members": load_json_data("members"),
        "recordings": recording_payload(),
        "sheets": {"files": sheet_payload()},
        "extras": extras,
        "auth_devices": await get_auth_devices(),
    }


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


def ensure_pdf_file(file: UploadFile) -> None:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix != ".pdf":
        raise HTTPException(status_code=400, detail="Please upload a PDF file")


def local_recording_metadata(path: Path) -> dict[str, Any]:
    stat = path.stat()
    rel = path.relative_to(UPLOAD_DIR).as_posix()
    parts = path.relative_to(CONVERTED_DIR).parts if path.is_relative_to(CONVERTED_DIR) else path.parts
    date = parts[0] if len(parts) >= 3 else ""
    piece = parts[1] if len(parts) >= 3 else ""
    duration_seconds = get_audio_duration_seconds(path)
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
        "duration_seconds": duration_seconds,
        "duration": format_duration(duration_seconds),
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


def sheet_payload() -> list[dict[str, Any]]:
    return [sheet_metadata(item) for item in load_json_data("sheet_library")]


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
                return blob.download_as_bytes()
        return None

    path = str(item.get("path") or "")
    if not path:
        return None
    try:
        return local_sheet_path(path).read_bytes()
    except HTTPException:
        return None


def recording_file_bytes(item: dict[str, Any]) -> bytes | None:
    if item.get("source") == "google_cloud_storage":
        object_name = str(item.get("object_name") or "")
        if object_name and storage_enabled():
            blob = get_storage_bucket().blob(object_name)
            if blob.exists():
                return blob.download_as_bytes()
        return None

    path = str(item.get("path") or "")
    if not path:
        return None
    try:
        return local_recording_path(path).read_bytes()
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


def get_audio_duration_seconds(path: Path) -> float | None:
    if AudioSegment is None:
        return None
    try:
        audio = AudioSegment.from_file(path)
        return round(len(audio) / 1000, 1)
    except Exception:
        logger.warning("Failed to get audio duration: %s", path, exc_info=True)
        return None


def format_duration(seconds: float | int | None) -> str:
    if seconds is None:
        return ""
    total = int(round(float(seconds)))
    minutes, sec = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{sec:02d}"
    return f"{minutes}:{sec:02d}"


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(
        BASE_DIR / "index.html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


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
    payload["name"] = member_display_name(payload)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("members", items)
    return payload


@app.put("/api/members/{member_id}", response_model=Member)
async def update_member(member_id: int, member: Member) -> dict[str, Any]:
    items = load_json_data("members")
    index, current = find_item(items, member_id)
    payload = model_dump(member)
    payload["name"] = member_display_name(payload)
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

    duration_seconds = get_audio_duration_seconds(output_path)
    response = {
        "filename": output_path.name,
        "path": str(output_path.relative_to(UPLOAD_DIR).as_posix()),
        "bitrate": bitrate,
        "download_url": f"/api/recordings/download/{output_path.relative_to(UPLOAD_DIR).as_posix()}",
        "source": "local",
        "duration_seconds": duration_seconds,
        "duration": format_duration(duration_seconds),
        "message": "Converted",
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
                "message": "Converted and uploaded to Google Cloud Storage",
            }
        )

    return response


def recording_payload() -> dict[str, list[dict[str, Any]]]:
    drive_files = [cloud_recording_metadata(item) for item in load_json_data("drive_files")]
    local_files = [
        local_recording_metadata(path)
        for path in sorted(CONVERTED_DIR.rglob("*.mp3"), key=lambda item: item.stat().st_mtime, reverse=True)
    ]
    return {"files": drive_files + local_files}


@app.get("/api/recordings")
async def get_recordings() -> dict[str, list[dict[str, Any]]]:
    return recording_payload()


@app.get("/api/recordings/download-zip")
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


def stream_storage_blob(object_name: str, download: bool, request: Request):
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
async def play_cloud_recording(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=False, request=request)


@app.get("/api/recordings/cloud/download/{object_name:path}")
async def download_cloud_recording(object_name: str, request: Request) :
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
    duration_seconds = get_audio_duration_seconds(output_path)

    if not storage_enabled():
        return {
            "drive_file_id": None,
            "share_link": f"/api/recordings/download/{output_path.relative_to(UPLOAD_DIR).as_posix()}",
            "source": "local",
            "duration_seconds": duration_seconds,
            "duration": format_duration(duration_seconds),
            "message": "Google Cloud Storage is not configured. Saved locally.",
        }

    try:
        drive_item = upload_file_to_drive(output_path, date_dir, piece_dir)
        drive_item["duration_seconds"] = duration_seconds
        drive_item["duration"] = format_duration(duration_seconds)
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


@app.get("/api/drive/files")
async def get_drive_files() -> dict[str, list[dict[str, Any]]]:
    return {"files": load_json_data("drive_files")}


@app.get("/api/sheets")
async def get_sheets() -> dict[str, list[dict[str, Any]]]:
    return {"files": sheet_payload()}


@app.get("/api/sheets/download/{path:path}")
async def download_local_sheet(path: str) -> FileResponse:
    requested = local_sheet_path(path)
    return FileResponse(requested, media_type="application/pdf", filename=requested.name)


@app.get("/api/sheets/view/{path:path}")
async def view_local_sheet(path: str) -> Response:
    requested = local_sheet_path(path)
    return Response(
        content=requested.read_bytes(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(requested.name)}",
            "Cache-Control": "private, max-age=3600",
        },
    )


@app.get("/api/sheets/cloud/download/{object_name:path}")
async def download_cloud_sheet(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=True, request=request)


@app.get("/api/sheets/cloud/view/{object_name:path}")
async def view_cloud_sheet(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=False, request=request)


@app.get("/api/sheets/download-zip")
async def download_sheets_zip(performance_id: str = "", piece: str = "", part: str = "") -> Response:
    if not performance_id:
        raise HTTPException(status_code=400, detail="performance_id is required")

    sheets = [
        item
        for item in load_json_data("sheet_library")
        if str(item.get("performance_id") or "") == str(performance_id)
        and (not piece or str(item.get("piece") or "") == piece)
        and (not part or str(item.get("part") or "") == part)
    ]
    if not sheets:
        raise HTTPException(status_code=404, detail="Sheets not found")

    buffer = io.BytesIO()
    used_names: set[str] = set()
    performance_title = sheets[0].get("performance_title") or "sheets"
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in sheets:
            data = sheet_file_bytes(item)
            if data is None:
                continue
            folder = safe_segment(str(item.get("piece") or "piece"), "piece")
            filename = unique_zip_name(str(item.get("name") or "score.pdf"), used_names)
            archive.writestr(f"{folder}/{filename}", data)

    if not buffer.tell():
        raise HTTPException(status_code=404, detail="Sheet files not found")

    zip_name = safe_segment(f"{performance_title}_{piece or 'all'}_{part or 'all-parts'}", "sheets") + ".zip"
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(zip_name)}",
            "Cache-Control": "private, max-age=60",
        },
    )


@app.post("/api/sheets/upload")
async def upload_sheet(
    file: UploadFile = File(...),
    performance_id: str = Form(""),
    performance_title: str = Form(""),
    piece: str = Form(""),
) -> dict[str, Any]:
    ensure_pdf_file(file)
    if not performance_id:
        raise HTTPException(status_code=400, detail="performance_id is required")
    if not piece:
        raise HTTPException(status_code=400, detail="piece is required")

    performance_dir = safe_segment(f"{performance_id}_{performance_title}", "performance")
    piece_dir = safe_segment(piece, "piece")
    file_name = safe_upload_name(file.filename or "score.pdf")
    now = datetime.now().isoformat()

    if storage_enabled():
        staging_path = save_upload_to_path(file, DRIVE_STAGING_DIR / "sheets" / performance_dir / piece_dir)
        object_name = "/".join(["sheets", performance_dir, piece_dir, staging_path.name])
        blob = get_storage_bucket().blob(object_name)
        blob.upload_from_filename(str(staging_path), content_type="application/pdf")
        blob.reload()
        item = {
            "name": staging_path.name,
            "performance_id": performance_id,
            "performance_title": performance_title,
            "piece": piece,
            "part": "",
            "size": blob.size or staging_path.stat().st_size,
            "mime_type": blob.content_type or "application/pdf",
            "modified_at": blob.updated.isoformat() if blob.updated else now,
            "source": "google_cloud_storage",
            "object_name": object_name,
        }
    else:
        local_path = save_upload_to_path(file, SHEET_DIR / performance_dir / piece_dir)
        rel = local_path.relative_to(UPLOAD_DIR).as_posix()
        item = {
            "name": local_path.name,
            "performance_id": performance_id,
            "performance_title": performance_title,
            "piece": piece,
            "part": "",
            "size": local_path.stat().st_size,
            "mime_type": "application/pdf",
            "modified_at": now,
            "source": "local",
            "path": rel,
        }

    items = load_json_data("sheet_library")
    payload = normalize_extra_payload(item)
    payload["id"] = next_id(items)
    items.insert(0, payload)
    save_json_data("sheet_library", items)
    return sheet_metadata(payload)


@app.put("/api/sheets/{sheet_id}/part")
async def update_sheet_part(sheet_id: int, payload: SheetPartUpdateRequest) -> dict[str, Any]:
    items = load_json_data("sheet_library")
    index, current = find_item(items, sheet_id)
    current["part"] = payload.part.strip()
    current["updated_at"] = datetime.now().isoformat()
    items[index] = current
    save_json_data("sheet_library", items)
    return sheet_metadata(current)


@app.delete("/api/sheets")
async def delete_sheets(payload: SheetDeleteRequest) -> dict[str, Any]:
    if not payload.performance_id:
        raise HTTPException(status_code=400, detail="performance_id is required")

    items = load_json_data("sheet_library")
    delete_ids: set[int] = set()
    for item in items:
        item_id = int(item.get("id", -1))
        if payload.sheet_id is not None:
            if item_id == payload.sheet_id:
                delete_ids.add(item_id)
        elif str(item.get("performance_id") or "") == str(payload.performance_id):
            if not payload.piece or str(item.get("piece") or "") == payload.piece:
                delete_ids.add(item_id)

    targets = [item for item in items if int(item.get("id", -1)) in delete_ids]
    for item in targets:
        delete_sheet_file(item)

    save_json_data("sheet_library", [item for item in items if int(item.get("id", -1)) not in delete_ids])
    return {"message": "Deleted", "deleted": len(targets)}


EXTRA_COLLECTIONS = {"absences", "event_responses", "sheet_library", "payments", "castings", "piece_infos", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings"}

def normalize_extra_payload(payload: dict[str, Any], item_id: int | None = None, current: dict[str, Any] | None = None) -> dict[str, Any]:
    now = datetime.now().isoformat()
    data = dict(payload or {})
    data.update({
        "id": item_id if item_id is not None else data.get("id"),
        "created_at": (current or {}).get("created_at") or data.get("created_at") or now,
        "updated_at": now,
    })
    return data

async def read_json_body(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        data = {}
    return data if isinstance(data, dict) else {}

def collection_items(name: str) -> list[dict[str, Any]]:
    if name not in EXTRA_COLLECTIONS:
        raise HTTPException(status_code=404, detail="Collection not found")
    return load_json_data(name)

@app.get("/api/extra/{name}")
async def get_extra_items(name: str) -> list[dict[str, Any]]:
    return collection_items(name)

@app.post("/api/extra/{name}")
async def create_extra_item(name: str, request: Request) -> dict[str, Any]:
    items = collection_items(name)
    payload = normalize_extra_payload(await read_json_body(request), next_id(items))
    items.append(payload)
    save_json_data(name, items)
    return payload

@app.put("/api/extra/{name}/{item_id}")
async def update_extra_item(name: str, item_id: int, request: Request) -> dict[str, Any]:
    items = collection_items(name)
    index, current = find_item(items, item_id)
    payload = normalize_extra_payload(await read_json_body(request), item_id, current)
    items[index] = payload
    save_json_data(name, items)
    return payload

@app.delete("/api/extra/{name}/{item_id}")
async def delete_extra_item(name: str, item_id: int) -> dict[str, str]:
    items = collection_items(name)
    find_item(items, item_id)
    save_json_data(name, [item for item in items if item.get("id") != item_id])
    return {"message": "Deleted"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
