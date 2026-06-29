from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import os
import re
import secrets
import shutil
import io
import zipfile
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

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
        load_json_from_storage,
        save_json_to_storage,
        storage_debug_info,
        storage_enabled,
        upload_file_to_drive,
    )
except ImportError:  # pragma: no cover - allows running main.py directly.
    from drive_storage import (
        get_storage_bucket,
        load_json_from_storage,
        save_json_to_storage,
        storage_debug_info,
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

# このファイルはアプリ全体の API とローカル JSON ストレージの仲介役。
# 基本方針は「JSON ファイルを正としつつ、必要なら Cloud Storage にも同期する」構成で、
# フロントエンド向けには複数コレクションをまとめた bootstrap API も提供している。

# ===== メモリキャッシング層 =====
class MemoryCache:
    """JSONデータをメモリに保持して高速化するキャッシュシステム"""
    def __init__(self):
        self._cache: dict[str, list[dict[str, Any]]] = {}
        self._etags: dict[str, str] = {}
        self._indexes: dict[str, dict[str, dict[str, Any]]] = {}  # name -> index_type -> index
    
    def get(self, name: str) -> list[dict[str, Any]] | None:
        """キャッシュからデータを取得"""
        return self._cache.get(name)
    
    def set(self, name: str, data: list[dict[str, Any]]) -> None:
        """キャッシュにデータを保存し、ETAGを更新"""
        self._cache[name] = data
        # JSONを文字列化してSHA256ハッシュを生成
        json_str = json.dumps(data, ensure_ascii=False, sort_keys=True)
        self._etags[name] = hashlib.sha256(json_str.encode()).hexdigest()
        # インデックスをリセット
        self._indexes.pop(name, None)
    
    def clear(self, name: str | None = None) -> None:
        """キャッシュを削除"""
        if name:
            self._cache.pop(name, None)
            self._etags.pop(name, None)
            self._indexes.pop(name, None)
        else:
            self._cache.clear()
            self._etags.clear()
            self._indexes.clear()
    
    def etag(self, name: str) -> str | None:
        """データのETAGを取得"""
        return self._etags.get(name)
    
    def get_index(self, name: str, index_type: str = "id") -> dict[str, Any] | None:
        """インデックスを取得（存在しなければ作成）"""
        data = self._cache.get(name)
        if not data:
            return None

        per_name_indexes = self._indexes.setdefault(name, {})
        if index_type not in per_name_indexes:
            if index_type == "id":
                # IDインデックス：高速ID検索用
                per_name_indexes[index_type] = {item.get("id"): (idx, item) for idx, item in enumerate(data)}
            elif index_type == "member_login":
                # メンバーログインインデックス：正規化された名前から検索
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
CONVERTED_DIR = UPLOAD_DIR / "converted"
DRIVE_STAGING_DIR = UPLOAD_DIR / "drive-staging"
SHEET_DIR = UPLOAD_DIR / "sheets"
JSON_DATA_NAMES = ("performances", "schedules", "announcements", "drive_files", "events", "members", "absences", "event_responses", "date_adjustments", "date_adjustment_responses", "sheet_library", "payments", "castings", "piece_infos", "practice_instructions", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "auth_devices", "access_logs", "recording_metadata", "desired_pieces", "promotions")
STARTUP_PRELOAD_COLLECTIONS = ("performances", "schedules", "announcements", "events", "members", "payments", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings")

for directory in (UPLOAD_DIR, DATA_DIR, CONVERTED_DIR, DRIVE_STAGING_DIR, SHEET_DIR):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="Orchestra Activity Tool",
    description="Performance, practice schedule, announcement, and recording management.",
    version="1.0.0",
)

# CORS_ORIGINS 環境変数で許可オリジンをカンマ区切りで設定できる。
# 未設定の場合はローカル開発向けにワイルドカードを継続して使用する。
# 例: CORS_ORIGINS=https://sites.google.com,https://kanade-portal-xxx.run.app
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
        # 静的ファイルはブラウザキャッシュを許可して初回以降の表示を高速化する。
        # index.html は下のルートで no-store にして、画面本体の更新漏れを防ぐ。
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
    permission: str = "一般"
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
    # Pydantic v1/v2 両対応で辞書化するための互換ヘルパー。
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


# ===== パスワードハッシュユーティリティ =====
# PBKDF2-SHA256 を使ったハッシュ化。追加ライブラリ不要。
# ハッシュ形式: "pbkdf2$sha256$<iterations>$<salt>$<hex_hash>"
# 旧形式（プレーンテキスト）はプレフィックスなし。

_PBKDF2_ALGO = "sha256"
_PBKDF2_ITERATIONS = 260000  # OWASP 2023推奨値


def hash_password(password: str) -> str:
    """PBKDF2-SHA256 でパスワードをハッシュ化して返す。"""
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(_PBKDF2_ALGO, password.encode(), salt.encode(), _PBKDF2_ITERATIONS)
    return f"pbkdf2${_PBKDF2_ALGO}${_PBKDF2_ITERATIONS}${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """入力パスワードと保存値を検証する。
    旧形式（プレーンテキスト）も軽欠的に受け入れる・タイミングアタック対策あり。
    """
    if not stored:
        return False
    if not stored.startswith("pbkdf2$"):
        # 旧形式: プレーンテキストの定数時間比較（タイミングアタック対策）
        return secrets.compare_digest(password.encode(), stored.encode())
    try:
        _, algo, iterations_str, salt, stored_hash = stored.split("$")
        dk = hashlib.pbkdf2_hmac(algo, password.encode(), salt.encode(), int(iterations_str))
        return secrets.compare_digest(dk.hex(), stored_hash)
    except (ValueError, TypeError):
        return False


def is_hashed_password(stored: str) -> bool:
    """ハッシュ済みパスワードか判定する。"""
    return stored.startswith("pbkdf2$")


def prepare_member_payload(member: Member, current: dict[str, Any] | None = None) -> dict[str, Any]:
    # 管理画面から新パスワードが送られた場合だけハッシュ化し、
    # 未入力更新では既存ハッシュを保持する。元パスワードの復元は行わない。
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
    # APIレスポンスや bootstrap には認証用ハッシュを出さず、設定有無だけを返す。
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
    # Cloud Run 標準の K_REVISION を優先し、既存の独自環境変数も後方互換で読む。
    return os.getenv("K_REVISION", "").strip() or os.getenv("CLOUD_RUN_REVISION", "").strip()


@app.get("/api/revision", response_model=None)
async def get_revision() -> Response:
    # リビジョンはデータ更新とは独立して変わるため、bootstrap の ETag キャッシュとは分離する。
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
    "performance_pieces": ("id", "performance_id", "sort_order", "title", "alias", "composer", "is_encore", "created_at", "updated_at"),
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
    # 高速な連続更新でも楽観ロック用の updated_at が必ず前回値より進むようにする。
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


# ===== JSON データ入出力 =====
def db_data_enabled() -> bool:
    if psycopg is None or psql is None:
        return False
    if os.getenv("DB_URL", "").strip():
        return True
    return all(os.getenv(name, "").strip() for name in ("DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"))


def env_flag_enabled(name: str) -> bool:
    return str(os.getenv(name, "")).strip().lower() in {"1", "true", "yes", "on"}


def db_expected() -> bool:
    # DB_REQUIRED が有効、または DB 関連環境変数のいずれかが設定されていれば
    # DB 接続を期待している状態とみなす。
    if env_flag_enabled("DB_REQUIRED"):
        return True
    return any(os.getenv(name, "").strip() for name in ("DB_URL", "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"))


def ensure_db_expected_is_ready() -> None:
    # DB 利用を期待しているのに接続設定が不完全な場合、
    # JSON への暗黙フォールバックを防いで即時に設定不備として返す。
    if db_expected() and not db_data_enabled():
        raise HTTPException(
            status_code=500,
            detail="DB is expected but not fully configured. Set DB_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD.",
        )


def run_db_startup_self_check() -> None:
    # DB 利用を期待していない環境では何もしない。
    if not db_expected():
        return

    # 期待時は設定不備を即時検知する。
    ensure_db_expected_is_ready()
    assert_db_ready()

    try:
        with psycopg.connect(db_connection_string(), autocommit=True) as conn:
            ensure_db_schema_compatibility(conn)
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
                # 読み取りの中核となる members テーブル存在を確認する。
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
    # save_json_data は常にコレクション全体を保存するため、子テーブルも全体を作り直す。
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
    # コレクション名からローカル JSON ファイルパスを解決する。
    return DATA_DIR / f"{name}.json"


def load_local_json_data(name: str) -> list[dict[str, Any]]:
    # ローカル JSON を読み込み、配列でなければ空配列として扱う。
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
    # 参照頻度の高い一覧はまずメモリキャッシュを見る。
    # Cloud Storage が有効ならクラウドを優先し、無ければローカルへフォールバックする。
    cached = _memory_cache.get(name)
    if cached is not None:
        return cached

    if name in JSON_COLLECTION_TABLES:
        ensure_db_expected_is_ready()

    if db_data_enabled() and name in JSON_COLLECTION_TABLES:
        db_data = db_load_json_data(name)
        _memory_cache.set(name, db_data)
        return db_data
    
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
            _memory_cache.set(name, cloud_data)
            return cloud_data

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
    
    # 書き込み直後の再読込を速くするため、保存成功時点でキャッシュも更新する。
    _memory_cache.set(name, data)

    if storage_enabled():
        try:
            save_json_to_storage(name, data)
        except Exception as exc:
            logger.exception("Failed to save %s.json to Cloud Storage", name)
            raise HTTPException(
                status_code=502,
                detail=f"Failed to save {name}.json to Cloud Storage: {exc}",
            ) from exc


def has_connection_setting(items: list[dict[str, Any]]) -> bool:
    # 接続設定として意味のある値が1件でもあれば設定済みとみなす。
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
            value and value not in {"your_bucket_name_here", "あなたのGCSバケット名"}
            for value in values
        ):
            return True
    return False


def legacy_connection_setting_from_env() -> dict[str, Any]:
    # 旧運用の環境変数を新しい connection_settings レコードへ変換する。
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
        # 旧運用互換のため、未設定時は空文字のまま登録する。
        "google_cloud_storage_data_prefix": os.getenv("GOOGLE_CLOUD_STORAGE_DATA_PREFIX", "").strip(),
        "google_cloud_storage_public": public_value,
        "google_service_account_file": os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip(),
        "google_service_account_json": os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip(),
    }


def seed_connection_settings_from_legacy_env() -> None:
    # connection_settings が空の環境では、旧環境変数値を1件自動登録する。
    # これにより接続情報メニュー導入後も既存デプロイの設定を引き継げる。
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
    # 旧環境変数運用から移行した環境では接続設定を先に補完する。
    seed_connection_settings_from_legacy_env()
    logger.info("Storage diagnostics: %s", storage_debug_info())

    # 起動時に主要コレクションをキャッシュへ温める。
    # さらに Cloud Storage が空なら、既存ローカル JSON を初回シードとして送る。
    for name in STARTUP_PRELOAD_COLLECTIONS:
        logger.info("Startup preload begin: %s", name)
        try:
            loaded = load_json_data(name)  # キャッシュに読み込み
            logger.info("Startup preload done: %s (%s items)", name, len(loaded))
        except HTTPException as exc:
            logger.exception("Startup preload failed: %s (%s)", name, exc)
            if db_expected():
                raise
    
    if not storage_enabled():
        logger.info("Storage disabled; skipping cloud seeding")
        return

    for name in JSON_DATA_NAMES:
        logger.info("Cloud seed check begin: %s", name)
        local_path = data_file(name)
        if not local_path.exists():
            logger.info("Cloud seed skipped (local missing): %s", name)
            continue
        try:
            cloud_data = load_json_from_storage(name)
            if cloud_data is None:
                local_data = load_local_json_data(name)
                save_json_to_storage(name, local_data)
                logger.info("Cloud seed done: %s (%s items)", name, len(local_data))
            else:
                logger.info("Cloud seed skipped (already exists): %s (%s items)", name, len(cloud_data))
        except Exception:
            logger.exception("Cloud seed failed: %s", name)


@asynccontextmanager
async def app_lifespan(_: FastAPI):
    run_db_startup_self_check()
    await seed_cloud_data_from_local()
    yield


app.router.lifespan_context = app_lifespan


def next_id(items: list[dict[str, Any]]) -> int:
    # 既存最大 ID + 1 を返す。
    return max((int(item.get("id", 0)) for item in items), default=0) + 1


def find_item(items: list[dict[str, Any]], item_id: int) -> tuple[int, dict[str, Any]]:
    # キャッシュ済みコレクションは ID インデックスを使って O(1) で探す。
    for data_name in JSON_DATA_NAMES:
        if _memory_cache.get(data_name) is items:
            index_map = _memory_cache.get_index(data_name, "id")
            if index_map and item_id in index_map:
                return index_map[item_id]
    
    # インデックスが無い場合は線形検索
    for index, item in enumerate(items):
        if item.get("id") == item_id:
            return index, item
    raise HTTPException(status_code=404, detail="Data not found")


def check_etag(request: Request, data_name: str) -> Response | None:
    """ETagチェック - 変更がなければ304を返す"""
    etag = _memory_cache.etag(data_name)
    if not etag:
        return None
    
    if_none_match = request.headers.get("if-none-match", "")
    if if_none_match == etag:
        return Response(status_code=304)
    return None


def combined_collection_etag(names: tuple[str, ...]) -> str:
    # bootstrap は複数コレクションをまとめて返すため、単一テーブルではなく
    # レスポンスに含まれる全データの ETag を合成して 304 判定に使う。
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


def compact_member_name(value: Any) -> str:
    # ログイン名比較用に空白差・大文字小文字差を吸収する。
    return re.sub(r"[\s\u3000]+", "", str(value or "")).strip().lower()


def compact_member_part(value: Any) -> str:
    # パート比較でも空白差と大文字小文字差を吸収する。
    return re.sub(r"[\s\u3000]+", "", str(value or "")).strip().lower()


def member_display_name(member: dict[str, Any]) -> str:
    # 団員表示名の標準形を返す。
    full_name = f"{member.get('last_name') or ''}{member.get('first_name') or ''}"
    return full_name or str(member.get("name") or "")


def member_login_names(member: dict[str, Any]) -> set[str]:
    # ログイン時は表記ゆれを許容するため、氏名・かな・旧姓をまとめて候補化する。
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
    # ログイン入力の名前/パートから団員を特定する。
    # 一意名ならパート表記ゆれを許容し、同名複数人の誤認証は避ける。
    normalized = compact_member_name(name)
    if not normalized:
        raise HTTPException(status_code=400, detail="name is required")

    normalized_part = compact_member_part(part)
    candidates: list[tuple[int, dict[str, Any]]] = []
    for index, item in enumerate(items):
        if normalized in member_login_names(item):
            candidates.append((index, item))

    if not candidates:
        raise HTTPException(status_code=404, detail="Member not found")

    if normalized_part:
        strict_matches = [
            (index, item)
            for index, item in candidates
            if compact_member_part(member_part(item)) == normalized_part
        ]
        if strict_matches:
            return strict_matches[0]

        if len(candidates) == 1:
            return candidates[0]

    raise HTTPException(status_code=404, detail="Member not found")


def is_hidden_system_admin_login(login: PortalLoginRequest) -> bool:
    # 非公開の緊急管理者ログイン判定。
    return login.name == "Administrator" and login.password == "systemadminadmin"


def member_part(member: dict[str, Any]) -> str:
    # 団員レコードからパート名を安全に取得する。
    return str(member.get("part") or "")


def member_is_extra(member: dict[str, Any]) -> bool:
    # 権限種別がエキストラかを判定する。
    return str(member.get("permission") or "") == "エキストラ"


def member_access_expired(member: dict[str, Any]) -> bool:
    if not member_is_extra(member):
        return False
    access_until = str(member.get("system_access_until") or "").strip()
    if not access_until:
        return False
    # YYYY-MM-DD 形式のみ期限判定に使用する。
    # 不正な形式は入力中データとして扱い、ここではアクセス拒否しない。
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", access_until):
        return False
    today_str = datetime.now().date().isoformat()
    return access_until < today_str


# ===== 認証・端末管理 API =====
# ポータルログインを検証し、端末認証情報を発行/更新する。
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
        if member_access_expired(member):
            raise HTTPException(status_code=403, detail="システム利用期限が終了しています")
        member_password = str(member.get("password") or "")
        if not member_password:
            return {
                "authenticated": False,
                "needs_password_setup": True,
                "member_id": member.get("id"),
            }
        if not verify_password(login.password, member_password):
            raise HTTPException(status_code=401, detail="Invalid member password")
        # 旧形式（プレーンテキスト）パスワードが検証できた場合は自動的にハッシュ化して保存する。
        if not is_hashed_password(member_password):
            members = load_json_data("members")
            for m in members:
                if m.get("id") == member.get("id"):
                    m["password"] = hash_password(login.password)
                    m["updated_at"] = datetime.now().isoformat()
                    break
            save_json_data("members", members)
            logger.info("Auto-migrated password hash for member_id=%s", member.get("id"))

    device_id = login.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required")

    devices = load_json_data("auth_devices")
    now = datetime.now().isoformat()
    # 端末ごとのログイン状態を auth_devices に保存し、次回以降の自動ログイン判定に使う。
    existing = next((item for item in devices if item.get("device_id") == device_id), None)
    payload = {
        "device_id": device_id,
        "device_name": login.device_name or "Unknown device",
        "member_id": member.get("id"),
        "member_name": member_display_name(member),
        "member_part": member_part(member),
        "permission": member.get("permission") or "一般",
        "system_access_until": member.get("system_access_until") or "",
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
        "system_access_until": payload["system_access_until"],
        "is_recording_manager": payload["is_recording_manager"],
        "is_sheet_manager": payload["is_sheet_manager"],
        "hidden_user": payload["hidden_user"],
    }


# 団員の初回パスワード登録を行う。
@app.post("/api/auth/member-password")
async def set_member_password(payload: MemberPasswordSetupRequest) -> dict[str, Any]:
    # 初回ログイン時の個別パスワード登録 API。
    password = payload.password.strip()
    if not password:
        raise HTTPException(status_code=400, detail="password is required")
    members = load_json_data("members")
    index, member = find_member_by_login_name(members, payload.name, payload.part)
    if member.get("password"):
        raise HTTPException(status_code=409, detail="Member password is already set")
    # 初回登録時は常に PBKDF2 ハッシュ化して保存する。
    member["password"] = hash_password(password)
    member["updated_at"] = datetime.now().isoformat()
    members[index] = member
    save_json_data("members", members)
    return {"password_registered": True, "member_id": member.get("id")}


# 端末ID単位で現在の認証状態を照会する。
@app.get("/api/auth/devices/{device_id}")
async def get_auth_device(device_id: str) -> dict[str, Any]:
    # 端末 ID から認証状態を確認し、最終アクセス時刻を更新する。
    devices = load_json_data("auth_devices")
    item = next((device for device in devices if device.get("device_id") == device_id), None)
    if not item:
        return {"authenticated": False}

    member_id = item.get("member_id")
    if member_id is not None:
        members = load_json_data("members")
        member = next((value for value in members if value.get("id") == member_id), None)
        if member and member_access_expired(member):
            # 利用期限切れ時は端末認証を無効化
            save_json_data("auth_devices", [device for device in devices if device.get("device_id") != device_id])
            return {"authenticated": False}

    item["last_seen_at"] = datetime.now().isoformat()
    save_json_data("auth_devices", devices)
    return {"authenticated": True, "device": item}


# 端末認証の履歴一覧を新しい順で返す。
@app.get("/api/auth/devices")
async def get_auth_devices() -> list[dict[str, Any]]:
    return sorted(
        load_json_data("auth_devices"),
        key=lambda item: str(item.get("authenticated_at") or ""),
        reverse=True,
    )


# 指定端末の認証情報を削除して再ログインを要求可能にする。
@app.delete("/api/auth/devices/{device_id}")
async def delete_auth_device(device_id: str, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    require_admin_device(x_device_id)
    devices = load_json_data("auth_devices")
    save_json_data("auth_devices", [item for item in devices if item.get("device_id") != device_id])
    return {"message": "Deleted"}


# ===== アクセスログ =====
# 団員がどのメニューへ入ったかを保存する。閲覧はシステム管理者に限定する。
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
    # ログが無制限に増えないよう、直近2000件を保持する。
    items = sorted(items, key=lambda item: str(item.get("accessed_at") or item.get("created_at") or ""))[-2000:]
    save_json_data("access_logs", items)
    return payload


@app.get("/api/system/access-logs")
async def list_access_logs(limit: int = 200, x_device_id: str = Header(default="", alias="X-Device-Id")) -> list[dict[str, Any]]:
    require_system_admin_device(x_device_id)
    safe_limit = min(max(int(limit or 200), 1), 1000)
    items = load_json_data("access_logs")
    return sorted(items, key=lambda item: str(item.get("accessed_at") or item.get("created_at") or ""), reverse=True)[:safe_limit]


# ===== 初期描画用 bootstrap API =====
# 初期描画に必要な最小データを返す軽量 bootstrap API。
@app.get("/api/bootstrap-lite", response_model=None)
async def get_bootstrap_lite_data(request: Request) -> dict[str, Any] | Response:
    """初期表示に必要な最小限のデータだけを返す。"""
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


# 録音/楽譜の重い走査を除いた通常 bootstrap API。
@app.get("/api/bootstrap-core", response_model=None)
async def get_bootstrap_core_data(request: Request) -> dict[str, Any] | Response:
    """録音・楽譜一覧のファイル走査を除いた通常データ。"""
    extra_names = ("absences", "event_responses", "date_adjustments", "date_adjustment_responses", "payments", "castings", "piece_infos", "practice_instructions", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "desired_pieces", "promotions")
    etag = combined_collection_etag(("performances", "schedules", "announcements", "events", "members", "auth_devices", *extra_names))
    extras = {name: load_json_data(name) for name in extra_names}
    data = {
        "performances": load_json_data("performances"),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "events": load_json_data("events"),
        "members": public_member_list(load_json_data("members")),
        "extras": extras,
        "auth_devices": await get_auth_devices(),
        "cloudRunRevision": cloud_run_revision(),
    }
    return bootstrap_response(request, data, etag)


# 画面に必要なデータを包括的に返すフル bootstrap API。
@app.get("/api/bootstrap", response_model=None)
async def get_bootstrap_data(request: Request) -> dict[str, Any] | Response:
    extra_names = ("absences", "event_responses", "date_adjustments", "date_adjustment_responses", "sheet_library", "payments", "castings", "piece_infos", "practice_instructions", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "desired_pieces", "promotions")
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
        "auth_devices": await get_auth_devices(),
        "cloudRunRevision": cloud_run_revision(),
    }
    return bootstrap_response(request, data, etag)


# ===== アップロード・ファイル補助 =====
def safe_segment(value: str, default: str) -> str:
    # ファイル/フォルダ名として危険な文字を除去して安全化する。
    value = (value or default).strip()
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value or default


def safe_upload_name(filename: str) -> str:
    # 元ファイル名を安全な保存名へ変換する。
    suffix = Path(filename).suffix.lower()
    stem = safe_segment(Path(filename).stem, "audio")
    return f"{stem}{suffix}"


def ensure_audio_file(file: UploadFile) -> str:
    # 録音アップロード対象が mp3/m4a かを検証する。
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".mp3", ".m4a"}:
        raise HTTPException(status_code=400, detail="Please upload an MP3 or M4A file")
    return suffix


def ensure_pdf_file(file: UploadFile) -> None:
    # 楽譜アップロード対象が PDF かを検証する。
    suffix = Path(file.filename or "").suffix.lower()
    if suffix != ".pdf":
        raise HTTPException(status_code=400, detail="Please upload a PDF file")


def local_recording_metadata(path: Path) -> dict[str, Any]:
    # 物理ファイルの属性と、別管理している録音時間メタデータを合成して返す。
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
    # Cloud 録音メタデータに再生/ダウンロード API URL を補完する。
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
    # Cloud 録音一覧へ最新項目を先頭追加で保存する。
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
    # Cloud 録音一覧から object_name に一致する項目を除去する。
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
    # アップロードファイルを指定ディレクトリへ保存し、保存パスを返す。
    directory.mkdir(parents=True, exist_ok=True)
    output_path = directory / safe_upload_name(file.filename or "audio")
    with output_path.open("wb") as target:
        shutil.copyfileobj(file.file, target)
    return output_path


def local_sheet_path(path: str) -> Path:
    # 楽譜のローカル実体パスを検証付きで解決する。
    requested = (UPLOAD_DIR / path).resolve()
    if not requested.is_file() or SHEET_DIR.resolve() not in requested.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return requested


def sheet_metadata(item: dict[str, Any]) -> dict[str, Any]:
    # 保存先がローカルか Cloud Storage かにかかわらず、
    # フロントが同じキー名で扱えるよう view/download URL を正規化する。
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
    # 楽譜一覧をフロント表示向けメタデータ形式へ変換する。
    return [sheet_metadata(item) for item in load_json_data("sheet_library")]


def delete_sheet_file(item: dict[str, Any]) -> None:
    # 楽譜実体を保存先（Cloud/ローカル）に応じて削除する。
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
    # 楽譜 ZIP 作成用にファイル実体を bytes で取得する。
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
    # 録音 ZIP 作成用にファイル実体を bytes で取得する。
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
    # ZIP 内でファイル名が衝突しないよう連番付きで一意化する。
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
    # 録音ファイル長（秒）を取得する。失敗時は None。
    if AudioSegment is None:
        return None
    try:
        audio = AudioSegment.from_file(path)
        return round(len(audio) / 1000, 1)
    except Exception:
        logger.warning("Failed to get audio duration: %s", path, exc_info=True)
        return None


def format_duration(seconds: float | int | None) -> str:
    # 秒数を mm:ss / h:mm:ss 形式へ整形する。
    if seconds is None:
        return ""
    total = int(round(float(seconds)))
    minutes, sec = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{sec:02d}"
    return f"{minutes}:{sec:02d}"

def recording_metadata_map() -> dict[str, dict[str, Any]]:
    # 録音時間メタデータを path/object_name キーの辞書に展開する。
    items = load_json_data("recording_metadata")  # キャッシュから高速取得
    return {str(item.get("path") or item.get("object_name") or item.get("id") or ""): item for item in items}

def remember_recording_duration(path_key: str, duration_seconds: float | None) -> None:
    # 録音時間メタデータを upsert する。
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


# ===== ルート・死活監視 =====
# SPA のエントリ HTML を返すルート。
@app.get("/")
async def root() -> FileResponse:
    return FileResponse(
        BASE_DIR / "index.html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


# サービスの死活と基本状態を返すヘルスチェック API。
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


# 親レコードが削除されたために孤立したデータを検出して返す。


def fk_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@app.get("/api/maintenance/orphans")
async def get_maintenance_orphans(x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    """参照先が存在しない孤立レコードを返す（管理者専用）。"""
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
    """DBテーブル一覧を返す（システム管理者専用）。"""
    require_system_admin_device(x_device_id)
    assert_db_ready()

    conn_str = db_connection_string()
    with psycopg.connect(conn_str, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                ORDER BY table_name
                """
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
    """指定テーブルのレコードを返す（システム管理者専用）。"""
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
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = %s
                ORDER BY ordinal_position
                """,
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


# ===== 基本マスタ CRUD =====
# 演奏会一覧を取得する。
@app.get("/api/performances", response_model=list[Performance])
async def get_performances() -> list[dict[str, Any]]:
    return load_json_data("performances")


# 演奏会を新規作成する。
@app.post("/api/performances", response_model=Performance)
async def create_performance(performance: Performance, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
    items = load_json_data("performances")
    now = datetime.now().isoformat()
    payload = model_dump(performance)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("performances", items)
    return payload


# 指定 ID の演奏会を取得する。
@app.get("/api/performances/{performance_id}", response_model=Performance)
async def get_performance(performance_id: int) -> dict[str, Any]:
    _, item = find_item(load_json_data("performances"), performance_id)
    return item


# 指定 ID の演奏会を更新する。
@app.put("/api/performances/{performance_id}", response_model=Performance)
async def update_performance(performance_id: int, performance: Performance, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
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


# 指定 ID の演奏会を削除する。
@app.delete("/api/performances/{performance_id}")
async def delete_performance(performance_id: int, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    require_admin_device(x_device_id)
    items = load_json_data("performances")
    find_item(items, performance_id)
    save_json_data("performances", [item for item in items if item.get("id") != performance_id])
    return {"message": "Deleted"}


# 練習予定一覧を取得する。
@app.get("/api/schedules", response_model=list[Schedule])
async def get_schedules() -> list[dict[str, Any]]:
    return load_json_data("schedules")


# 練習予定を新規作成する。
@app.post("/api/schedules", response_model=Schedule)
async def create_schedule(schedule: Schedule, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
    items = load_json_data("schedules")
    now = datetime.now().isoformat()
    payload = model_dump(schedule)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("schedules", items)
    return payload


# 指定 ID の練習予定を取得する。
@app.get("/api/schedules/{schedule_id}", response_model=Schedule)
async def get_schedule(schedule_id: int) -> dict[str, Any]:
    _, item = find_item(load_json_data("schedules"), schedule_id)
    return item


# 指定 ID の練習予定を更新する。
@app.put("/api/schedules/{schedule_id}", response_model=Schedule)
async def update_schedule(schedule_id: int, schedule: Schedule, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
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


# 指定 ID の練習予定を削除する。
@app.delete("/api/schedules/{schedule_id}")
async def delete_schedule(schedule_id: int, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    require_admin_device(x_device_id)
    items = load_json_data("schedules")
    find_item(items, schedule_id)
    save_json_data("schedules", [item for item in items if item.get("id") != schedule_id])
    return {"message": "Deleted"}




# 団員一覧を取得する。
@app.get("/api/members", response_model=list[Member])
async def get_members() -> list[dict[str, Any]]:
    return public_member_list(load_json_data("members"))


# 団員を新規作成する。
@app.post("/api/members", response_model=Member)
async def create_member(member: Member, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
    items = load_json_data("members")
    now = datetime.now().isoformat()
    payload = prepare_member_payload(member)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("members", items)
    return public_member_payload(payload)


# 指定 ID の団員情報を更新する。
@app.put("/api/members/{member_id}", response_model=Member)
async def update_member(member_id: int, member: Member, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
    items = load_json_data("members")
    index, current = find_item(items, member_id)
    payload = prepare_member_payload(member, current)
    payload.update({
        "id": member_id,
        "created_at": current.get("created_at"),
        "updated_at": datetime.now().isoformat(),
    })
    items[index] = payload
    save_json_data("members", items)
    return public_member_payload(payload)


# 指定 ID の団員情報を削除する。
@app.delete("/api/members/{member_id}")
async def delete_member(member_id: int, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    require_admin_device(x_device_id)
    items = load_json_data("members")
    find_item(items, member_id)
    save_json_data("members", [item for item in items if item.get("id") != member_id])
    return {"message": "Deleted"}


# イベント一覧を取得する。
@app.get("/api/events", response_model=list[EventAdjustment])
async def get_events() -> list[dict[str, Any]]:
    return load_json_data("events")


# イベントを新規作成する。
@app.post("/api/events", response_model=EventAdjustment)
async def create_event(event: EventAdjustment, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
    items = load_json_data("events")
    now = datetime.now().isoformat()
    payload = model_dump(event)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("events", items)
    return payload


# 指定 ID のイベントを更新する。
@app.put("/api/events/{event_id}", response_model=EventAdjustment)
async def update_event(event_id: int, event: EventAdjustment, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
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


# 指定 ID のイベントを削除する。
@app.delete("/api/events/{event_id}")
async def delete_event(event_id: int, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    require_admin_device(x_device_id)
    items = load_json_data("events")
    find_item(items, event_id)
    save_json_data("events", [item for item in items if item.get("id") != event_id])
    return {"message": "Deleted"}


# お知らせ一覧を取得する。
@app.get("/api/announcements", response_model=list[Announcement])
async def get_announcements() -> list[dict[str, Any]]:
    return load_json_data("announcements")


# お知らせを新規作成する。
@app.post("/api/announcements", response_model=Announcement)
async def create_announcement(announcement: Announcement, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
    items = load_json_data("announcements")
    now = datetime.now().isoformat()
    payload = model_dump(announcement)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("announcements", items)
    return payload


# 指定 ID のお知らせを取得する。
@app.get("/api/announcements/{announcement_id}", response_model=Announcement)
async def get_announcement(announcement_id: int) -> dict[str, Any]:
    _, item = find_item(load_json_data("announcements"), announcement_id)
    return item


# 指定 ID のお知らせを更新する。
@app.put("/api/announcements/{announcement_id}", response_model=Announcement)
async def update_announcement(announcement_id: int, announcement: Announcement, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
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


# 指定 ID のお知らせを削除する。
@app.delete("/api/announcements/{announcement_id}")
async def delete_announcement(announcement_id: int, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    require_admin_device(x_device_id)
    items = load_json_data("announcements")
    find_item(items, announcement_id)
    save_json_data("announcements", [item for item in items if item.get("id") != announcement_id])
    return {"message": "Deleted"}


# ===== 録音ファイル API =====
# 録音ファイルを受け取り、必要に応じてクラウドへ同期して登録する。
@app.post("/api/convert")
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
    # Cloud 上の録音を先頭に、ローカル録音を更新日時降順で続けて返す。
    # 同じ録音が Cloud とローカルの両方にある場合は Cloud 側を優先し、
    # アップロード直後の一覧で同一ファイルが二重表示されないようにする。
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


# 録音一覧（Cloud + ローカル統合）を返す。
@app.get("/api/recordings")
async def get_recordings() -> dict[str, list[dict[str, Any]]]:
    return recording_payload()


# 条件に一致する録音を ZIP にまとめてダウンロードさせる。
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


# ローカル録音を再生用途で返す。
@app.get("/api/recordings/play/{path:path}")
async def play_recording(path: str) -> FileResponse:
    requested = local_recording_path(path)
    return FileResponse(
        requested,
        media_type=mimetypes.guess_type(requested.name)[0] or "application/octet-stream",
    )


# ローカル録音を添付ダウンロードで返す。
@app.get("/api/recordings/download/{path:path}")
async def download_recording(path: str) -> FileResponse:
    requested = local_recording_path(path)
    return FileResponse(requested, filename=requested.name)


# 録音（Cloud またはローカル）を削除する。
@app.delete("/api/recordings")
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
    # Cloud Storage 上のファイルを、再生時は Range 対応で、
    # ダウンロード時は通常添付として配信する共通ストリーマー。
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


# Cloud 録音を Range 対応で再生配信する。
@app.get("/api/recordings/cloud/play/{object_name:path}")
async def play_cloud_recording(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=False, request=request)


# Cloud 録音を添付ダウンロードで配信する。
@app.get("/api/recordings/cloud/download/{object_name:path}")
async def download_cloud_recording(object_name: str, request: Request) :
    return stream_storage_blob(object_name, download=True, request=request)


# 録音を Cloud Storage へアップロードしメタデータを返す。
@app.post("/api/drive/upload")
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


# Cloud 録音メタデータ一覧を返す。
@app.get("/api/drive/files")
async def get_drive_files() -> dict[str, list[dict[str, Any]]]:
    return {"files": load_json_data("drive_files")}


# ===== 楽譜 API =====
# 楽譜一覧を返す。
@app.get("/api/sheets")
async def get_sheets() -> dict[str, list[dict[str, Any]]]:
    return {"files": sheet_payload()}


# ローカル楽譜を添付ダウンロードで返す。
@app.get("/api/sheets/download/{path:path}")
async def download_local_sheet(path: str) -> FileResponse:
    requested = local_sheet_path(path)
    return FileResponse(requested, media_type="application/pdf", filename=requested.name)


# ローカル楽譜をインライン表示用に返す。
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


# Cloud 楽譜を添付ダウンロードで返す。
@app.get("/api/sheets/cloud/download/{object_name:path}")
async def download_cloud_sheet(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=True, request=request)


# Cloud 楽譜をインライン表示用に返す。
@app.get("/api/sheets/cloud/view/{object_name:path}")
async def view_cloud_sheet(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=False, request=request)


# 条件に一致する楽譜を ZIP にまとめて返す。
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


# 楽譜 PDF を受け取り、保存先に応じて登録する。
@app.post("/api/sheets/upload")
async def upload_sheet(
    file: UploadFile = File(...),
    performance_id: str = Form(""),
    performance_title: str = Form(""),
    piece: str = Form(""),
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    ensure_pdf_file(file)
    if not performance_id:
        raise HTTPException(status_code=400, detail="performance_id is required")
    if not piece:
        raise HTTPException(status_code=400, detail="piece is required")

    performance_dir = safe_segment(f"{performance_id}_{performance_title}", "performance")
    piece_dir = safe_segment(piece, "piece")
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


# 指定楽譜のパート情報を更新する。
@app.put("/api/sheets/{sheet_id}/part")
async def update_sheet_part(sheet_id: int, payload: SheetPartUpdateRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    items = load_json_data("sheet_library")
    index, current = find_item(items, sheet_id)
    current["part"] = payload.part.strip()
    current["updated_at"] = datetime.now().isoformat()
    items[index] = current
    save_json_data("sheet_library", items)
    return sheet_metadata(current)


# 複数楽譜のパート情報を一括更新する。
@app.put("/api/sheets/parts")
async def update_sheets_parts(payload: SheetBulkPartUpdateRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    if not payload.sheet_ids:
        raise HTTPException(status_code=400, detail="sheet_ids is required")
    if not payload.part.strip():
        raise HTTPException(status_code=400, detail="part is required")
    
    items = load_json_data("sheet_library")
    updated_count = 0
    part_value = payload.part.strip()
    now_str = datetime.now().isoformat()
    
    # 一括更新は件数が比較的小さい前提のため、
    # 既存の順序を保ったまま対象だけを書き換える単純な更新にしている。
    for sheet_id in payload.sheet_ids:
        for i, item in enumerate(items):
            if item.get("id") == sheet_id:
                items[i]["part"] = part_value
                items[i]["updated_at"] = now_str
                updated_count += 1
                break
    
    save_json_data("sheet_library", items)
    return {"updated_count": updated_count, "message": f"{updated_count} sheets updated"}


# 条件指定で楽譜を削除する（単票/曲単位/演奏会単位）。
@app.delete("/api/sheets")
async def delete_sheets(payload: SheetDeleteRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
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


EXTRA_COLLECTIONS = {"absences", "event_responses", "date_adjustments", "date_adjustment_responses", "sheet_library", "payments", "castings", "piece_infos", "practice_instructions", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "desired_pieces", "promotions"}
ADMIN_ONLY_EXTRA_COLLECTIONS = {
    "sheet_library",
    "payments",
    "castings",
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

    # absences / event_responses は本人入力想定。
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

# ===== 汎用 extra コレクション CRUD =====
# 機能追加のたびに専用 API を増やさずに済むよう、
# JSON 配列ベースの補助データはこの共通エンドポイントで扱う。
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

# 指定 extra コレクションの一覧を返す。
@app.get("/api/extra/{name}")
async def get_extra_items(name: str) -> list[dict[str, Any]]:
    return collection_items(name)

# 指定 extra コレクションへ新規項目を追加する。
@app.post("/api/extra/{name}")
async def create_extra_item(name: str, request: Request, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    device = require_device(x_device_id)
    items = collection_items(name)
    upsert = parse_extra_upsert_request(await read_json_body(request))
    normalized_body = normalize_extra_for_collection(name, upsert.payload)
    assert_extra_collection_permission(name, device, payload=normalized_body)
    payload = normalize_extra_payload(normalized_body, next_id(items))
    items.append(payload)
    save_json_data(name, items)
    return payload

# 指定 extra コレクションの項目を更新する。
@app.put("/api/extra/{name}/{item_id}")
async def update_extra_item(name: str, item_id: int, request: Request, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    device = require_device(x_device_id)
    items = collection_items(name)
    index, current = find_item(items, item_id)
    upsert = parse_extra_upsert_request(await read_json_body(request))
    ensure_expected_updated_at(current, upsert.expected_updated_at)
    normalized_body = normalize_extra_for_collection(name, upsert.payload)
    assert_extra_collection_permission(name, device, payload=normalized_body, current=current)
    payload = normalize_extra_payload(normalized_body, item_id, current)
    items[index] = payload
    save_json_data(name, items)
    return payload

# 指定 extra コレクションの項目を削除する。
@app.delete("/api/extra/{name}/{item_id}")
async def delete_extra_item(name: str, item_id: int, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    device = require_device(x_device_id)
    items = collection_items(name)
    _, current = find_item(items, item_id)
    assert_extra_collection_permission(name, device, current=current)
    save_json_data(name, [item for item in items if item.get("id") != item_id])
    return {"message": "Deleted"}


# ===== アルバム機能（写真アップロード・削除） =====
# アルバムへの写真アップロード。Google Cloud Storage に保存し、メタデータはローカル JSON に記録。
@app.post("/api/extra/albums/{album_id}/photos")
async def upload_album_photo(
    album_id: int,
    file: UploadFile = File(...),
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    device = require_device(x_device_id)
    
    # アルバムデータを読み込み、該当するアルバムを検出
    albums = load_json_data("albums")
    index, album = find_item(albums, album_id)
    
    # 写真メタデータ用の情報を準備
    member_id = device.get("member_id")
    member_name = device.get("member_name") or str(device.get("member_id") or "")
    now = datetime.now().isoformat()
    
    # 次の写真IDを決定（該当アルバムの photos 配列の最大値 + 1）
    photos = album.get("photos") or []
    next_photo_id = max([p.get("id", 0) for p in photos], default=0) + 1
    
    # ファイル名を安全化
    filename = safe_upload_name(file.filename or "photo.jpg")
    date_dir = datetime.now().strftime("%Y-%m-%d")
    
    # 一時的にファイルをメモリに読み込む
    file_content = await file.read()
    
    # Google Cloud Storage へのアップロード
    photo_metadata = None
    if storage_enabled():
        try:
            bucket = get_storage_bucket()
            object_name = f"albums/{album_id}/{date_dir}/{next_photo_id}_{filename}"
            blob = bucket.blob(object_name)
            blob.upload_from_string(
                file_content,
                content_type=file.content_type or "application/octet-stream"
            )
            
            photo_metadata = {
                "id": next_photo_id,
                "filename": filename,
                # 表示URLは常にAPI経由に統一し、公開設定の有無に依存させない。
                "url": f"/api/albums/{album_id}/photos/{next_photo_id}",
                "uploaded_by_member_id": member_id,
                "uploaded_by_member_name": member_name,
                "uploaded_at": now,
                "object_name": object_name,
            }
        except Exception as exc:
            logger.exception("Album photo upload to GCS failed")
            raise HTTPException(
                status_code=502,
                detail=f"Photo upload failed: {exc}",
            ) from exc
    else:
        # ローカルストレージへのフォールバック
        photo_dir = UPLOAD_DIR / "albums" / str(album_id) / date_dir
        photo_dir.mkdir(parents=True, exist_ok=True)
        photo_path = photo_dir / f"{next_photo_id}_{filename}"
        photo_path.write_bytes(file_content)
        
        photo_metadata = {
            "id": next_photo_id,
            "filename": filename,
            "url": f"/api/albums/{album_id}/photos/{next_photo_id}",
            "uploaded_by_member_id": member_id,
            "uploaded_by_member_name": member_name,
            "uploaded_at": now,
            "path": str(photo_path.relative_to(UPLOAD_DIR).as_posix()),
        }
    
    # アルバムの photos 配列に追加
    if "photos" not in album:
        album["photos"] = []
    album["photos"].append(photo_metadata)
    album["updated_at"] = now
    
    # 保存
    albums[index] = album
    save_json_data("albums", albums)
    
    return photo_metadata


# アルバム写真表示。保存先が Cloud / ローカル どちらでも同じ API で配信する。
@app.get("/api/albums/{album_id}/photos/{photo_id}")
async def get_album_photo(album_id: int, photo_id: int) -> Response:
    albums = load_json_data("albums")
    _, album = find_item(albums, album_id)

    photos = album.get("photos") or []
    photo = next((item for item in photos if item.get("id") == photo_id), None)
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")

    filename = str(photo.get("filename") or "photo")
    content_type, _ = mimetypes.guess_type(filename)
    media_type = content_type or "application/octet-stream"

    object_name = str(photo.get("object_name") or "").strip()
    if object_name:
        try:
            bucket = get_storage_bucket()
            blob = bucket.blob(object_name)
            if not blob.exists():
                raise HTTPException(status_code=404, detail="Photo object not found")
            data = blob.download_as_bytes()
            return Response(content=data, media_type=media_type)
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("Album photo fetch from GCS failed")
            raise HTTPException(status_code=502, detail=f"Photo fetch failed: {exc}") from exc

    rel_path = str(photo.get("path") or "").strip()
    if rel_path:
        local_path = (UPLOAD_DIR / rel_path).resolve()
        upload_root = UPLOAD_DIR.resolve()
        if upload_root not in local_path.parents and local_path != upload_root:
            raise HTTPException(status_code=400, detail="Invalid photo path")
        if not local_path.exists() or not local_path.is_file():
            raise HTTPException(status_code=404, detail="Photo file not found")
        return FileResponse(local_path, media_type=media_type)

    raise HTTPException(status_code=404, detail="Photo source not found")


# アルバムからの写真削除（管理者のみ）
@app.delete("/api/extra/albums/{album_id}/photos/{photo_id}")
async def delete_album_photo(
    album_id: int,
    photo_id: int,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, str]:
    require_admin_device(x_device_id)
    
    # アルバムデータを読み込み、該当するアルバムを検出
    albums = load_json_data("albums")
    index, album = find_item(albums, album_id)
    
    # 該当する写真を検出
    photos = album.get("photos") or []
    photo_to_delete = next((p for p in photos if p.get("id") == photo_id), None)
    
    if not photo_to_delete:
        raise HTTPException(status_code=404, detail="Photo not found")
    
    # Cloud Storage から削除
    if storage_enabled() and photo_to_delete.get("object_name"):
        try:
            bucket = get_storage_bucket()
            blob = bucket.blob(photo_to_delete["object_name"])
            blob.delete()
        except Exception:
            logger.exception("Album photo deletion from GCS failed")
            # ログには記録するが、エラーは出さない（JSONは更新する）
    
    # ローカルストレージから削除
    if photo_to_delete.get("path"):
        try:
            photo_path = UPLOAD_DIR / photo_to_delete["path"]
            photo_path.unlink()
        except Exception:
            logger.exception("Album photo deletion from local storage failed")
    
    # photos 配列から削除
    album["photos"] = [p for p in photos if p.get("id") != photo_id]
    album["updated_at"] = datetime.now().isoformat()
    
    # 保存
    albums[index] = album
    save_json_data("albums", albums)
    
    return {"message": "Photo deleted"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
