from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import os
import re
import shutil
import io
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime
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
JSON_DATA_NAMES = ("performances", "schedules", "announcements", "drive_files", "events", "members", "absences", "event_responses", "date_adjustments", "date_adjustment_responses", "sheet_library", "payments", "castings", "piece_infos", "practice_instructions", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "auth_devices", "recording_metadata", "desired_pieces", "promotions")

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


# ===== JSON データ入出力 =====
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
    for name in JSON_DATA_NAMES:
        logger.info("Startup preload begin: %s", name)
        try:
            loaded = load_json_data(name)  # キャッシュに読み込み
            logger.info("Startup preload done: %s (%s items)", name, len(loaded))
        except HTTPException as exc:
            logger.exception("Startup preload failed: %s (%s)", name, exc)
    
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


def compact_member_name(value: Any) -> str:
    # ログイン名比較用に空白差・大文字小文字差を吸収する。
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
    # インデックスを優先し、無ければ線形探索する。
    normalized = compact_member_name(name)
    if not normalized:
        raise HTTPException(status_code=400, detail="name is required")
    
    # インデックスを使用して高速検索
    index_map = _memory_cache.get_index("members", "member_login")
    if index_map and normalized in index_map:
        index, item = index_map[normalized]
        if part and part != member_part(item):
            # パートが指定されている場合はチェック
            pass
        else:
            return index, item
    
    # インデックスが無い場合は線形検索
    for index, item in enumerate(items):
        if normalized in member_login_names(item):
            if part and part != member_part(item):
                continue
            return index, item
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
        if login.password != member_password:
            raise HTTPException(status_code=401, detail="Invalid member password")

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
    member["password"] = password
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


# ===== 初期描画用 bootstrap API =====
# 初期描画に必要な最小データを返す軽量 bootstrap API。
@app.get("/api/bootstrap-lite", response_model=None)
async def get_bootstrap_lite_data(request: Request) -> dict[str, Any] | Response:
    """初期表示に必要な最小限のデータだけを返す。"""
    cached_etag = _memory_cache.etag("performances")
    
    # ETagチェック
    if cached_etag:
        if_none_match = request.headers.get("if-none-match", "")
        if if_none_match == cached_etag:
            return Response(status_code=304, headers={"ETag": cached_etag})
    
    extra_names = ("payments", "part_settings", "org_settings", "sns_settings", "connection_settings")
    extras = {name: load_json_data(name) for name in extra_names}
    data = {
        "performances": load_json_data("performances"),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "members": load_json_data("members"),
        "extras": extras,
    }
    
    # レスポンスにETagを追加
    if cached_etag:
        return Response(
            content=json.dumps(data, ensure_ascii=False),
            media_type="application/json",
            headers={"ETag": cached_etag}
        )
    return data


# 録音/楽譜の重い走査を除いた通常 bootstrap API。
@app.get("/api/bootstrap-core", response_model=None)
async def get_bootstrap_core_data(request: Request) -> dict[str, Any] | Response:
    """録音・楽譜一覧のファイル走査を除いた通常データ。"""
    cached_etag = _memory_cache.etag("performances")
    
    if cached_etag:
        if_none_match = request.headers.get("if-none-match", "")
        if if_none_match == cached_etag:
            return Response(status_code=304, headers={"ETag": cached_etag})
    
    extra_names = ("absences", "event_responses", "date_adjustments", "date_adjustment_responses", "payments", "castings", "piece_infos", "practice_instructions", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "desired_pieces", "promotions")
    extras = {name: load_json_data(name) for name in extra_names}
    data = {
        "performances": load_json_data("performances"),
        "schedules": load_json_data("schedules"),
        "announcements": load_json_data("announcements"),
        "events": load_json_data("events"),
        "members": load_json_data("members"),
        "extras": extras,
        "auth_devices": await get_auth_devices(),
    }
    
    if cached_etag:
        return Response(
            content=json.dumps(data, ensure_ascii=False),
            media_type="application/json",
            headers={"ETag": cached_etag}
        )
    return data


# 画面に必要なデータを包括的に返すフル bootstrap API。
@app.get("/api/bootstrap", response_model=None)
async def get_bootstrap_data(request: Request) -> dict[str, Any] | Response:
    cached_etag = _memory_cache.etag("performances")
    
    if cached_etag:
        if_none_match = request.headers.get("if-none-match", "")
        if if_none_match == cached_etag:
            return Response(status_code=304, headers={"ETag": cached_etag})
    
    extra_names = ("absences", "event_responses", "date_adjustments", "date_adjustment_responses", "sheet_library", "payments", "castings", "piece_infos", "practice_instructions", "albums", "part_settings", "venue_settings", "org_settings", "sns_settings", "connection_settings", "desired_pieces", "promotions")
    extras = {name: load_json_data(name) for name in extra_names}
    data = {
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
    
    if cached_etag:
        return Response(
            content=json.dumps(data, ensure_ascii=False),
            media_type="application/json",
            headers={"ETag": cached_etag}
        )
    return data


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
    items = load_json_data("drive_files")
    items = [existing for existing in items if existing.get("id") != item.get("id")]
    items.insert(0, item)
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
    return load_json_data("members")


# 団員を新規作成する。
@app.post("/api/members", response_model=Member)
async def create_member(member: Member, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
    items = load_json_data("members")
    now = datetime.now().isoformat()
    payload = model_dump(member)
    payload["name"] = member_display_name(payload)
    payload.update({"id": next_id(items), "created_at": now, "updated_at": now})
    items.append(payload)
    save_json_data("members", items)
    return payload


# 指定 ID の団員情報を更新する。
@app.put("/api/members/{member_id}", response_model=Member)
async def update_member(member_id: int, member: Member, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_admin_device(x_device_id)
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
    # フロントではこの並びをそのまま一覧表示に利用する。
    drive_files = [cloud_recording_metadata(item) for item in load_json_data("drive_files")]
    local_paths = sorted(
        [*CONVERTED_DIR.rglob("*.mp3"), *CONVERTED_DIR.rglob("*.m4a")],
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    local_files = [
        local_recording_metadata(path)
        for path in local_paths
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
    "piece_infos",
    "practice_instructions",
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
