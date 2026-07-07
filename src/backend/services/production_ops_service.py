from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from ..core.config import app_env_for_production_operations, production_operations_allowed_env
from ..core.storage_gateway import load_json_data, save_json_data

HISTORY_COLLECTION = "production_operation_histories"
_MAX_HISTORY = 200


def _env_value(name: str) -> str:
    return str(os.getenv(name, "") or "").strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _display_value(raw: str) -> str:
    return raw if raw else "未設定"


def _build_requested_by(device: dict[str, Any]) -> str:
    member_name = str(device.get("member_name") or "").strip()
    member_id = str(device.get("member_id") or "").strip()
    if member_name and member_id:
        return f"{member_name} (member_id={member_id})"
    if member_name:
        return member_name
    if member_id:
        return f"member_id={member_id}"
    return str(device.get("device_id") or "unknown")


def _execution_backend_configured() -> bool:
    return bool(_env_value("PRODUCTION_OPERATION_EXECUTOR"))


def _execution_backend_implemented() -> bool:
    # This phase intentionally does not implement a real executor.
    return False


def _load_histories() -> list[dict[str, Any]]:
    loaded = load_json_data(HISTORY_COLLECTION)
    return loaded if isinstance(loaded, list) else []


def _save_histories(items: list[dict[str, Any]]) -> None:
    save_json_data(HISTORY_COLLECTION, items)


def _append_history(item: dict[str, Any]) -> dict[str, Any]:
    histories = _load_histories()
    histories.append(item)
    if len(histories) > _MAX_HISTORY:
        histories = histories[-_MAX_HISTORY:]
    _save_histories(histories)
    return item


def _list_histories(operation_type: str) -> list[dict[str, Any]]:
    histories = _load_histories()
    filtered = [row for row in histories if str(row.get("operation_type") or "") == operation_type]
    return sorted(filtered, key=lambda row: str(row.get("requested_at") or ""), reverse=True)


def _history_item(
    *,
    operation_type: str,
    device: dict[str, Any],
    target_git_sha: str,
    target_environment: str,
    execution_status: str,
    failure_reason: str,
    execution_backend: str,
) -> dict[str, Any]:
    now = _now_iso()
    requested_by_member_id = str(device.get("member_id") or "")
    requested_by_member_name = str(device.get("member_name") or "")
    requested_by_permission = str(device.get("permission") or "")
    return {
        "operation_id": str(uuid4()),
        "operation_type": operation_type,
        "requested_at": now,
        "requested_by_member_id": requested_by_member_id,
        "requested_by_member_name": requested_by_member_name,
        "requested_by_permission": requested_by_permission,
        "requested_by": _build_requested_by(device),
        "target_git_sha": target_git_sha,
        "target_environment": target_environment,
        "execution_status": execution_status,
        "failure_reason": failure_reason,
        "execution_backend": execution_backend,
        "hidden_user": bool(device.get("hidden_user")),
        "request_source": "system_environment_management",
        "workflow_run_id": "",
        "cloud_run_job_execution_id": "",
        "created_at": now,
        "updated_at": now,
    }


def environment_status() -> dict[str, Any]:
    app_env = app_env_for_production_operations()
    return {
        "current_environment": app_env,
        "app_env": app_env,
        "deploy_info": {
            "git_sha": _display_value(_env_value("GIT_SHA")),
            "build_time": _display_value(_env_value("BUILD_TIMESTAMP")),
            "cloud_run_revision": _display_value(_env_value("K_REVISION") or _env_value("CLOUD_RUN_REVISION")),
        },
        "can_manage_operations": app_env == production_operations_allowed_env(),
        "execution_backend_configured": _execution_backend_configured(),
        "execution_backend_implemented": _execution_backend_implemented(),
        "history_storage": {
            "mode": "json_collection",
            "collection": HISTORY_COLLECTION,
            "persistent": True,
        },
        "sync_rules": {
            "direction": "production_to_test_only",
            "db_sync_targets": [
                "performances",
                "performance_pieces",
                "schedules",
                "announcements",
                "events",
                "members",
                "absences",
                "event_responses",
                "date_adjustments",
                "date_adjustment_candidates",
                "date_adjustment_responses",
                "piece_infos",
                "practice_instructions",
                "performance_day_infos",
                "payments",
                "payment_performance_fees",
                "castings",
                "casting_members",
                "casting_extras",
                "desired_pieces",
                "desired_piece_votes",
                "promotions",
                "albums",
                "album_photos",
                "part_settings",
                "venue_settings",
                "flyer_distributions",
                "flyer_distribution_assignments",
                "org_settings",
                "sns_settings",
                "connection_settings",
                "drive_files",
                "recording_metadata",
                "sheet_library",
            ],
            "db_sync_excluded": [
                "auth_devices",
                "access_logs",
                "audit_logs",
                HISTORY_COLLECTION,
            ],
            "gcs_sync_target_prefixes": [
                "recordings/",
                "sheets/",
                "albums/",
                "promotion/",
            ],
            "gcs_sync_excluded_prefixes": [
                "auth/",
                "audit/",
                "sync-history/",
            ],
            "pre_sync_backup_requirements": [
                "テストDBの同期前バックアップを必須化する",
                "テストGCSの同期前バックアップを必須化する",
            ],
            "post_sync_test_initialization_targets": [
                "auth_devices",
                "access_logs",
                HISTORY_COLLECTION,
            ],
        },
    }


def list_release_history() -> dict[str, Any]:
    items = _list_histories("promote")
    return {
        "items": items,
        "total": len(items),
    }


def list_sync_history() -> dict[str, Any]:
    items = _list_histories("prod_to_test_sync")
    return {
        "items": items,
        "total": len(items),
    }


def request_release_promote(*, device: dict[str, Any], target_git_sha: str) -> dict[str, Any]:
    git_sha = str(target_git_sha or "").strip()
    if not git_sha:
        return {
            "accepted": False,
            "message": "target_git_sha is required",
            "execution_status": "rejected",
            "history": None,
        }

    failure = "本番リリース実行基盤は未実装です（設定値のみでは実行できません）"
    item = _history_item(
        operation_type="promote",
        device=device,
        target_git_sha=git_sha,
        target_environment="production",
        execution_status="not_configured",
        failure_reason=failure,
        execution_backend=_env_value("PRODUCTION_OPERATION_EXECUTOR") or "unimplemented",
    )
    _append_history(item)
    return {
        "accepted": False,
        "message": failure,
        "execution_status": "not_configured",
        "history": item,
    }


def request_sync_prod_to_test(*, device: dict[str, Any], target_git_sha: str) -> dict[str, Any]:
    git_sha = str(target_git_sha or "").strip() or _env_value("GIT_SHA")
    failure = "本番データ同期実行基盤は未実装です（設定値のみでは実行できません）"
    item = _history_item(
        operation_type="prod_to_test_sync",
        device=device,
        target_git_sha=git_sha,
        target_environment="test",
        execution_status="not_configured",
        failure_reason=failure,
        execution_backend=_env_value("PRODUCTION_OPERATION_EXECUTOR") or "unimplemented",
    )
    _append_history(item)
    return {
        "accepted": False,
        "message": failure,
        "execution_status": "not_configured",
        "history": item,
    }
