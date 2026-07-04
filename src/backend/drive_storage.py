from __future__ import annotations

import json
import logging
import mimetypes
import os
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from google.cloud import storage
    from google.oauth2 import service_account
except Exception:  # pragma: no cover - optional in local tests without GCS.
    storage = None
    service_account = None


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
logger = logging.getLogger(__name__)


# 接続設定はまず JSON 管理の connection_settings を参照し、
# 未設定時だけ従来の環境変数へフォールバックする。
# これにより UI から接続先を変更しても既存運用との互換性を保てる。

def _connection_settings_path() -> Path:
    # 接続先設定 JSON の保存場所を返す。
    return DATA_DIR / "connection_settings.json"


def _connection_setting_record() -> dict[str, Any]:
    # 設定 UI は単一レコード運用のため、先頭要素だけを有効設定として読む。
    path = _connection_settings_path()
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as file:
            loaded = json.load(file)
        if isinstance(loaded, list) and loaded:
            first = loaded[0]
            return first if isinstance(first, dict) else {}
    except Exception:
        return {}
    return {}


def _is_placeholder_like(value: str) -> bool:
    normalized = str(value or "").strip()
    if not normalized:
        return True
    return normalized in {"your_bucket_name_here", "あなたのGCSバケット名"}


_ENV_FALLBACK_ON_EMPTY_KEYS = {
    "google_project_id",
    "google_cloud_storage_bucket",
    "google_cloud_storage_data_prefix",
    "google_cloud_storage_public",
}


def _setting_value(json_key: str, env_key: str, default: str = "") -> str:
    # 文字列設定値を JSON 優先で取得する。
    record = _connection_setting_record()
    # JSON 側にキーがある場合はその値を優先し、
    # テンプレ値だけ環境変数へフォールバックする。
    if json_key in record:
        json_value = str(record.get(json_key) or "").strip()
        if not json_value and json_key in _ENV_FALLBACK_ON_EMPTY_KEYS:
            return os.getenv(env_key, default).strip()
        if _is_placeholder_like(json_value) and json_value:
            return os.getenv(env_key, default).strip()
        return json_value
    return os.getenv(env_key, default).strip()


def _setting_bool(json_key: str, env_key: str, default: bool = False) -> bool:
    # 真偽値設定を JSON 優先で取得する。
    record = _connection_setting_record()
    if json_key in record:
        return str(record.get(json_key) or "").strip().lower() in {"1", "true", "yes", "on"}
    return os.getenv(env_key, "true" if default else "false").strip().lower() in {"1", "true", "yes", "on"}


def storage_bucket_name() -> str:
    # 利用中の Storage バケット名を返す。
    return _setting_value("google_cloud_storage_bucket", "GOOGLE_CLOUD_STORAGE_BUCKET")


def get_storage_client() -> storage.Client:
    # サービスアカウント JSON 文字列 -> ファイルパス -> 既定認証の順で接続する。
    if storage is None or service_account is None:
        raise RuntimeError("google-cloud-storage is not installed")
    # 管理画面で JSON を直接持たせる運用を最優先にしている。
    service_account_json = _setting_value("google_service_account_json", "GOOGLE_SERVICE_ACCOUNT_JSON")
    service_account_file = _setting_value("google_service_account_file", "GOOGLE_SERVICE_ACCOUNT_FILE")
    project_id = _setting_value("google_project_id", "GOOGLE_CLOUD_PROJECT")

    if service_account_json:
        info = json.loads(service_account_json)
        credentials = service_account.Credentials.from_service_account_info(info)
        return storage.Client(
            project=info.get("project_id"),
            credentials=credentials,
        )

    if service_account_file:
        return storage.Client.from_service_account_json(service_account_file)

    if project_id:
        return storage.Client(project=project_id)
    return storage.Client()


def storage_enabled() -> bool:
    # バケット名の未設定や、指定された秘密鍵ファイルの不存在をここで早期検知する。
    # ローカルテスト環境では google-cloud-storage が未インストールでも、
    # 設定値の有効性だけを判定できるようにする。実接続時のライブラリ不足は
    # get_storage_client() 側で RuntimeError として扱う。
    bucket_name = storage_bucket_name()
    if not bucket_name or bucket_name in {"your_bucket_name_here", "あなたのGCSバケット名"}:
        return False

    service_account_file = _setting_value("google_service_account_file", "GOOGLE_SERVICE_ACCOUNT_FILE")
    if service_account_file and not Path(service_account_file).expanduser().exists():
        return False

    return True


def get_storage_bucket() -> storage.Bucket:
    # 設定済みバケットオブジェクトを返す。
    bucket_name = storage_bucket_name()
    if not bucket_name:
        raise RuntimeError("GOOGLE_CLOUD_STORAGE_BUCKET is not set")
    return get_storage_client().bucket(bucket_name)


def public_url(bucket_name: str, object_name: str) -> str:
    # 公開 URL の標準形式を組み立てる。
    return f"https://storage.googleapis.com/{bucket_name}/{object_name}"


def data_object_name(name: str) -> str:
    # 各 JSON コレクションは Cloud Storage 上でもローカルと同じ論理名で扱う。
    prefix = _setting_value("google_cloud_storage_data_prefix", "GOOGLE_CLOUD_STORAGE_DATA_PREFIX", "app-data").strip("/")
    filename = f"{name}.json"
    return f"{prefix}/{filename}" if prefix else filename


def _legacy_data_object_name(name: str) -> str:
    return f"{name}.json"


def storage_debug_info() -> dict[str, str]:
    # 実際にどの設定で Storage を見に行っているかをログ出力するための診断情報。
    return {
        "bucket": storage_bucket_name(),
        "project_id": _setting_value("google_project_id", "GOOGLE_CLOUD_PROJECT"),
        "prefix": _setting_value("google_cloud_storage_data_prefix", "GOOGLE_CLOUD_STORAGE_DATA_PREFIX", "app-data").strip("/"),
        "public": str(_setting_bool("google_cloud_storage_public", "GOOGLE_CLOUD_STORAGE_PUBLIC", False)).lower(),
        "service_account_file": _setting_value("google_service_account_file", "GOOGLE_SERVICE_ACCOUNT_FILE"),
        "service_account_json": "set" if _setting_value("google_service_account_json", "GOOGLE_SERVICE_ACCOUNT_JSON") else "",
    }


def candidate_data_object_names(name: str) -> list[str]:
    # 旧配置との互換のため、複数のprefix候補を順番に試す。
    filename = f"{name}.json"
    prefix = _setting_value("google_cloud_storage_data_prefix", "GOOGLE_CLOUD_STORAGE_DATA_PREFIX", "app-data").strip("/")
    candidates = [f"{prefix}/{filename}" if prefix else filename, f"data/{filename}", filename]
    seen: set[str] = set()
    ordered: list[str] = []
    for item in candidates:
        if item and item not in seen:
            seen.add(item)
            ordered.append(item)
    return ordered


def load_json_from_storage(name: str) -> list[dict[str, Any]] | None:
    # Cloud Storage 上の JSON コレクションを読み込む。
    # 未存在の場合は None を返し、呼び出し側でフォールバック判断させる。
    bucket = get_storage_bucket()
    for object_name in candidate_data_object_names(name):
        blob = bucket.blob(object_name)
        if not blob.exists():
            continue
        logger.info("load_json_from_storage(%s): using %s", name, object_name)
        loaded = json.loads(blob.download_as_text(encoding="utf-8"))
        return loaded if isinstance(loaded, list) else []
    logger.info("load_json_from_storage(%s): not found in any candidate object", name)
    return None


def save_json_to_storage(name: str, data: list[dict[str, Any]]) -> None:
    # JSON コレクションを Cloud Storage に保存する。
    blob = get_storage_bucket().blob(data_object_name(name))
    blob.upload_from_string(
        json.dumps(data, ensure_ascii=False, indent=2),
        content_type="application/json; charset=utf-8",
    )


def delete_json_from_storage(name: str) -> list[str]:
    # 移行完了後に Cloud Storage 上の JSON コレクションを削除する。
    bucket = get_storage_bucket()
    deleted: list[str] = []
    for object_name in candidate_data_object_names(name):
        blob = bucket.blob(object_name)
        if blob.exists():
            blob.delete()
            deleted.append(object_name)
    return deleted


def upload_file_to_drive(local_path: str | Path, practice_date: str, song_name: str) -> dict[str, Any]:
    # 録音アップロード時は保存完了後すぐに一覧表示できるよう、
    # フロントがそのまま使えるメタデータ形式で返す。
    bucket_name = storage_bucket_name()
    if not bucket_name:
        raise RuntimeError("GOOGLE_CLOUD_STORAGE_BUCKET is not set")

    file_path = Path(local_path)
    object_name = "/".join(
        segment.strip("/")
        for segment in (practice_date, song_name, file_path.name)
        if segment.strip("/")
    )
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"

    bucket = get_storage_bucket()
    blob = bucket.blob(object_name)
    blob.upload_from_filename(str(file_path), content_type=content_type)

    if _setting_bool("google_cloud_storage_public", "GOOGLE_CLOUD_STORAGE_PUBLIC", False):
        blob.make_public()

    blob.reload()

    url = blob.public_url if blob.public_url else public_url(bucket_name, object_name)
    return {
        "id": object_name,
        "name": file_path.name,
        "date": practice_date,
        "piece": song_name,
        "size": blob.size or file_path.stat().st_size,
        "mime_type": blob.content_type or content_type,
        "modified_at": blob.updated.isoformat() if blob.updated else datetime.now().isoformat(),
        "bucket": bucket_name,
        "object_name": object_name,
        "web_view_link": url,
        "download_url": url,
        "view_url": url,
        "source": "google_cloud_storage",
    }
