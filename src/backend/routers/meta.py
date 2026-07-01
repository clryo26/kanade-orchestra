from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import FileResponse, Response

from ..core.runtime_paths import BASE_DIR
from ..db.database import db_data_enabled, db_expected
from ..drive_storage import storage_enabled
from ..services import meta_service
from ..services.storage_service import load_json_data

router = APIRouter()


def _org_short_name() -> str:
    try:
        org = (load_json_data("org_settings") or [{}])[0]
    except Exception:
        org = {}
    value = (
        org.get("short_name")
        or org.get("shortName")
        or org.get("abbreviation")
        or org.get("short")
        or org.get("organization_abbreviation")
        or org.get("organizationAbbreviation")
        or org.get("name")
        or org.get("organization_name")
        or org.get("organizationName")
        or org.get("organization_name_full")
        or org.get("organizationNameFull")
        or "楽団"
    )
    return str(value).strip() or "楽団"


def _portal_title() -> str:
    return f"{_org_short_name()}ポータル"


@router.get("/api/revision", response_model=None)
async def get_revision() -> Response:
    return Response(
        content=meta_service.revision_response_payload(),
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/manifest.webmanifest", response_model=None)
async def web_manifest() -> Response:
    title = _portal_title()
    return Response(
        content=meta_service.manifest_response_payload(title),
        media_type="application/manifest+json",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
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
