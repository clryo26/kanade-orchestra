from __future__ import annotations

from datetime import datetime
from typing import Any
from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, Response

from ..core.auth_dependencies import get_sheet_manager_device_auth, get_system_admin_device_auth
from ..core.runtime_paths import UPLOAD_DIR
from ..drive_storage import get_storage_bucket, storage_enabled
from ..models.schemas import SheetBulkPartUpdateRequest, SheetDeleteRequest, SheetPartUpdateRequest
from ..services.blob_streaming_service import stream_storage_blob
from ..services import sheet_service
from ..services.file_service import ensure_pdf_file, safe_upload_name, save_upload_to_path
from ..services.sheet_asset_service import local_sheet_path

router = APIRouter()

PDF_EDITOR_PREFIX = "pdf-editor"
PDF_EDITOR_LOCAL_DIR = UPLOAD_DIR / PDF_EDITOR_PREFIX


def _sort_pdf_editor_files(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(items, key=lambda item: str(item.get("modified_at") or ""), reverse=True)


def _list_pdf_editor_files() -> list[dict[str, Any]]:
    if storage_enabled():
        items: list[dict[str, Any]] = []
        for blob in get_storage_bucket().list_blobs(prefix=f"{PDF_EDITOR_PREFIX}/"):
            name = str(blob.name or "").rsplit("/", 1)[-1]
            if not name or not name.lower().endswith(".pdf"):
                continue
            items.append(
                {
                    "id": blob.name,
                    "name": name,
                    "size": int(blob.size or 0),
                    "mime_type": blob.content_type or "application/pdf",
                    "modified_at": blob.updated.isoformat() if blob.updated else "",
                    "source": "google_cloud_storage",
                    "object_name": blob.name,
                }
            )
        return _sort_pdf_editor_files(items)

    if not PDF_EDITOR_LOCAL_DIR.exists():
        return []

    items = []
    for path in PDF_EDITOR_LOCAL_DIR.rglob("*.pdf"):
        if not path.is_file():
            continue
        stat = path.stat()
        items.append(
            {
                "id": path.relative_to(UPLOAD_DIR).as_posix(),
                "name": path.name,
                "size": int(stat.st_size),
                "mime_type": "application/pdf",
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "source": "local",
                "path": path.relative_to(UPLOAD_DIR).as_posix(),
            }
        )
    return _sort_pdf_editor_files(items)


def _upload_pdf_editor_file(file: UploadFile) -> dict[str, Any]:
    ensure_pdf_file(file)
    upload_id = uuid4().hex
    safe_name = safe_upload_name(file.filename or "document.pdf")

    if storage_enabled():
        object_name = f"{PDF_EDITOR_PREFIX}/{upload_id}/{safe_name}"
        blob = get_storage_bucket().blob(object_name)
        blob.upload_from_file(file.file, content_type="application/pdf", rewind=True)
        blob.reload()
        return {
            "id": object_name,
            "name": safe_name,
            "size": int(blob.size or 0),
            "mime_type": blob.content_type or "application/pdf",
            "modified_at": blob.updated.isoformat() if blob.updated else "",
            "source": "google_cloud_storage",
            "object_name": object_name,
        }

    local_path = save_upload_to_path(file, PDF_EDITOR_LOCAL_DIR / upload_id)
    stat = local_path.stat()
    return {
        "id": local_path.relative_to(UPLOAD_DIR).as_posix(),
        "name": local_path.name,
        "size": int(stat.st_size),
        "mime_type": "application/pdf",
        "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        "source": "local",
        "path": local_path.relative_to(UPLOAD_DIR).as_posix(),
    }


@router.get("/api/system/pdf-editor/files")
async def list_pdf_editor_files(
    _system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, list[dict[str, Any]]]:
    return {"files": _list_pdf_editor_files()}


@router.post("/api/system/pdf-editor/files")
async def upload_pdf_editor_file(
    file: UploadFile = File(...),
    _system_admin_device: dict[str, Any] = Depends(get_system_admin_device_auth),
) -> dict[str, dict[str, Any]]:
    return {"file": _upload_pdf_editor_file(file)}


@router.get("/api/sheets")
async def get_sheets() -> dict[str, list[dict[str, Any]]]:
    return sheet_service.get_sheets_payload()


@router.get("/api/sheets/download/{path:path}")
async def download_local_sheet(path: str) -> FileResponse:
    requested = local_sheet_path(path)
    return FileResponse(requested, media_type="application/pdf", filename=requested.name)


@router.get("/api/sheets/view/{path:path}")
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


@router.get("/api/sheets/cloud/download/{object_name:path}")
async def download_cloud_sheet(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=True, request=request)


@router.get("/api/sheets/cloud/view/{object_name:path}")
async def view_cloud_sheet(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=False, request=request)


@router.get("/api/sheets/download-zip")
async def download_sheets_zip(performance_id: str = "", piece: str = "", part: str = "") -> Response:
    return sheet_service.download_sheets_zip(performance_id, piece, part)


@router.post("/api/sheets/upload")
async def upload_sheet(
    file: UploadFile = File(...),
    performance_id: str = Form(""),
    performance_title: str = Form(""),
    piece: str = Form(""),
    _sheet_manager: dict[str, Any] = Depends(get_sheet_manager_device_auth),
) -> dict[str, Any]:
    return sheet_service.upload_sheet_file(file, performance_id, performance_title, piece)


@router.put("/api/sheets/{sheet_id}/part")
async def update_sheet_part(
    sheet_id: int,
    payload: SheetPartUpdateRequest,
    _sheet_manager: dict[str, Any] = Depends(get_sheet_manager_device_auth),
) -> dict[str, Any]:
    return sheet_service.update_sheet_part(sheet_id, payload.part)


@router.put("/api/sheets/parts")
async def update_sheets_parts(
    payload: SheetBulkPartUpdateRequest,
    _sheet_manager: dict[str, Any] = Depends(get_sheet_manager_device_auth),
) -> dict[str, Any]:
    return sheet_service.update_sheets_parts(payload.sheet_ids, payload.part)


@router.delete("/api/sheets")
async def delete_sheets(
    payload: SheetDeleteRequest,
    _sheet_manager: dict[str, Any] = Depends(get_sheet_manager_device_auth),
) -> dict[str, Any]:
    return sheet_service.delete_sheets(payload.performance_id, payload.piece, payload.sheet_id)


