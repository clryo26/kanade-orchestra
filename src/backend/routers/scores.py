from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, File, Form, Header, Request, UploadFile
from fastapi.responses import FileResponse, Response

from ..models.schemas import SheetBulkPartUpdateRequest, SheetDeleteRequest, SheetPartUpdateRequest
from ..services.auth_service import require_sheet_manager_device
from ..services.blob_streaming_service import stream_storage_blob
from ..services import sheet_service
from ..services.sheet_asset_service import local_sheet_path

router = APIRouter()

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
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    return sheet_service.upload_sheet_file(file, performance_id, performance_title, piece)


@router.put("/api/sheets/{sheet_id}/part")
async def update_sheet_part(sheet_id: int, payload: SheetPartUpdateRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    return sheet_service.update_sheet_part(sheet_id, payload.part)


@router.put("/api/sheets/parts")
async def update_sheets_parts(payload: SheetBulkPartUpdateRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    return sheet_service.update_sheets_parts(payload.sheet_ids, payload.part)


@router.delete("/api/sheets")
async def delete_sheets(payload: SheetDeleteRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    return sheet_service.delete_sheets(payload.performance_id, payload.piece, payload.sheet_id)


