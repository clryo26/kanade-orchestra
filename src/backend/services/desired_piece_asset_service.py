from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import cast
from urllib.parse import quote

from fastapi import HTTPException, UploadFile
from fastapi.responses import Response

from ..core.runtime_paths import DRIVE_STAGING_DIR, UPLOAD_DIR
from ..drive_storage import get_storage_bucket, storage_enabled
from .file_service import ensure_pdf_file, safe_upload_name, save_upload_to_path
from .storage_service import load_json_data
from ..utils.collection_utils import find_item

logger = logging.getLogger(__name__)

REFERENCE_SCORE_ROUTE_PREFIX = "/api/extra/desired_pieces"
REFERENCE_SCORE_STORAGE_PREFIX = "desired_piece_reference_scores"


def reference_score_route(piece_id: int) -> str:
    return f"{REFERENCE_SCORE_ROUTE_PREFIX}/{piece_id}/reference_score"


def _local_reference_score_dir(piece_id: int) -> Path:
    return UPLOAD_DIR / REFERENCE_SCORE_STORAGE_PREFIX / str(piece_id)


def _staging_reference_score_dir(piece_id: int) -> Path:
    return DRIVE_STAGING_DIR / REFERENCE_SCORE_STORAGE_PREFIX / str(piece_id)


def _reference_score_object_prefix(piece_id: int) -> str:
    return f"{REFERENCE_SCORE_STORAGE_PREFIX}/{piece_id}"


def _unique_pdf_name(filename: str) -> str:
    base = safe_upload_name(filename or "reference_score.pdf")
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    return f"{timestamp}_{base}"


def _latest_local_reference_score_path(piece_id: int) -> Path | None:
    directory = _local_reference_score_dir(piece_id)
    if not directory.exists():
        return None
    pdf_files = [path for path in directory.iterdir() if path.is_file() and path.suffix.lower() == ".pdf"]
    if not pdf_files:
        return None
    return max(pdf_files, key=lambda path: (path.stat().st_mtime, path.name))


def _latest_cloud_reference_score_blob(piece_id: int):
    if not storage_enabled():
        return None
    prefix = f"{_reference_score_object_prefix(piece_id)}/"
    bucket = get_storage_bucket()
    blobs = list(bucket.list_blobs(prefix=prefix))
    if not blobs:
        return None
    return max(
        blobs,
        key=lambda blob: (
            getattr(blob, "updated", None) or getattr(blob, "time_created", None) or datetime.min,
            getattr(blob, "generation", 0) or 0,
            getattr(blob, "name", ""),
        ),
    )


def upload_reference_score_file(file: UploadFile, piece_id: int) -> str:
    ensure_pdf_file(file)
    stored_name = _unique_pdf_name(file.filename or "reference_score.pdf")

    if storage_enabled():
        staging_dir = _staging_reference_score_dir(piece_id)
        staging_dir.mkdir(parents=True, exist_ok=True)
        staged_path = save_upload_to_path(file, staging_dir)
        staged_target = staged_path.with_name(stored_name)
        if staged_target != staged_path:
            staged_path.rename(staged_target)
        object_name = f"{_reference_score_object_prefix(piece_id)}/{stored_name}"
        try:
            bucket = get_storage_bucket()
            bucket.blob(object_name).upload_from_filename(str(staged_target), content_type="application/pdf")
        except Exception as exc:
            logger.exception("Desired piece reference score upload to GCS failed")
            if staged_target.exists():
                staged_target.unlink(missing_ok=True)
            raise HTTPException(status_code=502, detail=f"参考スコアPDFのアップロードに失敗しました: {exc}") from exc
        finally:
            if staged_target.exists():
                staged_target.unlink(missing_ok=True)
        return stored_name

    local_dir = _local_reference_score_dir(piece_id)
    local_dir.mkdir(parents=True, exist_ok=True)
    staged_path = save_upload_to_path(file, local_dir)
    target_path = staged_path.with_name(stored_name)
    if target_path != staged_path:
        staged_path.rename(target_path)
    return stored_name


def delete_reference_score_file(piece_id: int, stored_name: str) -> None:
    if not stored_name:
        return

    if storage_enabled():
        object_name = f"{_reference_score_object_prefix(piece_id)}/{stored_name}"
        try:
            blob = get_storage_bucket().blob(object_name)
            if blob.exists():
                blob.delete()
        except Exception:
            logger.exception("Desired piece reference score deletion from GCS failed")
        return

    path = _local_reference_score_dir(piece_id) / stored_name
    try:
        if path.exists():
            path.unlink()
    except Exception:
        logger.exception("Desired piece reference score deletion from local storage failed")


def delete_reference_score_files(piece_id: int) -> None:
    if storage_enabled():
        prefix = f"{_reference_score_object_prefix(piece_id)}/"
        try:
            bucket = get_storage_bucket()
            for blob in bucket.list_blobs(prefix=prefix):
                blob.delete()
        except Exception:
            logger.exception("Desired piece reference score directory cleanup from GCS failed")
        return

    directory = _local_reference_score_dir(piece_id)
    if not directory.exists():
        return
    for path in directory.iterdir():
        if path.is_file() and path.suffix.lower() == ".pdf":
            try:
                path.unlink()
            except Exception:
                logger.exception("Desired piece reference score cleanup from local storage failed")


def trim_reference_score_files(piece_id: int, keep_stored_name: str) -> None:
    if not keep_stored_name:
        delete_reference_score_files(piece_id)
        return

    if storage_enabled():
        prefix = f"{_reference_score_object_prefix(piece_id)}/"
        try:
            bucket = get_storage_bucket()
            for blob in bucket.list_blobs(prefix=prefix):
                if blob.name.rsplit("/", 1)[-1] != keep_stored_name:
                    blob.delete()
        except Exception:
            logger.exception("Desired piece reference score trim from GCS failed")
        return

    directory = _local_reference_score_dir(piece_id)
    if not directory.exists():
        return
    for path in directory.iterdir():
        if path.is_file() and path.suffix.lower() == ".pdf" and path.name != keep_stored_name:
            try:
                path.unlink()
            except Exception:
                logger.exception("Desired piece reference score trim from local storage failed")


def desired_piece_reference_score_response(piece_id: int) -> Response:
    items = load_json_data("desired_pieces")
    _, item = find_item(items, piece_id)
    if not item:
        raise HTTPException(status_code=404, detail="Desired piece not found")

    filename = ""
    content: bytes | None = None

    if storage_enabled():
        blob = _latest_cloud_reference_score_blob(piece_id)
        if not blob:
            raise HTTPException(status_code=404, detail="Reference score not found")
        filename = blob.name.rsplit("/", 1)[-1]
        try:
            content = cast(bytes, blob.download_as_bytes())
        except Exception as exc:
            logger.exception("Desired piece reference score fetch from GCS failed")
            raise HTTPException(status_code=502, detail=f"参考スコアPDFの取得に失敗しました: {exc}") from exc
    else:
        local_path = _latest_local_reference_score_path(piece_id)
        if not local_path:
            raise HTTPException(status_code=404, detail="Reference score not found")
        filename = local_path.name
        content = local_path.read_bytes()

    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(filename)}",
            "Cache-Control": "private, max-age=3600",
        },
    )
