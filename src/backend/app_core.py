from __future__ import annotations

import hashlib
import json
import logging
import mimetypes  # noqa: F401
import os
import re
import secrets
import shutil
import io
import zipfile  # noqa: F401
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile  # noqa: F401
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse  # noqa: F401
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from openpyxl import load_workbook
except ImportError:  # pragma: no cover
    load_workbook = None

try:
    import psycopg
    from psycopg import sql as psql
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover
    psycopg = None
    psql = None
    Jsonb = None

try:
    from .drive_storage import (
        get_storage_bucket,
        storage_enabled,
        upload_file_to_drive,  # noqa: F401
    )
except ImportError:  # pragma: no cover - allows running main.py directly.
    from drive_storage import (
        get_storage_bucket,
        storage_enabled,
        upload_file_to_drive,  # noqa: F401
    )

try:
    from .auth_helpers import (
        member_access_expired,
        member_display_name,
        member_login_names,
    )
except ImportError:  # pragma: no cover - allows running main.py directly.
    from auth_helpers import (
        member_access_expired,
        member_display_name,
        member_login_names,
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

# 縺薙・繝輔ぃ繧､繝ｫ縺ｯ繧｢繝励Μ蜈ｨ菴薙・ API 縺ｨ繝ｭ繝ｼ繧ｫ繝ｫ JSON 繧ｹ繝医Ξ繝ｼ繧ｸ縺ｮ莉ｲ莉句ｽｹ縲・
# 蝓ｺ譛ｬ譁ｹ驥昴・縲繰SON 繝輔ぃ繧､繝ｫ繧呈ｭ｣縺ｨ縺励▽縺､縲∝ｿ・ｦ√↑繧・Cloud Storage 縺ｫ繧ょ酔譛溘☆繧九肴ｧ区・縺ｧ縲・
# 繝輔Ο繝ｳ繝医お繝ｳ繝牙髄縺代↓縺ｯ隍・焚繧ｳ繝ｬ繧ｯ繧ｷ繝ｧ繝ｳ繧偵∪縺ｨ繧√◆ bootstrap API 繧よ署萓帙＠縺ｦ縺・ｋ縲・

# ===== 繝｡繝｢繝ｪ繧ｭ繝｣繝・す繝ｳ繧ｰ螻､ =====
class MemoryCache:
    """In-memory cache for JSON collections."""
    def __init__(self):
        self._cache: dict[str, list[dict[str, Any]]] = {}
        self._etags: dict[str, str] = {}
        self._indexes: dict[str, dict[str, dict[str, Any]]] = {}  # name -> index_type -> index
    
    def get(self, name: str) -> list[dict[str, Any]] | None:
        """Return cached collection data."""
        return self._cache.get(name)
    
    def set(self, name: str, data: list[dict[str, Any]]) -> None:
        """Cache collection data and update its ETag."""
        self._cache[name] = data
        # JSON繧呈枚蟄怜・蛹悶＠縺ｦSHA256繝上ャ繧ｷ繝･繧堤函謌・
        json_str = json.dumps(data, ensure_ascii=False, sort_keys=True)
        self._etags[name] = hashlib.sha256(json_str.encode()).hexdigest()
        # 繧､繝ｳ繝・ャ繧ｯ繧ｹ繧偵Μ繧ｻ繝・ヨ
        self._indexes.pop(name, None)
    
    def clear(self, name: str | None = None) -> None:
        """Clear one collection cache or all cached collections."""
        if name:
            self._cache.pop(name, None)
            self._etags.pop(name, None)
            self._indexes.pop(name, None)
        else:
            self._cache.clear()
            self._etags.clear()
            self._indexes.clear()
    
    def etag(self, name: str) -> str | None:
        """Return the cached ETag for a collection."""
        return self._etags.get(name)
    
    def get_index(self, name: str, index_type: str = "id") -> dict[str, Any] | None:
        """Return a cached index for a collection."""
        data = self._cache.get(name)
        if not data:
            return None

        per_name_indexes = self._indexes.setdefault(name, {})
        if index_type not in per_name_indexes:
            if index_type == "id":
                # ID繧､繝ｳ繝・ャ繧ｯ繧ｹ・夐ｫ倬櫑D讀懃ｴ｢逕ｨ
                per_name_indexes[index_type] = {item.get("id"): (idx, item) for idx, item in enumerate(data)}
            elif index_type == "member_login":
                # 繝｡繝ｳ繝舌・繝ｭ繧ｰ繧､繝ｳ繧､繝ｳ繝・ャ繧ｯ繧ｹ・壽ｭ｣隕丞喧縺輔ｌ縺溷錐蜑阪°繧画､懃ｴ｢
                member_index: dict[str, Any] = {}
                for idx, item in enumerate(data):
                    for name_variant in member_login_names(item):
                        member_index[name_variant] = (idx, item)
                per_name_indexes[index_type] = member_index
            else:
                return None

        return per_name_indexes.get(index_type)

_memory_cache = MemoryCache()

if AudioSegment is not None and imageio_ffmpeg is not None:
    AudioSegment.converter = imageio_ffmpeg.get_ffmpeg_exe()

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR = BASE_DIR / "uploads"
DATA_DIR = BASE_DIR / "data"
SAMPLE_DIR = BASE_DIR.parent / "sample"
TIMETABLE_TEMPLATE_PATH = SAMPLE_DIR / "本番タイムテーブル.xlsx"
CONVERTED_DIR = UPLOAD_DIR / "converted"
DRIVE_STAGING_DIR = UPLOAD_DIR / "drive-staging"
SHEET_DIR = UPLOAD_DIR / "sheets"
JSON_DATA_NAMES = ("performances", "schedules", "announcements", "drive_files", "events", "members", "absences", "event_responses", "date_adjustments", "date_adjustment_responses", "sheet_library", "payments", "castings", "piece_infos", "practice_instructions", "performance_day_infos", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "auth_devices", "access_logs", "recording_metadata", "desired_pieces", "promotions")
STARTUP_PRELOAD_COLLECTIONS = ("performances", "schedules", "announcements", "events", "members", "payments", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings")

for directory in (UPLOAD_DIR, DATA_DIR, CONVERTED_DIR, DRIVE_STAGING_DIR, SHEET_DIR):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="Orchestra Activity Tool",
    description="Performance, practice schedule, announcement, and recording management.",
    version="1.0.0",
)

# CORS_ORIGINS 迺ｰ蠅・､画焚縺ｧ險ｱ蜿ｯ繧ｪ繝ｪ繧ｸ繝ｳ繧偵き繝ｳ繝槫玄蛻・ｊ縺ｧ險ｭ螳壹〒縺阪ｋ縲・
# 譛ｪ險ｭ螳壹・蝣ｴ蜷医・繝ｭ繝ｼ繧ｫ繝ｫ髢狗匱蜷代￠縺ｫ繝ｯ繧､繝ｫ繝峨き繝ｼ繝峨ｒ邯咏ｶ壹＠縺ｦ菴ｿ逕ｨ縺吶ｋ縲・
# 萓・ CORS_ORIGINS=https://sites.google.com,https://kanade-portal-xxx.run.app
_cors_env = os.getenv("CORS_ORIGINS", "").strip()
_cors_origins: list[str] = [o.strip() for o in _cors_env.split(",") if o.strip()] if _cors_env else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)


class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: dict[str, Any]) -> Response:
        response = await super().get_response(path, scope)
        # 髱咏噪繝輔ぃ繧､繝ｫ縺ｯ繝悶Λ繧ｦ繧ｶ繧ｭ繝｣繝・す繝･繧定ｨｱ蜿ｯ縺励※蛻晏屓莉･髯阪・陦ｨ遉ｺ繧帝ｫ倬溷喧縺吶ｋ縲・
        # index.html 縺ｯ荳九・繝ｫ繝ｼ繝医〒 no-store 縺ｫ縺励※縲∫判髱｢譛ｬ菴薙・譖ｴ譁ｰ貍上ｌ繧帝亟縺舌・
        if path.endswith((".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".webmanifest", ".ico")):
            response.headers["Cache-Control"] = "public, max-age=3600"
        else:
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
    flyer_image: str = ""
    performance_fee_amount: float = 0
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
    title: str = ""
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
    fee: str = ""
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
    password_set: bool = False
    permission: str = "荳闊ｬ"
    joined_at: str = ""
    system_access_until: str = ""
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


class SheetBulkPartUpdateRequest(BaseModel):
    sheet_ids: list[int] = []
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


class ExtraUpsertRequest(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)
    expected_updated_at: str = ""


def model_dump(model: BaseModel) -> dict[str, Any]:
    # Pydantic v1/v2 荳｡蟇ｾ蠢懊〒霎樊嶌蛹悶☆繧九◆繧√・莠呈鋤繝倥Ν繝代・縲・
    return model.model_dump() if hasattr(model, "model_dump") else model.dict()


def normalize_bool_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return "true"
    if text in {"0", "false", "no", "off"}:
        return "false"
    return ""


def candidate_sort_key(candidate: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(candidate.get("date") or ""),
        str(candidate.get("start_time") or ""),
        str(candidate.get("end_time") or ""),
    )


def validate_date_adjustment_payload(payload: dict[str, Any]) -> dict[str, Any]:
    title = str(payload.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")

    raw_candidates = payload.get("candidates")
    if not isinstance(raw_candidates, list) or not raw_candidates:
        raise HTTPException(status_code=400, detail="candidates is required")

    normalized_candidates: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str, str]] = set()
    for index, item in enumerate(raw_candidates):
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail=f"candidates[{index}] must be object")
        date = str(item.get("date") or "").strip()
        start_time = str(item.get("start_time") or "").strip()
        end_time = str(item.get("end_time") or "").strip()
        note = str(item.get("note") or "").strip()
        if not date:
            raise HTTPException(status_code=400, detail=f"candidates[{index}].date is required")
        candidate_id = str(item.get("id") or f"cand-{index + 1}").strip()
        normalized = {
            "id": candidate_id,
            "date": date,
            "start_time": start_time,
            "end_time": end_time,
            "note": note,
        }
        key = candidate_sort_key(normalized)
        if key in seen_keys:
            raise HTTPException(status_code=400, detail="duplicate candidates are not allowed")
        seen_keys.add(key)
        normalized_candidates.append(normalized)

    data = dict(payload)
    data["title"] = title
    data["deadline"] = str(payload.get("deadline") or "").strip()
    data["notes"] = str(payload.get("notes") or "").strip()
    data["delete_phrase"] = str(payload.get("delete_phrase") or "").strip()
    data["created_by"] = str(payload.get("created_by") or "").strip()
    data["member_id"] = payload.get("member_id")
    data["candidates"] = normalized_candidates
    return data


def validate_date_adjustment_response_payload(payload: dict[str, Any]) -> dict[str, Any]:
    adjustment_id = payload.get("adjustment_id")
    candidate_id = str(payload.get("candidate_id") or "").strip()
    name = str(payload.get("name") or "").strip()
    status = str(payload.get("status") or "").strip().lower()
    if adjustment_id in {None, ""}:
        raise HTTPException(status_code=400, detail="adjustment_id is required")
    if not candidate_id:
        raise HTTPException(status_code=400, detail="candidate_id is required")
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if status not in {"ok", "maybe", "ng"}:
        raise HTTPException(status_code=400, detail="status must be one of ok/maybe/ng")

    data = dict(payload)
    data["candidate_id"] = candidate_id
    data["name"] = name
    data["status"] = status
    data["note"] = str(payload.get("note") or "").strip()
    return data


def validate_connection_settings_payload(payload: dict[str, Any]) -> dict[str, Any]:
    data = dict(payload)
    data["google_project_id"] = str(payload.get("google_project_id") or "").strip()
    data["google_cloud_storage_bucket"] = str(payload.get("google_cloud_storage_bucket") or "").strip()
    data["google_cloud_storage_data_prefix"] = str(payload.get("google_cloud_storage_data_prefix") or "").strip()
    data["google_cloud_storage_public"] = normalize_bool_text(payload.get("google_cloud_storage_public"))
    data["google_service_account_file"] = str(payload.get("google_service_account_file") or "").strip()
    data["google_service_account_json"] = str(payload.get("google_service_account_json") or "").strip()
    return data


def normalize_extra_for_collection(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    if name == "date_adjustments":
        return validate_date_adjustment_payload(payload)
    if name == "date_adjustment_responses":
        return validate_date_adjustment_response_payload(payload)
    if name == "connection_settings":
        return validate_connection_settings_payload(payload)
    return payload


def normalize_clock_text(value: Any) -> str:
    match = re.match(r"^(\d{1,2}):(\d{2})$", str(value or "").strip())
    if not match:
        return ""
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return ""
    return f"{hour:02d}:{minute:02d}"


def add_minutes_to_clock_text(start: str, minutes: Any) -> str:
    normalized_start = normalize_clock_text(start)
    if not normalized_start:
        return ""
    try:
        add = int(str(minutes or "").strip())
    except ValueError:
        return ""
    hour, minute = [int(part) for part in normalized_start.split(":")]
    total = hour * 60 + minute + add
    normalized_total = total % (24 * 60)
    return f"{normalized_total // 60:02d}:{normalized_total % 60:02d}"


def performance_piece_labels(piece: Any) -> list[str]:
    if isinstance(piece, str):
        text = piece.strip()
        return [text] if text else []
    if not isinstance(piece, dict):
        return []
    composer = str(piece.get("composer") or "").strip()
    title = str(piece.get("title") or piece.get("name") or "").strip()
    alias = str(piece.get("alias") or piece.get("short_name") or "").strip()
    labels = [title, alias]
    if composer and title:
        labels.append(f"{composer}: {title}")
    return [label for label in labels if label]


def infer_duration_from_content(content: str, performance: dict[str, Any]) -> str:
    normalized_content = str(content or "").strip()
    if not normalized_content:
        return ""
    pieces = performance.get("pieces") if isinstance(performance.get("pieces"), list) else []
    for piece in pieces:
        if not isinstance(piece, dict):
            continue
        duration = str(piece.get("duration") or piece.get("duration_minutes") or "").strip()
        if not duration:
            continue
        labels = performance_piece_labels(piece)
        if any(label and label in normalized_content for label in labels):
            return duration
    return ""


def parse_timeline_text_rows(text: str, performance: dict[str, Any]) -> list[dict[str, Any]]:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        start_time = ""
        end_time = ""
        duration_minutes = ""
        content = line

        match = re.match(r"^(\d{1,2}:\d{2})\s*[-~～]\s*(\d{1,2}:\d{2})\s+(.+)$", line)
        if match:
            start_time = normalize_clock_text(match.group(1))
            end_time = normalize_clock_text(match.group(2))
            content = match.group(3).strip()
            if start_time and end_time:
                sh, sm = [int(part) for part in start_time.split(":")]
                eh, em = [int(part) for part in end_time.split(":")]
                diff = (eh * 60 + em) - (sh * 60 + sm)
                if diff < 0:
                    diff += 24 * 60
                duration_minutes = str(diff)
        else:
            match = re.match(r"^(\d{1,2}:\d{2})\s+(\d{1,3})\s*(?:分|蛻・)\s+(.+)$", line)
            if match:
                start_time = normalize_clock_text(match.group(1))
                duration_minutes = match.group(2).strip()
                content = match.group(3).strip()
                end_time = add_minutes_to_clock_text(start_time, duration_minutes)
            else:
                match = re.match(r"^(\d{1,2}:\d{2})\s+(.+)$", line)
                if match:
                    start_time = normalize_clock_text(match.group(1))
                    content = match.group(2).strip()
                    duration_minutes = infer_duration_from_content(content, performance)
                    end_time = add_minutes_to_clock_text(start_time, duration_minutes) if duration_minutes else ""

        rows.append(
            {
                "sort_order": index + 1,
                "start_time": start_time,
                "end_time": end_time,
                "duration_minutes": duration_minutes,
                "section": "",
                "content": content,
                "mc": "",
                "reception": "",
                "setting": "",
                "note": "",
                "source_line": line,
            }
        )
    return [row for row in rows if row.get("content") or row.get("start_time")]


def normalized_timeline_rows(info: dict[str, Any], performance: dict[str, Any]) -> list[dict[str, Any]]:
    timeline_rows = info.get("timeline_rows") if isinstance(info.get("timeline_rows"), list) else []
    if timeline_rows:
        rows: list[dict[str, Any]] = []
        for index, row in enumerate(timeline_rows):
            if not isinstance(row, dict):
                continue
            rows.append(
                {
                    "sort_order": int(row.get("sort_order") or index + 1),
                    "start_time": normalize_clock_text(row.get("start_time") or row.get("start") or ""),
                    "end_time": normalize_clock_text(row.get("end_time") or row.get("end") or ""),
                    "duration_minutes": str(row.get("duration_minutes") or row.get("duration") or "").strip(),
                    "section": str(row.get("section") or row.get("category") or "").strip(),
                    "content": str(row.get("content") or row.get("title") or "").strip(),
                    "mc": str(row.get("mc") or "").strip(),
                    "reception": str(row.get("reception") or row.get("desk") or "").strip(),
                    "setting": str(row.get("setting") or "").strip(),
                    "note": str(row.get("note") or "").strip(),
                }
            )
        return [row for row in rows if row.get("content") or row.get("start_time") or row.get("section")]
    return parse_timeline_text_rows(str(info.get("timeline") or info.get("timetable") or ""), performance)


def parse_assignment_rows(info: dict[str, Any]) -> list[dict[str, str]]:
    rows = info.get("assignments_rows") if isinstance(info.get("assignments_rows"), list) else []
    if rows:
        normalized: list[dict[str, str]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            role = str(row.get("role") or row.get("duty") or "").strip()
            members = str(row.get("members") or row.get("name") or "").strip()
            if role or members:
                normalized.append({"role": role, "members": members})
        return normalized

    text = str(info.get("assignments") or info.get("duties") or "")
    parsed: list[dict[str, str]] = []
    for line in [line.strip() for line in text.splitlines() if line.strip()]:
        parts = re.split(r"[:・咯", line, maxsplit=1)
        if len(parts) == 2:
            parsed.append({"role": parts[0].strip(), "members": parts[1].strip()})
        else:
            parsed.append({"role": "", "members": line})
    return parsed


def choose_assignment_value(rows: list[dict[str, str]], keywords: list[str]) -> str:
    for row in rows:
        role = str(row.get("role") or "").strip().lower()
        if role and any(keyword in role for keyword in keywords):
            return str(row.get("members") or "").strip()
    return ""


def compact_assignment_text(rows: list[dict[str, str]], excluded_keywords: list[str]) -> str:
    results: list[str] = []
    for row in rows:
        role = str(row.get("role") or "").strip()
        members = str(row.get("members") or "").strip()
        if role and any(keyword in role.lower() for keyword in excluded_keywords):
            continue
        if role and members:
            results.append(f"{role}: {members}")
        elif role:
            results.append(role)
        elif members:
            results.append(members)
    return " / ".join(results)


def clock_to_time(value: str) -> time | None:
    normalized = normalize_clock_text(value)
    if not normalized:
        return None
    hour, minute = [int(part) for part in normalized.split(":")]
    return time(hour=hour, minute=minute)


def excel_safe_filename(text: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|]", "_", str(text or "").strip())
    return cleaned or "performance_timetable"


def excel_row_count_from_template(ws: Any) -> int:
    # 繝・Φ繝励Ξ繝ｼ繝医・ B4:B23 縺梧悽菴薙・蝗ｺ螳壽棧・・0陦鯉ｼ峨ょｰ・擂螟画峩譎ゅ・縺薙％縺ｧ閾ｪ蜍戊ｿｽ蠕薙☆繧九・
    if ws.merged_cells and ws.merged_cells.ranges:
        for merged in ws.merged_cells.ranges:
            if merged.min_col == 2 and merged.max_col == 2 and merged.min_row <= 4 and merged.max_row >= 4:
                return max(1, merged.max_row - 4 + 1)
    return 20


def set_sheet_value_if_writable(sheet: Any, cell_ref: str, value: Any) -> None:
    cell = sheet[cell_ref]
    # 繝・Φ繝励Ξ繝ｼ繝医・邨仙粋繧ｻ繝ｫ縺ｯ蟾ｦ荳翫そ繝ｫ莉･螟悶′ read-only 縺ｫ縺ｪ繧九◆繧√√◎縺ｮ蝣ｴ蜷医・繧ｹ繧ｭ繝・・縺吶ｋ縲・
    if cell.__class__.__name__ == "MergedCell":
        return
    cell.value = value


def performance_day_info_for_performance(performance_id: int) -> dict[str, Any] | None:
    rows = load_json_data("performance_day_infos")
    return next((item for item in rows if str(item.get("performance_id") or "") == str(performance_id)), None)


def build_timetable_workbook_bytes(performance: dict[str, Any], info: dict[str, Any]) -> bytes:
    if load_workbook is None:
        raise HTTPException(status_code=500, detail="openpyxl is required for Excel export")
    if not TIMETABLE_TEMPLATE_PATH.exists():
        raise HTTPException(status_code=500, detail="Timetable template not found")

    workbook = load_workbook(TIMETABLE_TEMPLATE_PATH)
    sheet = workbook.active

    # B4 縺ｯ譌･莉假ｼ・4:B23 縺ｮ邨仙粋蜈磯ｭ繧ｻ繝ｫ・・
    raw_date = str(performance.get("date") or "").strip()
    try:
        sheet["B4"] = datetime.fromisoformat(raw_date).date() if raw_date else ""
    except ValueError:
        sheet["B4"] = raw_date

    timeline_rows = sorted(
        normalized_timeline_rows(info, performance),
        key=lambda row: int(row.get("sort_order") or 0),
    )
    assignment_rows = parse_assignment_rows(info)
    default_mc = choose_assignment_value(assignment_rows, ["mc", "蜿ｸ莨・"])
    default_reception = choose_assignment_value(assignment_rows, ["蜿嶺ｻ・", "繝√こ繝・ヨ"])
    default_setting = choose_assignment_value(assignment_rows, ["繧ｻ繝・ユ繧｣繝ｳ繧ｰ", "險ｭ蝟ｶ", "闊槫床"])
    assignment_note = compact_assignment_text(
        assignment_rows,
        ["mc", "蜿ｸ莨・", "蜿嶺ｻ・", "繝√こ繝・ヨ", "繧ｻ繝・ユ繧｣繝ｳ繧ｰ", "險ｭ蝟ｶ", "闊槫床"],
    )

    row_count = excel_row_count_from_template(sheet)
    base_row = 4
    for offset in range(row_count):
        row_no = base_row + offset
        row = timeline_rows[offset] if offset < len(timeline_rows) else {}

        start_time = clock_to_time(str(row.get("start_time") or ""))
        end_time = clock_to_time(str(row.get("end_time") or ""))
        duration_text = str(row.get("duration_minutes") or "").strip()

        set_sheet_value_if_writable(sheet, f"C{row_no}", start_time if start_time else "")
        set_sheet_value_if_writable(sheet, f"D{row_no}", end_time if end_time else "")
        set_sheet_value_if_writable(sheet, f"E{row_no}", int(duration_text) if duration_text.isdigit() else "")
        set_sheet_value_if_writable(sheet, f"F{row_no}", str(row.get("section") or "").strip())
        set_sheet_value_if_writable(sheet, f"G{row_no}", str(row.get("content") or "").strip())
        set_sheet_value_if_writable(sheet, f"H{row_no}", str(row.get("mc") or "").strip() or (default_mc if row_no == base_row else ""))
        set_sheet_value_if_writable(sheet, f"I{row_no}", str(row.get("reception") or "").strip() or (default_reception if row_no == base_row else ""))
        set_sheet_value_if_writable(sheet, f"J{row_no}", str(row.get("setting") or "").strip() or (default_setting if row_no == base_row else ""))
        note = str(row.get("note") or "").strip()
        set_sheet_value_if_writable(sheet, f"K{row_no}", note or (assignment_note if row_no == base_row else ""))

    buffer = io.BytesIO()
    workbook.save(buffer)
    buffer.seek(0)
    return buffer.getvalue()


# ===== 繝代せ繝ｯ繝ｼ繝峨ワ繝・す繝･繝ｦ繝ｼ繝・ぅ繝ｪ繝・ぅ =====
# PBKDF2-SHA256 繧剃ｽｿ縺｣縺溘ワ繝・す繝･蛹悶りｿｽ蜉繝ｩ繧､繝悶Λ繝ｪ荳崎ｦ√・
# 繝上ャ繧ｷ繝･蠖｢蠑・ "pbkdf2$sha256$<iterations>$<salt>$<hex_hash>"
# 譌ｧ蠖｢蠑擾ｼ医・繝ｬ繝ｼ繝ｳ繝・く繧ｹ繝茨ｼ峨・繝励Ξ繝輔ぅ繝・け繧ｹ縺ｪ縺励・

_PBKDF2_ALGO = "sha256"
_PBKDF2_ITERATIONS = 260000  # OWASP 2023謗ｨ螂ｨ蛟､


def hash_password(password: str) -> str:
    """Hash a password with PBKDF2-SHA256."""
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(_PBKDF2_ALGO, password.encode(), salt.encode(), _PBKDF2_ITERATIONS)
    return f"pbkdf2${_PBKDF2_ALGO}${_PBKDF2_ITERATIONS}${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Compare a submitted password with a stored password value."""
    if not stored:
        return False
    if not stored.startswith("pbkdf2$"):
        # 譌ｧ蠖｢蠑・ 繝励Ξ繝ｼ繝ｳ繝・く繧ｹ繝医・螳壽焚譎る俣豈碑ｼ・ｼ医ち繧､繝溘Φ繧ｰ繧｢繧ｿ繝・け蟇ｾ遲厄ｼ・
        return secrets.compare_digest(password.encode(), stored.encode())
    try:
        _, algo, iterations_str, salt, stored_hash = stored.split("$")
        dk = hashlib.pbkdf2_hmac(algo, password.encode(), salt.encode(), int(iterations_str))
        return secrets.compare_digest(dk.hex(), stored_hash)
    except (ValueError, TypeError):
        return False


def is_hashed_password(stored: str) -> bool:
    """Return whether a stored password already uses the hash format."""
    return stored.startswith("pbkdf2$")


def prepare_member_payload(member: Member, current: dict[str, Any] | None = None) -> dict[str, Any]:
    # 邂｡逅・判髱｢縺九ｉ譁ｰ繝代せ繝ｯ繝ｼ繝峨′騾√ｉ繧後◆蝣ｴ蜷医□縺代ワ繝・す繝･蛹悶＠縲・
    # 譛ｪ蜈･蜉帶峩譁ｰ縺ｧ縺ｯ譌｢蟄倥ワ繝・す繝･繧剃ｿ晄戟縺吶ｋ縲ょ・繝代せ繝ｯ繝ｼ繝峨・蠕ｩ蜈・・陦後ｏ縺ｪ縺・・
    payload = model_dump(member)
    raw_password = str(payload.get("password") or "")
    if raw_password:
        payload["password"] = raw_password if is_hashed_password(raw_password) else hash_password(raw_password)
    elif current is not None:
        payload["password"] = current.get("password") or ""
    else:
        payload["password"] = ""
    payload.pop("password_set", None)
    payload["name"] = member_display_name(payload)
    return payload


def public_member_payload(member: dict[str, Any]) -> dict[str, Any]:
    # API繝ｬ繧ｹ繝昴Φ繧ｹ繧・bootstrap 縺ｫ縺ｯ隱崎ｨｼ逕ｨ繝上ャ繧ｷ繝･繧貞・縺輔★縲∬ｨｭ螳壽怏辟｡縺縺代ｒ霑斐☆縲・
    payload = dict(member)
    payload["password_set"] = bool(payload.get("password"))
    payload["password"] = ""
    return payload


def public_member_list(members: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [public_member_payload(member) for member in members]


def device_auth_record(device_id: str) -> dict[str, Any]:
    if not device_id:
        raise HTTPException(status_code=401, detail="X-Device-Id is required")
    devices = load_json_data("auth_devices")
    device = next((item for item in devices if item.get("device_id") == device_id), None)
    if not device:
        raise HTTPException(status_code=401, detail="Device is not authenticated")
    member_id = device.get("member_id")
    if member_id is not None:
        members = load_json_data("members")
        member = next((value for value in members if value.get("id") == member_id), None)
        if member and member_access_expired(member):
            raise HTTPException(status_code=403, detail="Member access expired")
    return device


def require_device(device_id: str) -> dict[str, Any]:
    return device_auth_record(device_id)


def require_admin_device(device_id: str) -> dict[str, Any]:
    device = device_auth_record(device_id)
    permission = str(device.get("permission") or "")
    if permission not in {"管理者", "システム管理者"}:
        raise HTTPException(status_code=403, detail="Admin permission is required")
    return device


def require_system_admin_device(device_id: str) -> dict[str, Any]:
    device = device_auth_record(device_id)
    permission = str(device.get("permission") or "")
    if permission != "システム管理者":
        raise HTTPException(status_code=403, detail="System admin permission is required")
    return device


def cloud_run_revision() -> str:
    # Cloud Run 讓呎ｺ悶・ K_REVISION 繧貞━蜈医＠縲∵里蟄倥・迢ｬ閾ｪ迺ｰ蠅・､画焚繧ょｾ梧婿莠呈鋤縺ｧ隱ｭ繧縲・
    return os.getenv("K_REVISION", "").strip() or os.getenv("CLOUD_RUN_REVISION", "").strip()


@app.get("/api/revision", response_model=None)
async def get_revision() -> Response:
    # 繝ｪ繝薙ず繝ｧ繝ｳ縺ｯ繝・・繧ｿ譖ｴ譁ｰ縺ｨ縺ｯ迢ｬ遶九＠縺ｦ螟峨ｏ繧九◆繧√｜ootstrap 縺ｮ ETag 繧ｭ繝｣繝・す繝･縺ｨ縺ｯ蛻・屬縺吶ｋ縲・
    return Response(
        content=json.dumps({"cloudRunRevision": cloud_run_revision()}, ensure_ascii=False),
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


def db_connection_string() -> str:
    db_url = os.getenv("DB_URL", "").strip()
    if db_url:
        return db_url

    db_host = os.getenv("DB_HOST", "").strip()
    db_port = os.getenv("DB_PORT", "5432").strip()
    db_name = os.getenv("DB_NAME", "").strip()
    db_user = os.getenv("DB_USER", "").strip()
    db_password = os.getenv("DB_PASSWORD", "").strip()
    if not all([db_host, db_name, db_user, db_password]):
        raise HTTPException(
            status_code=500,
            detail="DB connection env vars are incomplete (DB_HOST/DB_NAME/DB_USER/DB_PASSWORD or DB_URL)",
        )
    return (
        f"host={db_host} "
        f"port={db_port} "
        f"dbname={db_name} "
        f"user={db_user} "
        f"password={db_password} "
        "sslmode=disable"
    )


def mask_db_value(column_name: str, value: Any) -> Any:
    lowered = column_name.lower()
    if value is None:
        return None
    if lowered in {"password", "google_service_account_json", "google_service_account_file"}:
        text_value = str(value)
        if len(text_value) <= 8:
            return "********"
        return f"{text_value[:4]}...{text_value[-4:]}"
    return value


def assert_db_ready() -> None:
    if psycopg is None or psql is None:
        raise HTTPException(status_code=500, detail="psycopg is not installed")


def ensure_db_schema_compatibility(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE performances ADD COLUMN IF NOT EXISTS performance_fee_amount NUMERIC(12, 2) NOT NULL DEFAULT 0"
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS access_logs (
                id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                member_id BIGINT REFERENCES members(id) ON DELETE SET NULL,
                member_name TEXT DEFAULT '',
                member_part TEXT DEFAULT '',
                permission TEXT DEFAULT '',
                menu_key TEXT NOT NULL,
                menu_label TEXT NOT NULL,
                panel TEXT DEFAULT '',
                device_id TEXT DEFAULT '',
                device_name TEXT DEFAULT '',
                user_agent TEXT DEFAULT '',
                accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_access_logs_accessed_at ON access_logs(accessed_at DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_access_logs_member_id ON access_logs(member_id)")


PORTAL_DB_TABLES = {
    "performances",
    "performance_pieces",
    "schedules",
    "announcements",
    "events",
    "members",
    "auth_devices",
    "access_logs",
    "absences",
    "event_responses",
    "date_adjustments",
    "date_adjustment_candidates",
    "date_adjustment_responses",
    "piece_infos",
    "practice_instructions",
    "castings",
    "casting_members",
    "casting_extras",
    "payments",
    "payment_performance_fees",
    "desired_pieces",
    "desired_piece_votes",
    "promotions",
    "albums",
    "album_photos",
    "part_settings",
    "venue_settings",
    "org_settings",
    "sns_settings",
    "connection_settings",
    "drive_files",
    "recording_metadata",
    "sheet_library",
}

JSON_COLLECTION_TABLES = {
    "performances": "performances",
    "schedules": "schedules",
    "announcements": "announcements",
    "events": "events",
    "members": "members",
    "auth_devices": "auth_devices",
    "access_logs": "access_logs",
    "absences": "absences",
    "event_responses": "event_responses",
    "date_adjustments": "date_adjustments",
    "date_adjustment_responses": "date_adjustment_responses",
    "piece_infos": "piece_infos",
    "practice_instructions": "practice_instructions",
    "payments": "payments",
    "castings": "castings",
    "desired_pieces": "desired_pieces",
    "promotions": "promotions",
    "albums": "albums",
    "part_settings": "part_settings",
    "venue_settings": "venue_settings",
    "org_settings": "org_settings",
    "sns_settings": "sns_settings",
    "connection_settings": "connection_settings",
    "drive_files": "drive_files",
    "recording_metadata": "recording_metadata",
    "sheet_library": "sheet_library",
}
DB_WRITABLE_COLLECTIONS = set(JSON_COLLECTION_TABLES)
DB_COLLECTION_COLUMNS = {
    "performances": (
        "id",
        "title",
        "date",
        "open_time",
        "start_time",
        "venue",
        "conductor",
        "flyer_image",
        "performance_fee_amount",
        "created_at",
        "updated_at",
    ),
    "schedules": (
        "id",
        "date",
        "time",
        "start_time",
        "end_time",
        "venue",
        "available_hours",
        "available_start_time",
        "available_end_time",
        "performance_id",
        "performance_title",
        "pieces",
        "is_conductor_training",
        "is_main_performance",
        "notes",
        "created_at",
        "updated_at",
    ),
    "announcements": ("id", "date", "title", "content", "created_at", "updated_at"),
    "events": ("id", "title", "date", "start_time", "deadline", "url", "notes", "delete_phrase", "fee", "created_at", "updated_at"),
    "members": (
        "id",
        "name",
        "last_name",
        "first_name",
        "maiden_name",
        "last_name_kana",
        "first_name_kana",
        "maiden_name_kana",
        "part",
        "photo_url",
        "is_founder",
        "is_recording_manager",
        "is_sheet_manager",
        "password",
        "permission",
        "joined_at",
        "system_access_until",
        "introducer",
        "role",
        "instrument_history",
        "past_orchestras",
        "comment",
        "created_at",
        "updated_at",
    ),
    "auth_devices": (
        "id",
        "device_id",
        "device_name",
        "member_id",
        "member_name",
        "member_part",
        "permission",
        "system_access_until",
        "is_recording_manager",
        "is_sheet_manager",
        "hidden_user",
        "user_agent",
        "authenticated_at",
        "last_seen_at",
        "created_at",
        "updated_at",
    ),
    "access_logs": (
        "id",
        "member_id",
        "member_name",
        "member_part",
        "permission",
        "menu_key",
        "menu_label",
        "panel",
        "device_id",
        "device_name",
        "user_agent",
        "accessed_at",
        "created_at",
        "updated_at",
    ),
    "absences": ("id", "schedule_id", "member_id", "name", "status", "note", "created_at", "updated_at"),
    "event_responses": ("id", "event_id", "member_id", "name", "status", "note", "created_at", "updated_at"),
    "date_adjustments": ("id", "title", "deadline", "notes", "delete_phrase", "created_by", "member_id", "created_at", "updated_at"),
    "date_adjustment_responses": ("id", "adjustment_id", "candidate_key", "member_id", "name", "status", "note", "created_at", "updated_at"),
    "piece_infos": ("id", "performance_id", "piece", "description", "created_at", "updated_at"),
    "practice_instructions": ("id", "performance_id", "piece", "practice_notes", "performance_instruction", "created_at", "updated_at"),
    "payments": (
        "id",
        "member_id",
        "name",
        "paid_from_month",
        "paid_until_month",
        "latest_payment_date",
        "membership_fee_amount",
        "created_at",
        "updated_at",
    ),
    "castings": ("id", "performance_id", "piece", "created_at", "updated_at"),
    "desired_pieces": (
        "id",
        "title",
        "piece",
        "composer",
        "duration",
        "genre",
        "formation",
        "notes",
        "member_id",
        "registered_by",
        "created_at",
        "updated_at",
    ),
    "promotions": ("id", "title", "summary", "image_url", "member_id", "registered_by", "created_at", "updated_at"),
    "albums": ("id", "event_name", "created_by_member_id", "created_by_member_name", "created_at", "updated_at"),
    "part_settings": ("id", "name", "sort_order", "is_active", "created_at", "updated_at"),
    "venue_settings": ("id", "name", "address", "for_practice", "for_performance", "notes", "sort_order", "created_at", "updated_at"),
    "org_settings": (
        "id",
        "organization_name",
        "organization_abbreviation",
        "short_name",
        "icon_url",
        "membership_fee_amount",
        "created_at",
        "updated_at",
    ),
    "sns_settings": ("id", "line_url", "x_url", "instagram_url", "youtube_url", "facebook_url", "website_url", "extra_links", "created_at", "updated_at"),
    "connection_settings": (
        "id",
        "google_project_id",
        "google_cloud_storage_bucket",
        "google_cloud_storage_data_prefix",
        "google_cloud_storage_public",
        "google_service_account_file",
        "google_service_account_json",
        "created_at",
        "updated_at",
    ),
    "drive_files": ("id", "source", "object_name", "path", "name", "url", "size_bytes", "mime_type", "created_at", "updated_at"),
    "recording_metadata": (
        "id",
        "source",
        "object_name",
        "path",
        "name",
        "date",
        "piece",
        "duration_seconds",
        "duration",
        "mime_type",
        "size_bytes",
        "created_at",
        "updated_at",
    ),
    "sheet_library": (
        "id",
        "performance_id",
        "performance_title",
        "piece",
        "part",
        "source",
        "name",
        "path",
        "object_name",
        "url",
        "view_url",
        "download_url",
        "size_bytes",
        "mime_type",
        "created_at",
        "updated_at",
    ),
}
DB_DATE_COLUMNS = {
    "performances": {"date"},
    "schedules": {"date"},
    "announcements": {"date"},
    "events": {"date"},
    "members": {"joined_at", "system_access_until"},
    "auth_devices": {"system_access_until"},
    "date_adjustments": {"deadline"},
    "date_adjustment_candidates": {"date"},
    "payments": {"latest_payment_date"},
    "recording_metadata": {"date"},
}
DB_TIME_COLUMNS = {
    "performances": {"open_time", "start_time"},
    "schedules": {"start_time", "end_time", "available_start_time", "available_end_time"},
    "events": {"start_time"},
    "date_adjustment_candidates": {"start_time", "end_time"},
}
DB_TIMESTAMP_COLUMNS = {
    "events": {"deadline"},
    "members": {"created_at", "updated_at"},
    "auth_devices": {"authenticated_at", "last_seen_at", "created_at", "updated_at"},
    "access_logs": {"accessed_at", "created_at", "updated_at"},
    "desired_piece_votes": {"voted_at", "created_at", "updated_at"},
    "album_photos": {"uploaded_at", "created_at", "updated_at"},
}
DB_NUMERIC_COLUMNS = {
    "payments": {"membership_fee_amount"},
    "payment_performance_fees": {"fee_amount"},
    "performances": {"performance_fee_amount"},
    "org_settings": {"membership_fee_amount"},
    "recording_metadata": {"duration_seconds"},
}
DB_INT_COLUMNS = {
    "performances": {"id"},
    "schedules": {"id", "performance_id"},
    "announcements": {"id"},
    "events": {"id"},
    "members": {"id"},
    "auth_devices": {"id", "member_id"},
    "access_logs": {"id", "member_id"},
    "absences": {"id", "schedule_id", "member_id"},
    "event_responses": {"id", "event_id", "member_id"},
    "date_adjustments": {"id", "member_id"},
    "date_adjustment_responses": {"id", "adjustment_id", "member_id"},
    "piece_infos": {"id", "performance_id"},
    "practice_instructions": {"id", "performance_id"},
    "payments": {"id", "member_id"},
    "castings": {"id", "performance_id"},
    "desired_pieces": {"id", "member_id"},
    "promotions": {"id", "member_id"},
    "albums": {"id", "created_by_member_id"},
    "part_settings": {"id", "sort_order"},
    "venue_settings": {"id", "sort_order"},
    "org_settings": {"id"},
    "sns_settings": {"id"},
    "connection_settings": {"id"},
    "drive_files": {"id", "size_bytes"},
    "recording_metadata": {"id", "size_bytes"},
    "sheet_library": {"id", "performance_id", "size_bytes"},
    "performance_pieces": {"id", "performance_id", "sort_order"},
    "date_adjustment_candidates": {"id", "adjustment_id", "sort_order"},
    "casting_members": {"id", "casting_id", "member_id", "sort_order"},
    "casting_extras": {"id", "casting_id", "sort_order"},
    "payment_performance_fees": {"payment_id", "performance_id"},
    "desired_piece_votes": {"id", "desired_piece_id", "member_id"},
    "album_photos": {"id", "album_id", "uploaded_by_member_id"},
}
DB_BOOL_COLUMNS = {
    "performance_pieces": {"is_encore"},
    "schedules": {"is_conductor_training", "is_main_performance"},
    "members": {"is_founder", "is_recording_manager", "is_sheet_manager"},
    "auth_devices": {"is_recording_manager", "is_sheet_manager", "hidden_user"},
    "payment_performance_fees": {"is_paid"},
    "part_settings": {"is_active"},
    "venue_settings": {"for_practice", "for_performance"},
    "connection_settings": {"google_cloud_storage_public"},
}
DB_MONTH_COLUMNS = {
    "payments": {"paid_from_month", "paid_until_month"},
}
DB_JSON_COLUMNS = {
    "sns_settings": {"extra_links"},
}
DB_CHILD_TABLES = {
    "performances": ("performance_pieces",),
    "date_adjustments": ("date_adjustment_candidates",),
    "payments": ("payment_performance_fees",),
    "castings": ("casting_members", "casting_extras"),
    "desired_pieces": ("desired_piece_votes",),
    "albums": ("album_photos",),
}
DB_CHILD_PARENT_KEYS = {
    "performance_pieces": "performance_id",
    "date_adjustment_candidates": "adjustment_id",
    "payment_performance_fees": "payment_id",
    "casting_members": "casting_id",
    "casting_extras": "casting_id",
    "desired_piece_votes": "desired_piece_id",
    "album_photos": "album_id",
}
DB_CHILD_COLUMNS = {
    "performance_pieces": ("id", "performance_id", "sort_order", "title", "alias", "composer", "duration", "is_encore", "created_at", "updated_at"),
    "date_adjustment_candidates": ("id", "adjustment_id", "candidate_key", "date", "start_time", "end_time", "note", "sort_order", "created_at", "updated_at"),
    "payment_performance_fees": ("payment_id", "performance_id", "is_paid", "fee_amount", "created_at", "updated_at"),
    "casting_members": ("id", "casting_id", "member_id", "part", "sort_order", "created_at", "updated_at"),
    "casting_extras": ("id", "casting_id", "name", "furigana", "part", "sort_order", "created_at", "updated_at"),
    "desired_piece_votes": ("id", "desired_piece_id", "member_id", "name", "voted_at", "created_at", "updated_at"),
    "album_photos": (
        "id",
        "album_id",
        "filename",
        "url",
        "object_name",
        "path",
        "uploaded_by_member_id",
        "uploaded_by_member_name",
        "uploaded_at",
        "created_at",
        "updated_at",
    ),
}
DB_COLLECTION_ORDER_BY = {
    "part_settings": "sort_order",
    "venue_settings": "sort_order",
}


def require_recording_manager_device(device_id: str) -> dict[str, Any]:
    device = device_auth_record(device_id)
    permission = str(device.get("permission") or "")
    if permission in {"管理者", "システム管理者"} or bool(device.get("is_recording_manager")):
        return device
    raise HTTPException(status_code=403, detail="Recording manager permission is required")


def require_sheet_manager_device(device_id: str) -> dict[str, Any]:
    device = device_auth_record(device_id)
    permission = str(device.get("permission") or "")
    if permission in {"管理者", "システム管理者"} or bool(device.get("is_sheet_manager")):
        return device
    raise HTTPException(status_code=403, detail="Sheet manager permission is required")


def ensure_expected_updated_at(current: dict[str, Any], expected_updated_at: str | None) -> None:
    expected = str(expected_updated_at or "").strip()
    if not expected:
        return
    current_updated = str(current.get("updated_at") or "")
    if current_updated != expected:
        raise HTTPException(status_code=409, detail="Data has been updated by another user")


def next_updated_at(previous: Any = None) -> str:
    # 鬮倬溘↑騾｣邯壽峩譁ｰ縺ｧ繧よ･ｽ隕ｳ繝ｭ繝・け逕ｨ縺ｮ updated_at 縺悟ｿ・★蜑榊屓蛟､繧医ｊ騾ｲ繧繧医≧縺ｫ縺吶ｋ縲・
    current = datetime.now()
    previous_text = str(previous or "").strip()
    if previous_text:
        try:
            previous_datetime = datetime.fromisoformat(previous_text.replace("Z", "+00:00"))
            if previous_datetime.tzinfo is not None:
                previous_datetime = previous_datetime.astimezone().replace(tzinfo=None)
            if current <= previous_datetime:
                current = previous_datetime + timedelta(microseconds=1)
        except ValueError:
            pass
    return current.isoformat()


# ===== JSON 繝・・繧ｿ蜈･蜃ｺ蜉・=====
def db_data_enabled() -> bool:
    if psycopg is None or psql is None:
        return False
    if os.getenv("DB_URL", "").strip():
        return True
    return all(os.getenv(name, "").strip() for name in ("DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"))


def env_flag_enabled(name: str) -> bool:
    return str(os.getenv(name, "")).strip().lower() in {"1", "true", "yes", "on"}


def db_expected() -> bool:
    # DB_REQUIRED 縺梧怏蜉ｹ縲√∪縺溘・ DB 髢｢騾｣迺ｰ蠅・､画焚縺ｮ縺・★繧後°縺瑚ｨｭ螳壹＆繧後※縺・ｌ縺ｰ
    # DB 謗･邯壹ｒ譛溷ｾ・＠縺ｦ縺・ｋ迥ｶ諷九→縺ｿ縺ｪ縺吶・
    if env_flag_enabled("DB_REQUIRED"):
        return True
    return any(os.getenv(name, "").strip() for name in ("DB_URL", "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"))


def ensure_db_expected_is_ready() -> None:
    # DB 蛻ｩ逕ｨ繧呈悄蠕・＠縺ｦ縺・ｋ縺ｮ縺ｫ謗･邯夊ｨｭ螳壹′荳榊ｮ悟・縺ｪ蝣ｴ蜷医・
    # JSON 縺ｸ縺ｮ證鈴ｻ吶ヵ繧ｩ繝ｼ繝ｫ繝舌ャ繧ｯ繧帝亟縺・〒蜊ｳ譎ゅ↓險ｭ螳壻ｸ榊ｙ縺ｨ縺励※霑斐☆縲・
    if db_expected() and not db_data_enabled():
        raise HTTPException(
            status_code=500,
            detail="DB is expected but not fully configured. Set DB_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD.",
        )


def run_db_startup_self_check() -> None:
    # DB 蛻ｩ逕ｨ繧呈悄蠕・＠縺ｦ縺・↑縺・腸蠅・〒縺ｯ菴輔ｂ縺励↑縺・・
    if not db_expected():
        return

    # 譛溷ｾ・凾縺ｯ險ｭ螳壻ｸ榊ｙ繧貞叉譎よ､懃衍縺吶ｋ縲・
    ensure_db_expected_is_ready()
    assert_db_ready()

    try:
        with psycopg.connect(db_connection_string(), autocommit=True) as conn:
            ensure_db_schema_compatibility(conn)
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
                # 隱ｭ縺ｿ蜿悶ｊ縺ｮ荳ｭ譬ｸ縺ｨ縺ｪ繧・members 繝・・繝悶Ν蟄伜惠繧堤｢ｺ隱阪☆繧九・
                cur.execute("SELECT to_regclass('public.members')")
                row = cur.fetchone()
                if not row or row[0] is None:
                    raise RuntimeError("members table does not exist")
    except HTTPException:
        raise
    except Exception as exc:
        raise RuntimeError(f"DB startup self-check failed: {exc}") from exc


def db_json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return value


def db_row_to_json(row: dict[str, Any]) -> dict[str, Any]:
    data = {key: db_json_value(value) for key, value in row.items()}
    if "sort_order" in data and "display_order" not in data:
        data["display_order"] = data["sort_order"]
    if "organization_name" in data and not data.get("name"):
        data["name"] = data["organization_name"]
    if "organization_abbreviation" in data and not data.get("short_name"):
        data["short_name"] = data["organization_abbreviation"]
    if "candidate_key" in data and not data.get("candidate_id"):
        data["candidate_id"] = data["candidate_key"]
    return data


def parse_db_date(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    value_text = str(value).strip().replace("/", "-").replace(".", "-")
    if "T" in value_text:
        value_text = value_text.split("T", 1)[0]
    elif " " in value_text:
        value_text = value_text.split(" ", 1)[0]
    if re.fullmatch(r"\d{4}-\d{2}", value_text):
        value_text = f"{value_text}-01"
    try:
        return date.fromisoformat(value_text).isoformat()
    except ValueError:
        return None


def parse_db_time(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.time().replace(microsecond=0).isoformat(timespec="minutes")
    if isinstance(value, time):
        return value.replace(microsecond=0).isoformat(timespec="minutes")
    value_text = str(value).strip()
    if "T" in value_text:
        value_text = value_text.split("T", 1)[1]
    value_text = value_text.split("+", 1)[0].split("Z", 1)[0]
    match = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", value_text)
    if not match:
        return None
    hour, minute, second = match.groups()
    try:
        return time(int(hour), int(minute), int(second or "0")).isoformat(timespec="minutes")
    except ValueError:
        return None


def parse_db_timestamp(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return datetime.combine(value, time.min).isoformat()
    value_text = str(value).strip().replace("/", "-").replace("Z", "+00:00")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value_text):
        value_text = f"{value_text}T00:00:00+00:00"
    try:
        return datetime.fromisoformat(value_text).isoformat()
    except ValueError:
        return None


def parse_db_month(value: Any) -> str:
    value_text = str(value or "").strip().replace("/", "-").replace(".", "-")
    if re.fullmatch(r"\d{4}-\d{2}", value_text):
        return value_text
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value_text):
        return value_text[:7]
    return ""


def db_write_value(table_name: str, column: str, value: Any) -> Any:
    if column in DB_INT_COLUMNS.get(table_name, set()):
        if value in (None, ""):
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    if column in DB_BOOL_COLUMNS.get(table_name, set()):
        if isinstance(value, bool):
            return value
        value_text = str(value or "").strip().lower()
        if value_text in {"1", "true", "yes", "on"}:
            return True
        if value_text in {"0", "false", "no", "off"}:
            return False
        return None
    if column in DB_NUMERIC_COLUMNS.get(table_name, set()):
        if value in (None, ""):
            return None
        try:
            return Decimal(str(value))
        except Exception:
            return None
    if column in DB_DATE_COLUMNS.get(table_name, set()):
        return parse_db_date(value)
    if column in DB_TIME_COLUMNS.get(table_name, set()):
        return parse_db_time(value)
    if column in DB_TIMESTAMP_COLUMNS.get(table_name, set()):
        return parse_db_timestamp(value)
    if column in DB_MONTH_COLUMNS.get(table_name, set()):
        return parse_db_month(value)
    if column in DB_JSON_COLUMNS.get(table_name, set()):
        json_value = value if isinstance(value, (list, dict)) else []
        return Jsonb(json_value) if Jsonb is not None else json.dumps(json_value, ensure_ascii=False)
    return value


def db_fetch_all(conn: Any, table_name: str, *, order_by: str = "id") -> list[dict[str, Any]]:
    if table_name not in PORTAL_DB_TABLES:
        raise HTTPException(status_code=400, detail=f"Unsupported DB table: {table_name}")
    order_sql = psql.SQL(" ORDER BY {}").format(psql.Identifier(order_by)) if order_by else psql.SQL("")
    query = psql.SQL("SELECT * FROM {}{}").format(psql.Identifier(table_name), order_sql)
    with conn.cursor() as cur:
        cur.execute(query)
        rows = cur.fetchall()
        columns = [desc[0] for desc in cur.description]
    return [db_row_to_json(dict(zip(columns, row))) for row in rows]


def db_item_value(table_name: str, item: dict[str, Any], column: str) -> Any:
    if column == "sort_order":
        return item.get("sort_order", item.get("display_order"))
    if column == "candidate_key":
        return item.get("candidate_key", item.get("candidate_id", item.get("id")))
    if column == "summary":
        return item.get("summary", item.get("description"))
    if column == "icon_url":
        return item.get("icon_url", item.get("logo_url"))
    if column == "organization_name":
        return item.get("organization_name", item.get("organization_name_full", item.get("name")))
    if column == "organization_abbreviation":
        return item.get("organization_abbreviation", item.get("short_name", item.get("shortName")))
    if table_name == "org_settings" and column == "membership_fee_amount":
        return item.get("membership_fee_amount", 0)
    if column == "paid_until_month":
        return item.get("paid_until_month", item.get("membership_fee", item.get("dues")))
    return item.get(column)


def db_row_tuple(table_name: str, columns: tuple[str, ...], item: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(db_write_value(table_name, column, db_item_value(table_name, item, column)) for column in columns)


def db_collection_rows_for_save(name: str, data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if name != "drive_files":
        return data

    now = datetime.now().isoformat()
    rows: list[dict[str, Any]] = []
    for item in data:
        row = dict(item)
        object_name = str(row.get("object_name") or row.get("id") or row.get("path") or "").strip()
        if object_name:
            row["object_name"] = object_name
        if db_write_value("drive_files", "id", row.get("id")) is None:
            row.pop("id", None)
        row["created_at"] = row.get("created_at") or now
        row["updated_at"] = row.get("updated_at") or row["created_at"]
        rows.append(row)
    return rows


def db_upsert_rows(cur: Any, table_name: str, columns: tuple[str, ...], rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    assignments = psql.SQL(", ").join(
        psql.SQL("{} = EXCLUDED.{}").format(psql.Identifier(column), psql.Identifier(column))
        for column in columns
        if column != "id"
    )
    insert_query = psql.SQL("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT (id) DO UPDATE SET {}").format(
        psql.Identifier(table_name),
        psql.SQL(", ").join(psql.Identifier(column) for column in columns),
        psql.SQL(", ").join(psql.Placeholder() for _ in columns),
        assignments,
    )
    cur.executemany(insert_query, [db_row_tuple(table_name, columns, row) for row in rows])


def db_insert_rows(cur: Any, table_name: str, columns: tuple[str, ...], rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    insert_query = psql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        psql.Identifier(table_name),
        psql.SQL(", ").join(psql.Identifier(column) for column in columns),
        psql.SQL(", ").join(psql.Placeholder() for _ in columns),
    )
    cur.executemany(insert_query, [db_row_tuple(table_name, columns, row) for row in rows])


def db_next_id(cur: Any, table_name: str) -> int:
    cur.execute(psql.SQL("SELECT COALESCE(MAX(id), 0) FROM {}").format(psql.Identifier(table_name)))
    return int(cur.fetchone()[0]) + 1


def db_fill_missing_ids(cur: Any, table_name: str, rows: list[dict[str, Any]]) -> None:
    columns = DB_COLLECTION_COLUMNS.get(table_name) or DB_CHILD_COLUMNS.get(table_name, ())
    if "id" not in columns:
        return
    next_value = db_next_id(cur, table_name)
    for row in rows:
        if row.get("id") in (None, ""):
            row["id"] = next_value
            next_value += 1


def db_delete_collection_children(cur: Any, name: str) -> None:
    # save_json_data 縺ｯ蟶ｸ縺ｫ繧ｳ繝ｬ繧ｯ繧ｷ繝ｧ繝ｳ蜈ｨ菴薙ｒ菫晏ｭ倥☆繧九◆繧√∝ｭ舌ユ繝ｼ繝悶Ν繧ょ・菴薙ｒ菴懊ｊ逶ｴ縺吶・
    for child_table in DB_CHILD_TABLES.get(name, ()):
        cur.execute(psql.SQL("DELETE FROM {}").format(psql.Identifier(child_table)))


def db_child_rows_for_collection(name: str, data: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    now = datetime.now().isoformat()
    children: dict[str, list[dict[str, Any]]] = {table: [] for table in DB_CHILD_TABLES.get(name, ())}
    if name == "performances":
        for parent in data:
            parent_id = parent.get("id")
            for index, piece in enumerate(parent.get("pieces") if isinstance(parent.get("pieces"), list) else []):
                if isinstance(piece, dict):
                    title = str(piece.get("title") or "").strip()
                    if not title:
                        continue
                    children["performance_pieces"].append(
                        {
                            "id": piece.get("id"),
                            "performance_id": parent_id,
                            "sort_order": piece.get("sort_order", index + 1),
                            "title": title,
                            "alias": piece.get("alias") or piece.get("short_name") or "",
                            "composer": piece.get("composer") or "",
                            "duration": piece.get("duration") or "",
                            "is_encore": piece.get("is_encore", piece.get("encore", False)),
                            "created_at": piece.get("created_at") or parent.get("created_at") or now,
                            "updated_at": piece.get("updated_at") or parent.get("updated_at") or now,
                        }
                    )
                else:
                    title = str(piece or "").strip()
                    if title:
                        children["performance_pieces"].append(
                            {
                                "performance_id": parent_id,
                                "sort_order": index + 1,
                                "title": title,
                                "alias": "",
                                "composer": "",
                                "duration": "",
                                "is_encore": False,
                                "created_at": parent.get("created_at") or now,
                                "updated_at": parent.get("updated_at") or now,
                            }
                        )
    elif name == "date_adjustments":
        for parent in data:
            parent_id = parent.get("id")
            for index, candidate in enumerate(parent.get("candidates") if isinstance(parent.get("candidates"), list) else []):
                if not isinstance(candidate, dict):
                    continue
                children["date_adjustment_candidates"].append(
                    {
                        "id": candidate.get("db_id") if candidate.get("db_id") else None,
                        "adjustment_id": parent_id,
                        "candidate_key": candidate.get("candidate_key") or candidate.get("id") or f"cand-{index + 1}",
                        "date": candidate.get("date"),
                        "start_time": candidate.get("start_time"),
                        "end_time": candidate.get("end_time"),
                        "note": candidate.get("note") or "",
                        "sort_order": index,
                        "created_at": candidate.get("created_at") or parent.get("created_at") or now,
                        "updated_at": candidate.get("updated_at") or parent.get("updated_at") or now,
                    }
                )
    elif name == "payments":
        for parent in data:
            parent_id = parent.get("id")
            fee_map = parent.get("performance_fees") if isinstance(parent.get("performance_fees"), dict) else {}
            amount_map = parent.get("performance_fee_amounts") if isinstance(parent.get("performance_fee_amounts"), dict) else {}
            for performance_id in set(fee_map) | set(amount_map):
                children["payment_performance_fees"].append(
                    {
                        "payment_id": parent_id,
                        "performance_id": performance_id,
                        "is_paid": fee_map.get(performance_id, False),
                        "fee_amount": amount_map.get(performance_id, 0),
                        "created_at": parent.get("created_at") or now,
                        "updated_at": parent.get("updated_at") or now,
                    }
                )
    elif name == "castings":
        for parent in data:
            parent_id = parent.get("id")
            for index, member in enumerate(parent.get("members") if isinstance(parent.get("members"), list) else []):
                if isinstance(member, dict):
                    children["casting_members"].append(
                        {
                            "id": member.get("id"),
                            "casting_id": parent_id,
                            "member_id": member.get("member_id"),
                            "part": member.get("part") or "",
                            "sort_order": index,
                            "created_at": member.get("created_at") or parent.get("created_at") or now,
                            "updated_at": member.get("updated_at") or parent.get("updated_at") or now,
                        }
                    )
            for index, extra in enumerate(parent.get("extras") if isinstance(parent.get("extras"), list) else []):
                if isinstance(extra, dict):
                    children["casting_extras"].append(
                        {
                            "id": extra.get("id"),
                            "casting_id": parent_id,
                            "name": extra.get("name") or "",
                            "furigana": extra.get("furigana") or "",
                            "part": extra.get("part") or "",
                            "sort_order": index,
                            "created_at": extra.get("created_at") or parent.get("created_at") or now,
                            "updated_at": extra.get("updated_at") or parent.get("updated_at") or now,
                        }
                    )
    elif name == "desired_pieces":
        for parent in data:
            parent_id = parent.get("id")
            for vote in parent.get("votes") if isinstance(parent.get("votes"), list) else []:
                if isinstance(vote, dict):
                    row = {
                        "id": vote.get("id"),
                        "desired_piece_id": parent_id,
                        "member_id": vote.get("member_id"),
                        "name": vote.get("name") or "",
                        "voted_at": vote.get("voted_at") or now,
                        "created_at": vote.get("created_at") or parent.get("created_at") or now,
                        "updated_at": vote.get("updated_at") or parent.get("updated_at") or now,
                    }
                else:
                    row = {
                        "desired_piece_id": parent_id,
                        "member_id": None,
                        "name": str(vote or ""),
                        "voted_at": now,
                        "created_at": parent.get("created_at") or now,
                        "updated_at": parent.get("updated_at") or now,
                    }
                children["desired_piece_votes"].append(row)
    elif name == "albums":
        for parent in data:
            parent_id = parent.get("id")
            for photo in parent.get("photos") if isinstance(parent.get("photos"), list) else []:
                if isinstance(photo, dict):
                    children["album_photos"].append(
                        {
                            "id": photo.get("id"),
                            "album_id": parent_id,
                            "filename": photo.get("filename") or "",
                            "url": photo.get("url") or "",
                            "object_name": photo.get("object_name") or "",
                            "path": photo.get("path") or "",
                            "uploaded_by_member_id": photo.get("uploaded_by_member_id"),
                            "uploaded_by_member_name": photo.get("uploaded_by_member_name") or "",
                            "uploaded_at": photo.get("uploaded_at"),
                            "created_at": photo.get("created_at") or parent.get("created_at") or now,
                            "updated_at": photo.get("updated_at") or parent.get("updated_at") or now,
                        }
                    )
    return children


def db_load_json_data(name: str) -> list[dict[str, Any]]:
    table_name = JSON_COLLECTION_TABLES.get(name)
    if not table_name:
        return []

    with psycopg.connect(db_connection_string(), autocommit=True) as conn:
        items = db_fetch_all(conn, table_name, order_by=DB_COLLECTION_ORDER_BY.get(name, "id"))
        if name == "performances":
            pieces = db_fetch_all(conn, "performance_pieces", order_by="sort_order")
            by_performance: dict[Any, list[dict[str, Any]]] = {}
            for piece in pieces:
                by_performance.setdefault(piece.get("performance_id"), []).append(piece)
            for item in items:
                item["pieces"] = by_performance.get(item.get("id"), [])
        elif name == "date_adjustments":
            candidates = db_fetch_all(conn, "date_adjustment_candidates", order_by="sort_order")
            by_adjustment: dict[Any, list[dict[str, Any]]] = {}
            for candidate in candidates:
                candidate["id"] = candidate.get("candidate_key") or candidate.get("id")
                by_adjustment.setdefault(candidate.get("adjustment_id"), []).append(candidate)
            for item in items:
                item["candidates"] = by_adjustment.get(item.get("id"), [])
        elif name == "payments":
            fees = db_fetch_all(conn, "payment_performance_fees", order_by="")
            by_payment: dict[Any, list[dict[str, Any]]] = {}
            for fee in fees:
                by_payment.setdefault(fee.get("payment_id"), []).append(fee)
            for item in items:
                performance_fees: dict[str, bool] = {}
                performance_fee_amounts: dict[str, Any] = {}
                for fee in by_payment.get(item.get("id"), []):
                    performance_id = str(fee.get("performance_id"))
                    performance_fees[performance_id] = bool(fee.get("is_paid"))
                    performance_fee_amounts[performance_id] = fee.get("fee_amount")
                item["performance_fees"] = performance_fees
                item["performance_fee_amounts"] = performance_fee_amounts
        elif name == "castings":
            casting_members = db_fetch_all(conn, "casting_members", order_by="sort_order")
            casting_extras = db_fetch_all(conn, "casting_extras", order_by="sort_order")
            members_by_casting: dict[Any, list[dict[str, Any]]] = {}
            extras_by_casting: dict[Any, list[dict[str, Any]]] = {}
            for member in casting_members:
                members_by_casting.setdefault(member.get("casting_id"), []).append(member)
            for extra in casting_extras:
                extras_by_casting.setdefault(extra.get("casting_id"), []).append(extra)
            for item in items:
                item["members"] = members_by_casting.get(item.get("id"), [])
                item["extras"] = extras_by_casting.get(item.get("id"), [])
        elif name == "desired_pieces":
            votes = db_fetch_all(conn, "desired_piece_votes", order_by="id")
            by_piece: dict[Any, list[dict[str, Any]]] = {}
            for vote in votes:
                by_piece.setdefault(vote.get("desired_piece_id"), []).append(vote)
            for item in items:
                item["votes"] = by_piece.get(item.get("id"), [])
        elif name == "albums":
            photos = db_fetch_all(conn, "album_photos", order_by="id")
            by_album: dict[Any, list[dict[str, Any]]] = {}
            for photo in photos:
                by_album.setdefault(photo.get("album_id"), []).append(photo)
            for item in items:
                item["photos"] = by_album.get(item.get("id"), [])
        return items


def db_replace_collection(name: str, data: list[dict[str, Any]]) -> None:
    table_name = JSON_COLLECTION_TABLES.get(name)
    if table_name not in DB_WRITABLE_COLLECTIONS:
        raise HTTPException(status_code=500, detail=f"DB write is not implemented for {name}")

    rows = db_collection_rows_for_save(name, data)
    with psycopg.connect(db_connection_string(), autocommit=False) as conn:
        with conn.cursor() as cur:
            db_delete_collection_children(cur, name)
            if not rows:
                cur.execute(psql.SQL("DELETE FROM {}").format(psql.Identifier(table_name)))
                conn.commit()
                return

            columns = DB_COLLECTION_COLUMNS[table_name]
            db_fill_missing_ids(cur, table_name, rows)

            kept_ids = [db_write_value(table_name, "id", item.get("id")) for item in rows if item.get("id") is not None]
            if kept_ids:
                cur.execute(psql.SQL("DELETE FROM {} WHERE NOT (id = ANY(%s))").format(psql.Identifier(table_name)), (kept_ids,))
            else:
                cur.execute(psql.SQL("DELETE FROM {}").format(psql.Identifier(table_name)))

            db_upsert_rows(cur, table_name, columns, rows)
            for child_table, child_rows in db_child_rows_for_collection(name, rows).items():
                db_fill_missing_ids(cur, child_table, child_rows)
                db_insert_rows(cur, child_table, DB_CHILD_COLUMNS[child_table], child_rows)
        conn.commit()


def data_file(name: str) -> Path:
    # 繧ｳ繝ｬ繧ｯ繧ｷ繝ｧ繝ｳ蜷阪°繧峨Ο繝ｼ繧ｫ繝ｫ JSON 繝輔ぃ繧､繝ｫ繝代せ繧定ｧ｣豎ｺ縺吶ｋ縲・
    return DATA_DIR / f"{name}.json"


def load_local_json_data(name: str) -> list[dict[str, Any]]:
    # 繝ｭ繝ｼ繧ｫ繝ｫ JSON 繧定ｪｭ縺ｿ霎ｼ縺ｿ縲・・蛻励〒縺ｪ縺代ｌ縺ｰ遨ｺ驟榊・縺ｨ縺励※謇ｱ縺・・
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
    # 蜿ら・鬆ｻ蠎ｦ縺ｮ鬮倥＞荳隕ｧ縺ｯ縺ｾ縺壹Γ繝｢繝ｪ繧ｭ繝｣繝・す繝･繧定ｦ九ｋ縲・
    cached = _memory_cache.get(name)
    if cached is not None:
        return cached

    if name in JSON_COLLECTION_TABLES:
        ensure_db_expected_is_ready()
    if db_data_enabled() and name in JSON_COLLECTION_TABLES:
        db_data = db_load_json_data(name)
        _memory_cache.set(name, db_data)
        return db_data

    local_data = load_local_json_data(name)
    _memory_cache.set(name, local_data)
    return local_data


def save_json_data(name: str, data: list[dict[str, Any]]) -> None:
    if name in JSON_COLLECTION_TABLES:
        ensure_db_expected_is_ready()

    if db_data_enabled() and name in DB_WRITABLE_COLLECTIONS:
        db_replace_collection(name, data)
        _memory_cache.set(name, data)
        return

    path = data_file(name)
    tmp_path = path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
    tmp_path.replace(path)
    
    # 譖ｸ縺崎ｾｼ縺ｿ逶ｴ蠕後・蜀崎ｪｭ霎ｼ繧帝溘￥縺吶ｋ縺溘ａ縲∽ｿ晏ｭ俶・蜉滓凾轤ｹ縺ｧ繧ｭ繝｣繝・す繝･繧よ峩譁ｰ縺吶ｋ縲・
    _memory_cache.set(name, data)


def has_connection_setting(items: list[dict[str, Any]]) -> bool:
    # 謗･邯夊ｨｭ螳壹→縺励※諢丞袖縺ｮ縺ゅｋ蛟､縺・莉ｶ縺ｧ繧ゅ≠繧後・險ｭ螳壽ｸ医∩縺ｨ縺ｿ縺ｪ縺吶・
    primary_keys = (
        "google_project_id",
        "google_cloud_storage_bucket",
        "google_service_account_file",
        "google_service_account_json",
    )
    for item in items:
        if not isinstance(item, dict):
            continue
        values = [str(item.get(key) or "").strip() for key in primary_keys]
        if any(
            value
            and value
            not in {
                "your_bucket_name_here",
                "あなたのGCSバケット名",
                "縺ゅ↑縺溘・GCS繝舌こ繝・ヨ蜷・",
            }
            for value in values
        ):
            return True
    return False


def legacy_connection_setting_from_env() -> dict[str, Any]:
    # 譌ｧ驕狗畑縺ｮ迺ｰ蠅・､画焚繧呈眠縺励＞ connection_settings 繝ｬ繧ｳ繝ｼ繝峨∈螟画鋤縺吶ｋ縲・
    bucket = os.getenv("GOOGLE_CLOUD_STORAGE_BUCKET", "").strip()
    if not bucket:
        return {}

    public_raw = os.getenv("GOOGLE_CLOUD_STORAGE_PUBLIC", "").strip().lower()
    if public_raw in {"1", "true", "yes", "on"}:
        public_value = "true"
    elif public_raw in {"0", "false", "no", "off"}:
        public_value = "false"
    else:
        public_value = ""

    return {
        "google_project_id": os.getenv("GOOGLE_CLOUD_PROJECT", "").strip(),
        "google_cloud_storage_bucket": bucket,
        # 譌ｧ驕狗畑莠呈鋤縺ｮ縺溘ａ縲∵悴險ｭ螳壽凾縺ｯ遨ｺ譁・ｭ励・縺ｾ縺ｾ逋ｻ骭ｲ縺吶ｋ縲・
        "google_cloud_storage_data_prefix": os.getenv("GOOGLE_CLOUD_STORAGE_DATA_PREFIX", "").strip(),
        "google_cloud_storage_public": public_value,
        "google_service_account_file": os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip(),
        "google_service_account_json": os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip(),
    }


def seed_connection_settings_from_legacy_env() -> None:
    # connection_settings 縺檎ｩｺ縺ｮ迺ｰ蠅・〒縺ｯ縲∵立迺ｰ蠅・､画焚蛟､繧・莉ｶ閾ｪ蜍慕匳骭ｲ縺吶ｋ縲・
    # 縺薙ｌ縺ｫ繧医ｊ謗･邯壽ュ蝣ｱ繝｡繝九Η繝ｼ蟆主・蠕後ｂ譌｢蟄倥ョ繝励Ο繧､縺ｮ險ｭ螳壹ｒ蠑輔″邯吶￡繧九・
    items = load_json_data("connection_settings")
    if has_connection_setting(items):
        return

    legacy = legacy_connection_setting_from_env()
    if not legacy:
        return

    now = datetime.now().isoformat()
    payload = {
        "id": next_id(items),
        "created_at": now,
        "updated_at": now,
        **legacy,
    }
    items.append(payload)
    save_json_data("connection_settings", items)
    logger.info("Seeded connection_settings from legacy environment variables")


async def seed_cloud_data_from_local() -> None:
    # 譌ｧ迺ｰ蠅・､画焚驕狗畑縺九ｉ遘ｻ陦後＠縺溽腸蠅・〒縺ｯ謗･邯夊ｨｭ螳壹ｒ蜈医↓陬懷ｮ後☆繧九・
    seed_connection_settings_from_legacy_env()

    # 襍ｷ蜍墓凾縺ｫ荳ｻ隕√さ繝ｬ繧ｯ繧ｷ繝ｧ繝ｳ繧偵く繝｣繝・す繝･縺ｸ貂ｩ繧√ｋ縲・
    for name in STARTUP_PRELOAD_COLLECTIONS:
        logger.info("Startup preload begin: %s", name)
        try:
            loaded = load_json_data(name)  # 繧ｭ繝｣繝・す繝･縺ｫ隱ｭ縺ｿ霎ｼ縺ｿ
            logger.info("Startup preload done: %s (%s items)", name, len(loaded))
        except HTTPException as exc:
            logger.exception("Startup preload failed: %s (%s)", name, exc)
            if db_expected():
                raise


@asynccontextmanager
async def app_lifespan(_: FastAPI):
    run_db_startup_self_check()
    await seed_cloud_data_from_local()
    yield


app.router.lifespan_context = app_lifespan


def next_id(items: list[dict[str, Any]]) -> int:
    # 譌｢蟄俶怙螟ｧ ID + 1 繧定ｿ斐☆縲・
    return max((int(item.get("id", 0)) for item in items), default=0) + 1


def find_item(items: list[dict[str, Any]], item_id: int) -> tuple[int, dict[str, Any]]:
    # 繧ｭ繝｣繝・す繝･貂医∩繧ｳ繝ｬ繧ｯ繧ｷ繝ｧ繝ｳ縺ｯ ID 繧､繝ｳ繝・ャ繧ｯ繧ｹ繧剃ｽｿ縺｣縺ｦ O(1) 縺ｧ謗｢縺吶・
    for data_name in JSON_DATA_NAMES:
        if _memory_cache.get(data_name) is items:
            index_map = _memory_cache.get_index(data_name, "id")
            if index_map and item_id in index_map:
                return index_map[item_id]
    
    # 繧､繝ｳ繝・ャ繧ｯ繧ｹ縺檎┌縺・ｴ蜷医・邱壼ｽ｢讀懃ｴ｢
    for index, item in enumerate(items):
        if item.get("id") == item_id:
            return index, item
    raise HTTPException(status_code=404, detail="Data not found")


def check_etag(request: Request, data_name: str) -> Response | None:
    """ETag繝√ぉ繝・け - 螟画峩縺後↑縺代ｌ縺ｰ304繧定ｿ斐☆"""
    etag = _memory_cache.etag(data_name)
    if not etag:
        return None
    
    if_none_match = request.headers.get("if-none-match", "")
    if if_none_match == etag:
        return Response(status_code=304)
    return None


def combined_collection_etag(names: tuple[str, ...]) -> str:
    # bootstrap 縺ｯ隍・焚繧ｳ繝ｬ繧ｯ繧ｷ繝ｧ繝ｳ繧偵∪縺ｨ繧√※霑斐☆縺溘ａ縲∝腰荳繝・・繝悶Ν縺ｧ縺ｯ縺ｪ縺・
    # 繝ｬ繧ｹ繝昴Φ繧ｹ縺ｫ蜷ｫ縺ｾ繧後ｋ蜈ｨ繝・・繧ｿ縺ｮ ETag 繧貞粋謌舌＠縺ｦ 304 蛻､螳壹↓菴ｿ縺・・
    parts: list[str] = []
    for name in dict.fromkeys(names):
        load_json_data(name)
        parts.append(f"{name}:{_memory_cache.etag(name) or ''}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def bootstrap_response(request: Request, data: dict[str, Any], etag: str) -> dict[str, Any] | Response:
    if request.headers.get("if-none-match", "") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(
        content=json.dumps(data, ensure_ascii=False),
        media_type="application/json",
        headers={"ETag": etag},
    )


# ===== 隱崎ｨｼ繝ｻ遶ｯ譛ｫ邂｡逅・API =====
async def list_auth_devices() -> list[dict[str, Any]]:
    return sorted(
        load_json_data("auth_devices"),
        key=lambda item: str(item.get("authenticated_at") or ""),
        reverse=True,
    )


# ===== 繧｢繧ｯ繧ｻ繧ｹ繝ｭ繧ｰ =====
# 蝗｣蜩｡縺後←縺ｮ繝｡繝九Η繝ｼ縺ｸ蜈･縺｣縺溘°繧剃ｿ晏ｭ倥☆繧九る夢隕ｧ縺ｯ繧ｷ繧ｹ繝・Β邂｡逅・・↓髯仙ｮ壹☆繧九・
@app.post("/api/system/access-logs")
async def create_access_log(request: Request, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    device = require_device(x_device_id)
    body = await read_json_body(request)
    now = next_updated_at()
    items = load_json_data("access_logs")
    payload = {
        "id": next_id(items),
        "member_id": device.get("member_id"),
        "member_name": device.get("member_name") or "",
        "member_part": device.get("member_part") or "",
        "permission": device.get("permission") or "",
        "menu_key": str(body.get("menu_key") or "").strip(),
        "menu_label": str(body.get("menu_label") or "").strip(),
        "panel": str(body.get("panel") or "").strip(),
        "device_id": device.get("device_id") or x_device_id,
        "device_name": device.get("device_name") or "",
        "user_agent": device.get("user_agent") or request.headers.get("user-agent", ""),
        "accessed_at": now,
        "created_at": now,
        "updated_at": now,
    }
    items.append(payload)
    # 繝ｭ繧ｰ縺檎┌蛻ｶ髯舌↓蠅励∴縺ｪ縺・ｈ縺・∫峩霑・000莉ｶ繧剃ｿ晄戟縺吶ｋ縲・
    items = sorted(items, key=lambda item: str(item.get("accessed_at") or item.get("created_at") or ""))[-2000:]
    save_json_data("access_logs", items)
    return payload


@app.get("/api/system/access-logs")
async def list_access_logs(limit: int = 200, x_device_id: str = Header(default="", alias="X-Device-Id")) -> list[dict[str, Any]]:
    require_system_admin_device(x_device_id)
    safe_limit = min(max(int(limit or 200), 1), 1000)
    items = load_json_data("access_logs")
    return sorted(items, key=lambda item: str(item.get("accessed_at") or item.get("created_at") or ""), reverse=True)[:safe_limit]


# ===== 蛻晄悄謠冗判逕ｨ bootstrap API =====
# 蛻晄悄謠冗判縺ｫ蠢・ｦ√↑譛蟆上ョ繝ｼ繧ｿ繧定ｿ斐☆霆ｽ驥・bootstrap API縲・
@app.get("/api/bootstrap-lite", response_model=None)
async def get_bootstrap_lite_data(request: Request) -> dict[str, Any] | Response:
    # Return the minimal data needed for initial rendering.
    extra_names = ("payments", "part_settings", "org_settings", "sns_settings", "connection_settings")
    etag = combined_collection_etag(("performances", "schedules", "announcements", "members", *extra_names))
    extras = {name: load_json_data(name) for name in extra_names}
    data = {
        "performances": load_json_data("performances"),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "members": public_member_list(load_json_data("members")),
        "extras": extras,
        "cloudRunRevision": cloud_run_revision(),
    }
    return bootstrap_response(request, data, etag)


# 骭ｲ髻ｳ/讌ｽ隴懊・驥阪＞襍ｰ譟ｻ繧帝勁縺・◆騾壼ｸｸ bootstrap API縲・
@app.get("/api/bootstrap-core", response_model=None)
async def get_bootstrap_core_data(request: Request) -> dict[str, Any] | Response:
    # Return core bootstrap data without heavy file listings.
    extra_names = ("absences", "event_responses", "date_adjustments", "date_adjustment_responses", "payments", "castings", "piece_infos", "practice_instructions", "performance_day_infos", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "desired_pieces", "promotions")
    etag = combined_collection_etag(("performances", "schedules", "announcements", "events", "members", "auth_devices", *extra_names))
    extras = {name: load_json_data(name) for name in extra_names}
    data = {
        "performances": load_json_data("performances"),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "events": load_json_data("events"),
        "members": public_member_list(load_json_data("members")),
        "extras": extras,
        "auth_devices": await list_auth_devices(),
        "cloudRunRevision": cloud_run_revision(),
    }
    return bootstrap_response(request, data, etag)


# 逕ｻ髱｢縺ｫ蠢・ｦ√↑繝・・繧ｿ繧貞桁諡ｬ逧・↓霑斐☆繝輔Ν bootstrap API縲・
@app.get("/api/bootstrap", response_model=None)
async def get_bootstrap_data(request: Request) -> dict[str, Any] | Response:
    extra_names = ("absences", "event_responses", "date_adjustments", "date_adjustment_responses", "sheet_library", "payments", "castings", "piece_infos", "practice_instructions", "performance_day_infos", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "desired_pieces", "promotions")
    etag = combined_collection_etag(("performances", "schedules", "announcements", "events", "members", "drive_files", "recording_metadata", "auth_devices", *extra_names))
    extras = {name: load_json_data(name) for name in extra_names}
    data = {
        "performances": load_json_data("performances"),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "events": load_json_data("events"),
        "members": public_member_list(load_json_data("members")),
        "recordings": recording_payload(),
        "sheets": {"files": sheet_payload()},
        "extras": extras,
        "auth_devices": await list_auth_devices(),
        "cloudRunRevision": cloud_run_revision(),
    }
    return bootstrap_response(request, data, etag)


# ===== 繧｢繝・・繝ｭ繝ｼ繝峨・繝輔ぃ繧､繝ｫ陬懷勧 =====
def safe_segment(value: str, default: str) -> str:
    # 繝輔ぃ繧､繝ｫ/繝輔か繝ｫ繝蜷阪→縺励※蜊ｱ髯ｺ縺ｪ譁・ｭ励ｒ髯､蜴ｻ縺励※螳牙・蛹悶☆繧九・
    value = (value or default).strip()
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value or default


def safe_upload_name(filename: str) -> str:
    # 蜈・ヵ繧｡繧､繝ｫ蜷阪ｒ螳牙・縺ｪ菫晏ｭ伜錐縺ｸ螟画鋤縺吶ｋ縲・
    suffix = Path(filename).suffix.lower()
    stem = safe_segment(Path(filename).stem, "audio")
    return f"{stem}{suffix}"


def ensure_audio_file(file: UploadFile) -> str:
    # 骭ｲ髻ｳ繧｢繝・・繝ｭ繝ｼ繝牙ｯｾ雎｡縺・mp3/m4a 縺九ｒ讀懆ｨｼ縺吶ｋ縲・
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".mp3", ".m4a"}:
        raise HTTPException(status_code=400, detail="Please upload an MP3 or M4A file")
    return suffix


def ensure_pdf_file(file: UploadFile) -> None:
    # 讌ｽ隴懊い繝・・繝ｭ繝ｼ繝牙ｯｾ雎｡縺・PDF 縺九ｒ讀懆ｨｼ縺吶ｋ縲・
    suffix = Path(file.filename or "").suffix.lower()
    if suffix != ".pdf":
        raise HTTPException(status_code=400, detail="Please upload a PDF file")


def local_recording_metadata(path: Path) -> dict[str, Any]:
    # 迚ｩ逅・ヵ繧｡繧､繝ｫ縺ｮ螻樊ｧ縺ｨ縲∝挨邂｡逅・＠縺ｦ縺・ｋ骭ｲ髻ｳ譎る俣繝｡繧ｿ繝・・繧ｿ繧貞粋謌舌＠縺ｦ霑斐☆縲・
    stat = path.stat()
    rel = path.relative_to(UPLOAD_DIR).as_posix()
    parts = path.relative_to(CONVERTED_DIR).parts if path.is_relative_to(CONVERTED_DIR) else path.parts
    date = parts[0] if len(parts) >= 3 else ""
    piece = parts[1] if len(parts) >= 3 else ""
    meta = recording_metadata_map().get(rel, {})
    duration_seconds = meta.get("duration_seconds")
    duration_label = meta.get("duration") or format_duration(duration_seconds)
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
        "duration": duration_label,
    }


def cloud_recording_metadata(item: dict[str, Any]) -> dict[str, Any]:
    # Cloud 骭ｲ髻ｳ繝｡繧ｿ繝・・繧ｿ縺ｫ蜀咲函/繝繧ｦ繝ｳ繝ｭ繝ｼ繝・API URL 繧定｣懷ｮ後☆繧九・
    normalized = dict(item)
    object_name = normalized.get("object_name") or normalized.get("id")
    if normalized.get("source") != "google_cloud_storage" or not object_name:
        return normalized

    encoded_object_name = quote(str(object_name), safe="/")
    normalized["object_name"] = object_name
    cached = recording_metadata_map().get(str(object_name), {}) or recording_metadata_map().get(str(normalized.get("id") or ""), {})
    if cached and not normalized.get("duration"):
        normalized["duration_seconds"] = cached.get("duration_seconds")
        normalized["duration"] = cached.get("duration")
    normalized["play_url"] = f"/api/recordings/cloud/play/{encoded_object_name}"
    normalized["download_url"] = f"/api/recordings/cloud/download/{encoded_object_name}"
    return normalized


def remember_drive_file(item: dict[str, Any]) -> None:
    # Cloud 骭ｲ髻ｳ荳隕ｧ縺ｸ譛譁ｰ鬆・岼繧貞・鬆ｭ霑ｽ蜉縺ｧ菫晏ｭ倥☆繧九・
    object_name = str(item.get("object_name") or item.get("id") or "").strip()
    now = datetime.now().isoformat()
    normalized_item = dict(item)
    normalized_item["created_at"] = normalized_item.get("created_at") or now
    normalized_item["updated_at"] = now
    items = load_json_data("drive_files")
    items = [
        existing
        for existing in items
        if str(existing.get("object_name") or existing.get("id") or "").strip() != object_name
    ]
    items.insert(0, normalized_item)
    save_json_data("drive_files", items[:500])


def forget_drive_file(object_name: str) -> None:
    # Cloud 骭ｲ髻ｳ荳隕ｧ縺九ｉ object_name 縺ｫ荳閾ｴ縺吶ｋ鬆・岼繧帝勁蜴ｻ縺吶ｋ縲・
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
    # 繧｢繝・・繝ｭ繝ｼ繝峨ヵ繧｡繧､繝ｫ繧呈欠螳壹ョ繧｣繝ｬ繧ｯ繝医Μ縺ｸ菫晏ｭ倥＠縲∽ｿ晏ｭ倥ヱ繧ｹ繧定ｿ斐☆縲・
    directory.mkdir(parents=True, exist_ok=True)
    output_path = directory / safe_upload_name(file.filename or "audio")
    with output_path.open("wb") as target:
        shutil.copyfileobj(file.file, target)
    return output_path


def local_sheet_path(path: str) -> Path:
    # 讌ｽ隴懊・繝ｭ繝ｼ繧ｫ繝ｫ螳滉ｽ薙ヱ繧ｹ繧呈､懆ｨｼ莉倥″縺ｧ隗｣豎ｺ縺吶ｋ縲・
    requested = (UPLOAD_DIR / path).resolve()
    if not requested.is_file() or SHEET_DIR.resolve() not in requested.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return requested


def sheet_metadata(item: dict[str, Any]) -> dict[str, Any]:
    # 菫晏ｭ伜・縺後Ο繝ｼ繧ｫ繝ｫ縺・Cloud Storage 縺九↓縺九°繧上ｉ縺壹・
    # 繝輔Ο繝ｳ繝医′蜷後§繧ｭ繝ｼ蜷阪〒謇ｱ縺医ｋ繧医≧ view/download URL 繧呈ｭ｣隕丞喧縺吶ｋ縲・
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
    # 讌ｽ隴應ｸ隕ｧ繧偵ヵ繝ｭ繝ｳ繝郁｡ｨ遉ｺ蜷代￠繝｡繧ｿ繝・・繧ｿ蠖｢蠑上∈螟画鋤縺吶ｋ縲・
    return [sheet_metadata(item) for item in load_json_data("sheet_library")]


def delete_sheet_file(item: dict[str, Any]) -> None:
    # 讌ｽ隴懷ｮ滉ｽ薙ｒ菫晏ｭ伜・・・loud/繝ｭ繝ｼ繧ｫ繝ｫ・峨↓蠢懊§縺ｦ蜑企勁縺吶ｋ縲・
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
    # 讌ｽ隴・ZIP 菴懈・逕ｨ縺ｫ繝輔ぃ繧､繝ｫ螳滉ｽ薙ｒ bytes 縺ｧ蜿門ｾ励☆繧九・
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
    # 骭ｲ髻ｳ ZIP 菴懈・逕ｨ縺ｫ繝輔ぃ繧､繝ｫ螳滉ｽ薙ｒ bytes 縺ｧ蜿門ｾ励☆繧九・
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
    # ZIP 蜀・〒繝輔ぃ繧､繝ｫ蜷阪′陦晉ｪ√＠縺ｪ縺・ｈ縺・｣逡ｪ莉倥″縺ｧ荳諢丞喧縺吶ｋ縲・
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
    # 骭ｲ髻ｳ繝輔ぃ繧､繝ｫ髟ｷ・育ｧ抵ｼ峨ｒ蜿門ｾ励☆繧九ょ､ｱ謨玲凾縺ｯ None縲・
    if AudioSegment is None:
        return None
    try:
        audio = AudioSegment.from_file(path)
        return round(len(audio) / 1000, 1)
    except Exception:
        logger.warning("Failed to get audio duration: %s", path, exc_info=True)
        return None


def format_duration(seconds: float | int | None) -> str:
    # 遘呈焚繧・mm:ss / h:mm:ss 蠖｢蠑上∈謨ｴ蠖｢縺吶ｋ縲・
    if seconds is None:
        return ""
    total = int(round(float(seconds)))
    minutes, sec = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{sec:02d}"
    return f"{minutes}:{sec:02d}"

def recording_metadata_map() -> dict[str, dict[str, Any]]:
    # 骭ｲ髻ｳ譎る俣繝｡繧ｿ繝・・繧ｿ繧・path/object_name 繧ｭ繝ｼ縺ｮ霎樊嶌縺ｫ螻暮幕縺吶ｋ縲・
    items = load_json_data("recording_metadata")  # 繧ｭ繝｣繝・す繝･縺九ｉ鬮倬溷叙蠕・
    return {str(item.get("path") or item.get("object_name") or item.get("id") or ""): item for item in items}

def remember_recording_duration(path_key: str, duration_seconds: float | None) -> None:
    # 骭ｲ髻ｳ譎る俣繝｡繧ｿ繝・・繧ｿ繧・upsert 縺吶ｋ縲・
    if not path_key or duration_seconds is None:
        return
    items = load_json_data("recording_metadata")
    now = datetime.now().isoformat()
    for item in items:
        if str(item.get("path") or "") == path_key:
            item["duration_seconds"] = duration_seconds
            item["duration"] = format_duration(duration_seconds)
            item["updated_at"] = now
            save_json_data("recording_metadata", items)
            return
    items.append({"id": next_id(items), "path": path_key, "duration_seconds": duration_seconds, "duration": format_duration(duration_seconds), "created_at": now, "updated_at": now})
    save_json_data("recording_metadata", items)


# ===== 繝ｫ繝ｼ繝医・豁ｻ豢ｻ逶｣隕・=====
# SPA 縺ｮ繧ｨ繝ｳ繝医Μ HTML 繧定ｿ斐☆繝ｫ繝ｼ繝医・
@app.get("/")
async def root() -> FileResponse:
    return FileResponse(
        BASE_DIR / "index.html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


# 繧ｵ繝ｼ繝薙せ縺ｮ豁ｻ豢ｻ縺ｨ蝓ｺ譛ｬ迥ｶ諷九ｒ霑斐☆繝倥Ν繧ｹ繝√ぉ繝・け API縲・
@app.get("/api/health")
async def health_check() -> dict[str, str]:
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "service": "Orchestra Activity Tool",
        "storage_configured": str(storage_enabled()).lower(),
        "db_expected": str(db_expected()).lower(),
        "db_configured": str(db_data_enabled()).lower(),
    }


# 隕ｪ繝ｬ繧ｳ繝ｼ繝峨′蜑企勁縺輔ｌ縺溘◆繧√↓蟄､遶九＠縺溘ョ繝ｼ繧ｿ繧呈､懷・縺励※霑斐☆縲・


def fk_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@app.get("/api/maintenance/orphans")
async def get_maintenance_orphans(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    # Return orphaned child records for administrator maintenance.
    require_admin_device(x_device_id)

    # child_collection, fk_key, parent_collection
    relations = (
        ("piece_infos", "performance_id", "performances"),
        ("practice_instructions", "performance_id", "performances"),
        ("castings", "performance_id", "performances"),
        ("absences", "schedule_id", "schedules"),
        ("absences", "member_id", "members"),
        ("event_responses", "event_id", "events"),
        ("event_responses", "member_id", "members"),
        ("payments", "member_id", "members"),
        ("desired_pieces", "member_id", "members"),
    )

    grouped_orphans: dict[str, list[dict[str, Any]]] = {}
    for child_name, fk_key, parent_name in relations:
        children = load_json_data(child_name)
        parents = load_json_data(parent_name)

        parent_ids = {fk_int(item.get("id")) for item in parents}
        parent_ids.discard(None)

        for item in children:
            fk_value = fk_int(item.get(fk_key))
            if fk_value is None:
                continue
            if fk_value not in parent_ids:
                grouped_orphans.setdefault(child_name, []).append(item)

    summary = {name: len(items) for name, items in grouped_orphans.items()}
    total = sum(summary.values())
    return {
        "total": total,
        "summary": summary,
        "orphans": grouped_orphans,
        "checked_at": datetime.now().isoformat(),
    }

@app.get("/api/system/database/tables")
async def list_database_tables(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    # Return database table names for system administrators.
    require_system_admin_device(x_device_id)
    assert_db_ready()

    conn_str = db_connection_string()
    with psycopg.connect(conn_str, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                (
                    "SELECT table_name "
                    "FROM information_schema.tables "
                    "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                    "ORDER BY table_name"
                )
            )
            tables = [str(row[0]) for row in cur.fetchall() if str(row[0]) in PORTAL_DB_TABLES]

    return {"tables": tables, "total": len(tables)}


@app.get("/api/system/database/records")
async def list_database_records(
    table: str,
    limit: int = 50,
    offset: int = 0,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    # Return database records for a selected table.
    require_system_admin_device(x_device_id)
    assert_db_ready()

    normalized_table = str(table or "").strip()
    if not normalized_table:
        raise HTTPException(status_code=400, detail="table is required")
    if normalized_table not in PORTAL_DB_TABLES:
        raise HTTPException(status_code=404, detail="table not found")
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 500")
    if offset < 0:
        raise HTTPException(status_code=400, detail="offset must be >= 0")

    conn_str = db_connection_string()
    with psycopg.connect(conn_str, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                (
                    "SELECT column_name "
                    "FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = %s "
                    "ORDER BY ordinal_position"
                ),
                (normalized_table,),
            )
            columns = [str(row[0]) for row in cur.fetchall()]
            if not columns:
                raise HTTPException(status_code=404, detail="table not found")

            cur.execute(
                psql.SQL("SELECT COUNT(*) FROM {};").format(psql.Identifier(normalized_table))
            )
            total = int(cur.fetchone()[0])

            order_clause = psql.SQL(" ORDER BY {} DESC").format(psql.Identifier("id")) if "id" in columns else psql.SQL("")
            query = psql.SQL("SELECT * FROM {}{} LIMIT %s OFFSET %s;").format(
                psql.Identifier(normalized_table),
                order_clause,
            )
            cur.execute(query, (limit, offset))
            fetched = cur.fetchall()
            description = cur.description or []
            column_names = [str(desc.name) for desc in description]

    rows: list[dict[str, Any]] = []
    for values in fetched:
        item: dict[str, Any] = {}
        for idx, col_name in enumerate(column_names):
            item[col_name] = mask_db_value(col_name, values[idx])
        rows.append(item)

    return {
        "table": normalized_table,
        "columns": column_names,
        "rows": rows,
        "limit": limit,
        "offset": offset,
        "total": total,
    }


# ===== 蝓ｺ譛ｬ繝槭せ繧ｿ CRUD =====
# Basic CRUD endpoints live in src/backend/routers/*.py.

# ===== 骭ｲ髻ｳ繝輔ぃ繧､繝ｫ API =====
# Endpoints moved to src/backend/routers/recordings.py.

# ===== 讌ｽ隴・API =====
# Endpoints moved to src/backend/routers/scores.py.


def recording_payload() -> dict[str, list[dict[str, Any]]]:
    # Merge cloud recording metadata with non-mirrored local files.
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


def local_recording_path(path: str) -> Path:
    requested = (UPLOAD_DIR / path).resolve()
    if not requested.is_file() or UPLOAD_DIR.resolve() not in requested.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return requested
EXTRA_COLLECTIONS = {"absences", "event_responses", "date_adjustments", "date_adjustment_responses", "sheet_library", "payments", "castings", "piece_infos", "practice_instructions", "performance_day_infos", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "desired_pieces", "promotions"}
ADMIN_ONLY_EXTRA_COLLECTIONS = {
    "sheet_library",
    "payments",
    "castings",
    "performance_day_infos",
    "albums",
    "part_settings",
    "venue_settings",
    "org_settings",
    "sns_settings",
    "connection_settings",
    "desired_pieces",
    "promotions",
}


def parse_extra_upsert_request(raw_body: dict[str, Any]) -> ExtraUpsertRequest:
    payload = raw_body
    expected_updated_at = ""
    if isinstance(raw_body.get("payload"), dict):
        payload = dict(raw_body.get("payload") or {})
        expected_updated_at = str(raw_body.get("expected_updated_at") or "")
    else:
        payload = dict(raw_body or {})
        expected_updated_at = str(raw_body.get("expected_updated_at") or "")
        payload.pop("expected_updated_at", None)
    return ExtraUpsertRequest(payload=payload, expected_updated_at=expected_updated_at)


def assert_extra_collection_permission(name: str, device: dict[str, Any], payload: dict[str, Any] | None = None, current: dict[str, Any] | None = None) -> None:
    if name in ADMIN_ONLY_EXTRA_COLLECTIONS:
        permission = str(device.get("permission") or "")
        if permission not in {"管理者", "システム管理者"}:
            raise HTTPException(status_code=403, detail="Admin permission is required")
        return

    if name == "date_adjustments":
        if str(device.get("permission") or "") in {"管理者", "システム管理者"}:
            return
        member_id = str(device.get("member_id") or "")
        member_name = str(device.get("member_name") or "")
        target = current or payload or {}
        owner_id = str(target.get("member_id") or "")
        owner_name = str(target.get("created_by") or "")
        if member_id and owner_id and member_id == owner_id:
            return
        if member_name and owner_name and member_name == owner_name:
            return
        raise HTTPException(status_code=403, detail="Only owner can modify date adjustment")

    if name == "date_adjustment_responses":
        if str(device.get("permission") or "") in {"管理者", "システム管理者"}:
            return
        member_id = str(device.get("member_id") or "")
        member_name = str(device.get("member_name") or "")
        target = current or payload or {}
        owner_id = str(target.get("member_id") or "")
        owner_name = str(target.get("name") or "")
        if member_id and owner_id and member_id == owner_id:
            return
        if member_name and owner_name and member_name == owner_name:
            return
        raise HTTPException(status_code=403, detail="Only owner can modify response")

    # absences / event_responses 縺ｯ譛ｬ莠ｺ蜈･蜉帶Φ螳壹・
    if name in {"absences", "event_responses"}:
        if str(device.get("permission") or "") in {"管理者", "システム管理者"}:
            return
        member_id = str(device.get("member_id") or "")
        member_name = str(device.get("member_name") or "")
        target = current or payload or {}
        owner_id = str(target.get("member_id") or "")
        owner_name = str(target.get("name") or "")
        if member_id and owner_id and member_id == owner_id:
            return
        if member_name and owner_name and member_name == owner_name:
            return
        raise HTTPException(status_code=403, detail="Only owner can modify this record")

# ===== 豎守畑 extra 繧ｳ繝ｬ繧ｯ繧ｷ繝ｧ繝ｳ CRUD =====
# 讖溯・霑ｽ蜉縺ｮ縺溘・縺ｫ蟆ら畑 API 繧貞｢励ｄ縺輔★縺ｫ貂医・繧医≧縲・
# JSON 驟榊・繝吶・繧ｹ縺ｮ陬懷勧繝・・繧ｿ縺ｯ縺薙・蜈ｱ騾壹お繝ｳ繝峨・繧､繝ｳ繝医〒謇ｱ縺・・
def normalize_extra_payload(payload: dict[str, Any], item_id: int | None = None, current: dict[str, Any] | None = None) -> dict[str, Any]:
    now = next_updated_at((current or {}).get("updated_at"))
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

# 謖・ｮ・extra 繧ｳ繝ｬ繧ｯ繧ｷ繝ｧ繝ｳ縺ｮ荳隕ｧ繧定ｿ斐☆縲・
# Extra and album endpoints moved to src/backend/routers/albums.py.

try:
    from .routers.announcements import router as announcements_router
    from .routers.albums import router as albums_router
    from .routers.events import router as events_router
    from .routers.members import router as members_router
    from .routers.performances import router as performances_router
    from .routers.recordings import router as recordings_router
    from .routers.schedules import router as schedules_router
    from .routers.scores import router as scores_router
    from .auth_api import router as auth_router
except ImportError:  # pragma: no cover - allows running main.py directly.
    from routers.albums import router as albums_router
    from routers.announcements import router as announcements_router
    from routers.events import router as events_router
    from routers.members import router as members_router
    from routers.performances import router as performances_router
    from routers.recordings import router as recordings_router
    from routers.schedules import router as schedules_router
    from routers.scores import router as scores_router
    from auth_api import router as auth_router


app.include_router(performances_router)
app.include_router(schedules_router)
app.include_router(members_router)
app.include_router(events_router)
app.include_router(announcements_router)
app.include_router(recordings_router)
app.include_router(scores_router)
app.include_router(albums_router)
app.include_router(auth_router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
