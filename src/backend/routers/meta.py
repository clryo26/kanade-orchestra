from __future__ import annotations

import os

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse, Response

from ..core.auth_dependencies import get_diagnostic_admin_auth
from ..core.runtime_paths import BASE_DIR
from ..db.database import db_data_enabled, db_expected
from ..drive_storage import storage_enabled
from ..services.audit_service import write_diagnostic_access_log
from ..services import meta_service
from ..services.storage_service import load_json_data

router = APIRouter()


def _mask_secret(value: str, *, keep_start: int = 2, keep_end: int = 2) -> str:
    if not value:
        return ""
    if len(value) <= keep_start + keep_end:
        return "*" * len(value)
    return f"{value[:keep_start]}***{value[-keep_end:]}"


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def _is_production(app_env: str) -> bool:
    if app_env in {"prod", "production"}:
        return True
    return bool(os.getenv("K_SERVICE", "").strip())


def _masked_host(value: str) -> str:
    host = value.strip()
    if not host:
        return ""
    return _mask_secret(host, keep_start=1, keep_end=1)


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
    return meta_service.portal_title_for_environment(f"{_org_short_name()}ポータル")


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
async def health_check(request: Request) -> dict[str, str]:
    payload = meta_service.health_payload(
        storage_configured=storage_enabled(),
        db_expected=db_expected(),
        db_configured=db_data_enabled(),
    )
    payload["maintenance"] = str(getattr(request.app.state, "maintenance_mode_status", "disabled"))
    return payload


@router.get("/api/diagnostic/config-status")
async def config_status(
    request: Request,
    x_device_id: str = Header(default="", alias="X-Device-Id"),
    authorization: str = Header(default="", alias="Authorization"),
) -> dict[str, object]:
    app_env = str(os.getenv("APP_ENV", "dev") or "dev").strip().lower()
    production = _is_production(app_env)
    enabled = _env_flag("DIAGNOSTIC_CONFIG_ENABLED", False)
    require_admin = _env_flag("DIAGNOSTIC_CONFIG_REQUIRE_ADMIN", True)
    verbose = _env_flag("DIAGNOSTIC_CONFIG_VERBOSE", False)

    status_code = 200
    try:
        if not enabled:
            raise HTTPException(status_code=404, detail="Not Found")

        if require_admin:
            get_diagnostic_admin_auth(
                x_device_id=x_device_id,
                authorization=authorization,
                require_bearer_token=production,
            )

        data_backend = str(os.getenv("DATA_BACKEND", "db") or "db").strip().lower() or "db"
        cors_origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()]
        cloud_run_service = os.getenv("K_SERVICE", "").strip() or os.getenv("CLOUD_RUN_SERVICE", "").strip()
        cloud_run_revision = os.getenv("K_REVISION", "").strip() or os.getenv("CLOUD_RUN_REVISION", "").strip()
        gcs_bucket = os.getenv("GCS_BUCKET", "").strip() or os.getenv("GOOGLE_CLOUD_STORAGE_BUCKET", "").strip()

        payload: dict[str, object] = {
            "appEnv": app_env,
            "profile": data_backend,
            "dbRequired": db_expected(),
            "databaseConfigured": db_data_enabled(),
            "databaseHostMasked": _masked_host(os.getenv("DB_HOST", "").strip()),
            "gcsConfigured": storage_enabled(),
            "gcsBucketMasked": _mask_secret(gcs_bucket, keep_start=2, keep_end=2),
            "corsConfigured": bool(cors_origins),
            "corsOriginCount": len(cors_origins),
            "uploadLimitMb": int(str(os.getenv("MAX_UPLOAD_MB", "200") or "200")),
            "cloudRunDetected": bool(cloud_run_service or cloud_run_revision),
            "cloudRunService": cloud_run_service,
            "cloudRunRevisionMasked": _mask_secret(cloud_run_revision, keep_start=3, keep_end=3),
        }

        if production and not verbose:
            payload["databaseHostMasked"] = _mask_secret("hidden", keep_start=1, keep_end=1)

        return payload
    except HTTPException as exc:
        status_code = exc.status_code
        raise
    except Exception:
        status_code = 500
        raise HTTPException(status_code=500, detail="Diagnostic config status unavailable")
    finally:
        if enabled:
            try:
                write_diagnostic_access_log(
                    path="/api/diagnostic/config-status",
                    status_code=status_code,
                    device_id=x_device_id,
                    user_agent=request.headers.get("user-agent", ""),
                    ip_address=request.client.host if request.client else "",
                    request_id=request.headers.get("x-request-id", ""),
                    detail={"app_env": app_env, "production": production},
                )
            except Exception:
                pass
