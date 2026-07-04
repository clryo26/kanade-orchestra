from __future__ import annotations

import os
from collections.abc import Callable
from datetime import datetime
from typing import Any

from fastapi import HTTPException


def has_connection_setting(items: list[dict[str, Any]]) -> bool:
    primary_keys = (
        "google_project_id",
        "google_cloud_storage_bucket",
        "google_service_account_file",
        "google_service_account_json",
    )
    for item in items:
        if not isinstance(item, dict):
            continue
        values = [str(item.get(key) or "").strip() for key in primary_keys]
        if any(
            value
            and value
            not in {
                "your_bucket_name_here",
                "あなたのGCSバケット名",
                "あなたのGCSバケット名",
            }
            for value in values
        ):
            return True
    return False


def legacy_connection_setting_from_env() -> dict[str, Any]:
    bucket = os.getenv("GOOGLE_CLOUD_STORAGE_BUCKET", "").strip()
    if not bucket:
        return {}

    public_raw = os.getenv("GOOGLE_CLOUD_STORAGE_PUBLIC", "").strip().lower()
    if public_raw in {"1", "true", "yes", "on"}:
        public_value = "true"
    elif public_raw in {"0", "false", "no", "off"}:
        public_value = "false"
    else:
        public_value = ""

    return {
        "google_project_id": os.getenv("GOOGLE_CLOUD_PROJECT", "").strip(),
        "google_cloud_storage_bucket": bucket,
        "google_cloud_storage_data_prefix": os.getenv("GOOGLE_CLOUD_STORAGE_DATA_PREFIX", "").strip(),
        "google_cloud_storage_public": public_value,
        "google_service_account_file": os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip(),
        "google_service_account_json": os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip(),
    }


def seed_connection_settings_from_legacy_env(
    *,
    load_json_data: Callable[[str], list[dict[str, Any]]],
    save_json_data: Callable[[str, list[dict[str, Any]]], None],
    next_id: Callable[[list[dict[str, Any]]], int],
    logger: Any,
) -> None:
    items = load_json_data("connection_settings")
    if has_connection_setting(items):
        return

    legacy = legacy_connection_setting_from_env()
    if not legacy:
        return

    now = datetime.now().isoformat()
    payload = {
        "id": next_id(items),
        "created_at": now,
        "updated_at": now,
        **legacy,
    }
    items.append(payload)
    save_json_data("connection_settings", items)
    logger.info("Seeded connection_settings from legacy environment variables")


async def seed_cloud_data_from_local(
    *,
    seed_connection_settings_from_legacy_env: Callable[[], None] | None = None,
    load_json_data: Callable[[str], list[dict[str, Any]]],
    save_json_data: Callable[[str, list[dict[str, Any]]], None],
    next_id: Callable[[list[dict[str, Any]]], int],
    logger: Any,
    startup_preload_collections: tuple[str, ...],
    db_expected: Callable[[], bool],
) -> None:
    if seed_connection_settings_from_legacy_env is None:
        def _seed_from_env_default() -> None:
            globals()["seed_connection_settings_from_legacy_env"](
                load_json_data=load_json_data,
                save_json_data=save_json_data,
                next_id=next_id,
                logger=logger,
            )

        seed_connection_settings_from_legacy_env = _seed_from_env_default

    seed_connection_settings_from_legacy_env()

    if os.getenv("STARTUP_PRELOAD_ENABLED", "true").strip().lower() in {"0", "false", "no", "off"}:
        logger.info("Startup preload skipped by STARTUP_PRELOAD_ENABLED")
        return

    for name in startup_preload_collections:
        logger.info("Startup preload begin: %s", name)
        try:
            loaded = load_json_data(name)
            logger.info("Startup preload done: %s (%s items)", name, len(loaded))
        except HTTPException as exc:
            logger.exception("Startup preload failed: %s (%s)", name, exc)
            if db_expected():
                raise
