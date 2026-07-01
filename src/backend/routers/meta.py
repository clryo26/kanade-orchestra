from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import FileResponse, Response

from ..core.runtime_paths import BASE_DIR
from ..db.database import db_data_enabled, db_expected
from ..drive_storage import storage_enabled
from ..services import meta_service

router = APIRouter()


@router.get("/api/revision", response_model=None)
async def get_revision() -> Response:
    return Response(
        content=meta_service.revision_response_payload(),
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/")
async def root() -> FileResponse:
    return FileResponse(
        meta_service.index_file_path(BASE_DIR),
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


@router.get("/api/health")
async def health_check() -> dict[str, str]:
    return meta_service.health_payload(
        storage_configured=storage_enabled(),
        db_expected=db_expected(),
        db_configured=db_data_enabled(),
    )
