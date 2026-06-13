from __future__ import annotations

import json
import mimetypes
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from google.cloud import storage
from google.oauth2 import service_account


def storage_bucket_name() -> str:
    return os.getenv("GOOGLE_CLOUD_STORAGE_BUCKET", "").strip()


def get_storage_client() -> storage.Client:
    service_account_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    service_account_file = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip()

    if service_account_json:
        info = json.loads(service_account_json)
        credentials = service_account.Credentials.from_service_account_info(info)
        return storage.Client(
            project=info.get("project_id"),
            credentials=credentials,
        )

    if service_account_file:
        return storage.Client.from_service_account_json(service_account_file)

    return storage.Client()


def storage_enabled() -> bool:
    return bool(storage_bucket_name())


def get_storage_bucket() -> storage.Bucket:
    bucket_name = storage_bucket_name()
    if not bucket_name:
        raise RuntimeError("GOOGLE_CLOUD_STORAGE_BUCKET is not set")
    return get_storage_client().bucket(bucket_name)


def public_url(bucket_name: str, object_name: str) -> str:
    return f"https://storage.googleapis.com/{bucket_name}/{object_name}"


def data_object_name(name: str) -> str:
    prefix = os.getenv("GOOGLE_CLOUD_STORAGE_DATA_PREFIX", "app-data").strip().strip("/")
    filename = f"{name}.json"
    return f"{prefix}/{filename}" if prefix else filename


def load_json_from_storage(name: str) -> list[dict[str, Any]] | None:
    blob = get_storage_bucket().blob(data_object_name(name))
    if not blob.exists():
        return None

    loaded = json.loads(blob.download_as_text(encoding="utf-8"))
    return loaded if isinstance(loaded, list) else []


def save_json_to_storage(name: str, data: list[dict[str, Any]]) -> None:
    blob = get_storage_bucket().blob(data_object_name(name))
    blob.upload_from_string(
        json.dumps(data, ensure_ascii=False, indent=2),
        content_type="application/json; charset=utf-8",
    )


def upload_file_to_drive(local_path: str | Path, practice_date: str, song_name: str) -> dict[str, Any]:
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

    if os.getenv("GOOGLE_CLOUD_STORAGE_PUBLIC", "false").strip().lower() == "true":
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
