from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from ..core.auth_dependencies import get_device_auth, get_sheet_manager_device_auth, get_system_admin_device_auth
from ..core.runtime_paths import UPLOAD_DIR
from ..drive_storage import get_storage_bucket, storage_enabled
from ..services import sheet_download_service as downloads
from ..services import sheet_library_service as library
from ..services import sheet_service
from ..services import sheet_zip_service as zips
from ..services.auth_service import device_auth_record
from ..services.extra_collection_helpers import read_json_body
from ..services.file_service import ensure_pdf_file, safe_upload_name, save_upload_to_path

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


def _result(status: int, body: dict[str, Any]) -> JSONResponse:
    headers = {"Cache-Control": "no-store"}
    if status == 202:
        headers["Retry-After"] = "2"
    return JSONResponse(body, status_code=status, headers=headers)


def _no_store(body: dict[str, Any]) -> JSONResponse:
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


def _reader_device(request: Request) -> dict[str, Any] | Response:
    """File routes are opened by fetch (with the device header). A navigation
    without it (a link on a screen loaded before this release) gets a page
    with the way back instead of a bare error in a home-screen app."""
    device_id = request.headers.get("X-Device-Id", "")
    if not device_id:
        return downloads.guidance_page(
            401, "この画面は古いため、楽譜を開けませんでした。ポータルに戻り、画面を再読み込みしてからもう一度お試しください。")
    try:
        return device_auth_record(device_id)
    except HTTPException as exc:
        if "text/html" in request.headers.get("accept", ""):
            return downloads.guidance_page(exc.status_code, "ログインの状態を確認できません。ポータルに戻ってログインしてください。")
        raise


@router.get("/api/sheets")
def get_sheets(_device: dict[str, Any] = Depends(get_device_auth)) -> JSONResponse:
    # These handlers use synchronous DB/GCS clients. FastAPI runs `def`
    # handlers in its worker pool, preserving the request's tenant context.
    return _no_store(library.list_payload())


@router.get("/api/sheets/version")
def get_sheets_version(_device: dict[str, Any] = Depends(get_device_auth)) -> JSONResponse:
    # Lightweight update check (polled about every 5 s while the library is shown).
    return _no_store(library.version_payload())


def _file_response(request: Request, source: str, name: str, download: bool) -> Response:
    device = _reader_device(request)
    if isinstance(device, Response):
        return device
    # Only an object that is a published sheet of this organization.
    return downloads.sheet_response(library.file_for_object(source, name), download)


@router.get("/api/sheets/download/{path:path}")
def download_local_sheet(path: str, request: Request) -> Response:
    return _file_response(request, "local", path, True)


@router.get("/api/sheets/view/{path:path}")
def view_local_sheet(path: str, request: Request) -> Response:
    return _file_response(request, "local", path, False)


@router.get("/api/sheets/cloud/download/{object_name:path}")
def download_cloud_sheet(object_name: str, request: Request) -> Response:
    return _file_response(request, "google_cloud_storage", object_name, True)


@router.get("/api/sheets/cloud/view/{object_name:path}")
def view_cloud_sheet(object_name: str, request: Request) -> Response:
    return _file_response(request, "google_cloud_storage", object_name, False)


@router.get("/api/sheets/download-zip")
def download_sheets_zip(request: Request, performance_id: str = "", piece: str = "", part: str = "") -> Response:
    # Kept for screens loaded before the ZIP jobs; refuses incomplete content.
    device = _reader_device(request)
    if isinstance(device, Response):
        return device
    return sheet_service.download_sheets_zip(performance_id, piece, part)


@router.get("/api/sheets/operations/{operation_id}")
def get_sheet_operation(
    operation_id: str,
    device: dict[str, Any] = Depends(get_sheet_manager_device_auth),
) -> JSONResponse:
    return _result(*library.operation_status(device, operation_id))


@router.post("/api/sheets/upload")
async def upload_sheet(
    file: UploadFile = File(...),
    performance_id: str = Form(""),
    performance_title: str = Form(""),
    piece: str = Form(""),
    operation_id: str = Form(""),
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    device: dict[str, Any] = Depends(get_sheet_manager_device_auth),
) -> JSONResponse:
    fields = {"performance_id": performance_id, "performance_title": performance_title, "piece": piece}
    return _result(*await library.upload(file, fields, device, idempotency_key or operation_id or None))


@router.put("/api/sheets/{sheet_id}/part")
async def update_sheet_part(
    sheet_id: int,
    request: Request,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    device: dict[str, Any] = Depends(get_sheet_manager_device_auth),
) -> JSONResponse:
    raw = await read_json_body(request)
    if "expected_revision" not in raw:
        raise HTTPException(428, detail=library.RELOAD_MESSAGE)
    body = {"part": raw.get("part"), "items": [{"id": sheet_id, "expected_revision": raw.get("expected_revision")}]}
    return _result(*await run_in_threadpool(library.set_parts, body, device, idempotency_key or raw.get("operation_id"), kind="part"))


@router.put("/api/sheets/parts")
async def update_sheets_parts(
    request: Request,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    device: dict[str, Any] = Depends(get_sheet_manager_device_auth),
) -> JSONResponse:
    raw = await read_json_body(request)
    return _result(*await run_in_threadpool(library.set_parts, raw, device, idempotency_key or raw.get("operation_id"), kind="bulk_part"))


@router.delete("/api/sheets")
async def delete_sheets(
    request: Request,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    device: dict[str, Any] = Depends(get_sheet_manager_device_auth),
) -> JSONResponse:
    # Old screens send a performance/piece scope; deleting by scope could
    # remove sheets registered meanwhile on another device, so only the
    # listed IDs with the revisions the user saw are accepted.
    raw = await read_json_body(request)
    return _result(*await run_in_threadpool(library.delete, raw, device, idempotency_key or raw.get("operation_id")))


@router.post("/api/sheets/tickets")
async def create_sheet_ticket(request: Request, device: dict[str, Any] = Depends(get_device_auth)) -> JSONResponse:
    raw = await read_json_body(request)
    return _no_store(await run_in_threadpool(downloads.create_ticket, device, str(raw.get("kind") or ""), str(raw.get("id") or "")))


@router.get("/api/sheets/tickets/{token}")
def open_sheet_ticket(token: str) -> Response:
    return downloads.ticket_response(token, device_auth_record)


@router.post("/api/sheets/zip-jobs")
async def create_sheet_zip_job(request: Request, device: dict[str, Any] = Depends(get_device_auth)) -> JSONResponse:
    raw = await read_json_body(request)
    return _no_store(await run_in_threadpool(zips.create, device, raw))


@router.get("/api/sheets/zip-jobs/{job_id}")
def get_sheet_zip_job(job_id: str, device: dict[str, Any] = Depends(get_device_auth)) -> JSONResponse:
    return _no_store(zips.status(device, job_id))


@router.post("/api/sheets/zip-jobs/{job_id}/step")
def step_sheet_zip_job(job_id: str, device: dict[str, Any] = Depends(get_device_auth)) -> JSONResponse:
    return _no_store(zips.step(device, job_id))


@router.post("/api/sheets/zip-jobs/{job_id}/cancel")
def cancel_sheet_zip_job(job_id: str, device: dict[str, Any] = Depends(get_device_auth)) -> JSONResponse:
    return _no_store(zips.cancel(device, job_id))


@router.get("/api/sheets/zip-jobs/{job_id}/download")
def download_sheet_zip_job(job_id: str, device: dict[str, Any] = Depends(get_device_auth)) -> Response:
    return downloads.zip_response(zips.owned_ready_job(device, job_id))
