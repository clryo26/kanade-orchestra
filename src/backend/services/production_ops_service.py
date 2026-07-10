from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any
from urllib import error, parse, request
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
    return _env_value("PRODUCTION_OPERATION_EXECUTOR").lower() == "github-actions"


def _github_dispatch_config() -> dict[str, str]:
    return {
        "repository": _env_value("GITHUB_REPOSITORY"),
        "token": _env_value("GITHUB_ACTIONS_TOKEN") or _env_value("GITHUB_TOKEN"),
        "workflow": _env_value("PROMOTE_PRODUCTION_WORKFLOW") or "promote-production.yml",
        "ref": _env_value("PROMOTE_PRODUCTION_REF") or "main",
    }


def _sync_github_dispatch_config() -> dict[str, str]:
    return {
        "repository": _env_value("GITHUB_REPOSITORY"),
        "token": _env_value("GITHUB_ACTIONS_TOKEN") or _env_value("GITHUB_TOKEN"),
        "workflow": _env_value("SYNC_PROD_TO_TEST_WORKFLOW") or "sync-prod-to-test.yml",
        "ref": _env_value("SYNC_PROD_TO_TEST_REF") or "main",
    }


def _github_dispatch_config_missing(config: dict[str, str]) -> list[str]:
    return [name for name, value in config.items() if not value]


def _dispatch_github_workflow_inputs(*, config: dict[str, str], inputs: dict[str, str]) -> str:
    missing = _github_dispatch_config_missing(config)
    if missing:
        raise RuntimeError(f"GitHub Actions dispatch settings are missing: {', '.join(missing)}")

    payload = {
        "ref": config["ref"],
        "inputs": inputs,
    }
    body = json.dumps(payload).encode("utf-8")
    url = (
        "https://api.github.com/repos/"
        f"{config['repository']}/actions/workflows/{config['workflow']}/dispatches"
    )
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {config['token']}",
        "Content-Type": "application/json",
        "User-Agent": "kanade-orchestra-portal-release",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    req = request.Request(url, data=body, headers=headers, method="POST")
    try:
        with request.urlopen(req, timeout=10) as response:
            if response.status != 204:
                raise RuntimeError(f"GitHub workflow dispatch returned HTTP {response.status}")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"GitHub workflow dispatch failed with HTTP {exc.code}: {detail}"
        ) from exc
    except error.URLError as exc:
        raise RuntimeError(f"GitHub workflow dispatch failed: {exc.reason}") from exc
    return config["workflow"]


def _dispatch_github_workflow(*, git_sha: str, image_digest: str) -> str:
    return _dispatch_github_workflow_inputs(
        config=_github_dispatch_config(),
        inputs={
            "tested_sha": git_sha,
            "tested_image_digest": image_digest,
        },
    )


def _dispatch_sync_prod_to_test_workflow(
    *,
    operation_id: str,
    target_git_sha: str,
    dry_run: bool,
) -> str:
    return _dispatch_github_workflow_inputs(
        config=_sync_github_dispatch_config(),
        inputs={
            "operation_id": operation_id,
            "target_git_sha": target_git_sha,
            "dry_run": "true" if dry_run else "false",
        },
    )


def _github_api_headers(config: dict[str, str]) -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {config['token']}",
        "User-Agent": "kanade-orchestra-portal-release",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _fetch_github_workflow_runs(config: dict[str, str]) -> list[dict[str, Any]]:
    missing = _github_dispatch_config_missing(config)
    if missing:
        raise RuntimeError(f"GitHub Actions settings are missing: {', '.join(missing)}")

    workflow = parse.quote(config["workflow"], safe="")
    url = (
        "https://api.github.com/repos/"
        f"{config['repository']}/actions/workflows/{workflow}/runs"
        "?event=workflow_dispatch&per_page=50"
    )
    req = request.Request(url, headers=_github_api_headers(config), method="GET")
    try:
        with request.urlopen(req, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(f"GitHub workflow runs returned HTTP {response.status}")
            payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"GitHub workflow runs failed with HTTP {exc.code}: {detail}"
        ) from exc
    except error.URLError as exc:
        raise RuntimeError(f"GitHub workflow runs failed: {exc.reason}") from exc

    runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
    return runs if isinstance(runs, list) else []


def _workflow_run_matches_operation(run: dict[str, Any], operation_id: str) -> bool:
    if not operation_id:
        return False
    for key in ("display_title", "name", "run_number", "html_url"):
        value = str(run.get(key) or "")
        if operation_id in value:
            return True
    return False


def _execution_status_from_github_run(run: dict[str, Any]) -> str:
    status = str(run.get("status") or "").lower()
    conclusion = str(run.get("conclusion") or "").lower()
    if status == "completed":
        return "success" if conclusion == "success" else "failed"
    if status == "in_progress":
        return "running"
    if status == "queued":
        return "queued"
    return "running" if status else "queued"


def _apply_github_run_to_history(item: dict[str, Any], run: dict[str, Any]) -> bool:
    previous = dict(item)
    execution_status = _execution_status_from_github_run(run)
    conclusion = str(run.get("conclusion") or "").lower()

    item["execution_status"] = execution_status
    item["workflow_run_id"] = str(run.get("id") or "")
    item["workflow_run_url"] = str(run.get("html_url") or "")
    item["updated_at"] = str(
        run.get("updated_at") or run.get("run_started_at") or run.get("created_at") or _now_iso()
    )

    if execution_status == "failed":
        item["failure_reason"] = f"GitHub Actions concluded: {conclusion or 'unknown'}"
    elif execution_status == "success":
        item["failure_reason"] = ""
        item["completed_at"] = str(run.get("updated_at") or _now_iso())

    return item != previous


def _refresh_sync_histories_from_github() -> None:
    histories = _load_histories()
    pending = [
        item
        for item in histories
        if str(item.get("operation_type") or "") == "prod_to_test_sync"
        and str(item.get("execution_status") or "") in {"queued", "running"}
    ]
    if not pending:
        return

    try:
        runs = _fetch_github_workflow_runs(_sync_github_dispatch_config())
    except Exception:
        return

    changed = False
    for item in pending:
        operation_id = str(item.get("operation_id") or "")
        matched = next(
            (run for run in runs if isinstance(run, dict) and _workflow_run_matches_operation(run, operation_id)),
            None,
        )
        if matched and _apply_github_run_to_history(item, matched):
            changed = True

    if changed:
        _save_histories(histories)


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
    image_uri: str = "",
    image_digest: str = "",
    workflow_run_id: str = "",
    operation_id: str = "",
    workflow_run_url: str = "",
    completed_at: str = "",
    backup_path: str = "",
) -> dict[str, Any]:
    now = _now_iso()
    requested_by_member_id = str(device.get("member_id") or "")
    requested_by_member_name = str(device.get("member_name") or "")
    requested_by_permission = str(device.get("permission") or "")
    return {
        "operation_id": operation_id or str(uuid4()),
        "operation_type": operation_type,
        "requested_at": now,
        "requested_by_member_id": requested_by_member_id,
        "requested_by_member_name": requested_by_member_name,
        "requested_by_permission": requested_by_permission,
        "requested_by": _build_requested_by(device),
        "target_git_sha": target_git_sha,
        "image_uri": image_uri,
        "image_digest": image_digest,
        "target_environment": target_environment,
        "execution_status": execution_status,
        "failure_reason": failure_reason,
        "execution_backend": execution_backend,
        "hidden_user": bool(device.get("hidden_user")),
        "request_source": "system_environment_management",
        "workflow_run_id": workflow_run_id,
        "workflow_run_url": workflow_run_url,
        "cloud_run_job_execution_id": "",
        "completed_at": completed_at,
        "backup_path": backup_path,
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
            "image_uri": _display_value(_env_value("IMAGE_URI")),
            "image_digest": _display_value(_env_value("IMAGE_DIGEST")),
            "cloud_run_service": _display_value(
                _env_value("K_SERVICE") or _env_value("CLOUD_RUN_SERVICE")
            ),
            "cloud_run_revision": _display_value(
                _env_value("K_REVISION") or _env_value("CLOUD_RUN_REVISION")
            ),
        },
        "can_manage_operations": app_env == production_operations_allowed_env(),
        "execution_backend_configured": _execution_backend_configured(),
        "execution_backend_implemented": _execution_backend_implemented(),
        "promotion_dispatch": {
            "mode": "github-actions",
            "configured": not _github_dispatch_config_missing(_github_dispatch_config()),
            "workflow": _github_dispatch_config().get("workflow", ""),
            "repository_configured": bool(_github_dispatch_config().get("repository")),
            "ref": _github_dispatch_config().get("ref", ""),
        },
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
    _refresh_sync_histories_from_github()
    items = _list_histories("prod_to_test_sync")
    return {
        "items": items,
        "total": len(items),
    }


def request_release_promote(
    *,
    device: dict[str, Any],
    target_git_sha: str,
    target_image_digest: str = "",
) -> dict[str, Any]:
    git_sha = str(target_git_sha or "").strip()
    image_digest = str(target_image_digest or "").strip() or _env_value("IMAGE_DIGEST")
    image_uri = _env_value("IMAGE_URI")
    if not git_sha:
        return {
            "accepted": False,
            "message": "target_git_sha is required",
            "execution_status": "rejected",
            "history": None,
        }
    if not image_digest or image_digest == "未設定":
        return {
            "accepted": False,
            "message": "target_image_digest is required",
            "execution_status": "rejected",
            "history": None,
        }

    execution_backend = _env_value("PRODUCTION_OPERATION_EXECUTOR") or "unimplemented"
    if not _execution_backend_implemented():
        failure = "本番リリース実行基盤は未実装です（PRODUCTION_OPERATION_EXECUTOR=github-actions が必要です）"
        item = _history_item(
            operation_type="promote",
            device=device,
            target_git_sha=git_sha,
            target_environment="production",
            execution_status="not_configured",
            failure_reason=failure,
            execution_backend=execution_backend,
            image_uri=image_uri,
            image_digest=image_digest,
        )
        _append_history(item)
        return {
            "accepted": False,
            "message": failure,
            "execution_status": "not_configured",
            "history": item,
        }

    try:
        workflow = _dispatch_github_workflow(git_sha=git_sha, image_digest=image_digest)
    except Exception as exc:
        failure = str(exc)
        item = _history_item(
            operation_type="promote",
            device=device,
            target_git_sha=git_sha,
            target_environment="production",
            execution_status="dispatch_failed",
            failure_reason=failure,
            execution_backend=execution_backend,
            image_uri=image_uri,
            image_digest=image_digest,
        )
        _append_history(item)
        return {
            "accepted": False,
            "message": "本番リリース workflow の起動に失敗しました",
            "execution_status": "dispatch_failed",
            "history": item,
        }

    item = _history_item(
        operation_type="promote",
        device=device,
        target_git_sha=git_sha,
        target_environment="production",
        execution_status="queued",
        failure_reason="",
        execution_backend=execution_backend,
        image_uri=image_uri,
        image_digest=image_digest,
        workflow_run_id=workflow,
    )
    _append_history(item)
    return {
        "accepted": True,
        "message": "本番リリース workflow を起動しました",
        "execution_status": "queued",
        "history": item,
    }

def request_sync_prod_to_test(*, device: dict[str, Any], target_git_sha: str) -> dict[str, Any]:
    git_sha = str(target_git_sha or "").strip() or _env_value("GIT_SHA")
    if not git_sha:
        return {
            "accepted": False,
            "message": "target_git_sha is required",
            "execution_status": "rejected",
            "history": None,
        }

    operation_id = str(uuid4())
    dry_run = True
    execution_backend = _env_value("PRODUCTION_OPERATION_EXECUTOR") or "unimplemented"
    if not _execution_backend_implemented():
        failure = "PRODUCTION_OPERATION_EXECUTOR=github-actions is required"
        item = _history_item(
            operation_id=operation_id,
            operation_type="prod_to_test_sync",
            device=device,
            target_git_sha=git_sha,
            target_environment="test",
            execution_status="failed",
            failure_reason=failure,
            execution_backend=execution_backend,
        )
        _append_history(item)
        return {
            "accepted": False,
            "message": failure,
            "execution_status": "failed",
            "history": item,
        }

    try:
        _dispatch_sync_prod_to_test_workflow(
            operation_id=operation_id,
            target_git_sha=git_sha,
            dry_run=dry_run,
        )
    except Exception as exc:
        failure = str(exc)
        item = _history_item(
            operation_id=operation_id,
            operation_type="prod_to_test_sync",
            device=device,
            target_git_sha=git_sha,
            target_environment="test",
            execution_status="failed",
            failure_reason=failure,
            execution_backend=execution_backend,
        )
        _append_history(item)
        return {
            "accepted": False,
            "message": "production-to-test sync workflow dispatch failed",
            "execution_status": "failed",
            "history": item,
        }

    item = _history_item(
        operation_id=operation_id,
        operation_type="prod_to_test_sync",
        device=device,
        target_git_sha=git_sha,
        target_environment="test",
        execution_status="queued",
        failure_reason="",
        execution_backend=execution_backend,
    )
    _append_history(item)
    return {
        "accepted": True,
        "message": "production-to-test sync workflow queued",
        "execution_status": "queued",
        "history": item,
    }
