from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..core.startup import (
    has_connection_setting as _has_connection_setting,
    legacy_connection_setting_from_env as _legacy_connection_setting_from_env,
    seed_cloud_data_from_local as _seed_cloud_data_from_local,
    seed_connection_settings_from_legacy_env as _seed_connection_settings_from_legacy_env,
)
from ..services.json_collection_service import list_auth_devices as _list_auth_devices


def has_connection_setting(items: list[dict[str, Any]]) -> bool:
    return _has_connection_setting(items)


def legacy_connection_setting_from_env() -> dict[str, Any]:
    return _legacy_connection_setting_from_env()


def seed_connection_settings_from_legacy_env(
    *,
    load_json_data: Callable[[str], list[dict[str, Any]]],
    save_json_data: Callable[[str, list[dict[str, Any]]], None],
    next_id: Callable[[list[dict[str, Any]]], int],
    logger: Any,
) -> None:
    _seed_connection_settings_from_legacy_env(
        load_json_data=load_json_data,
        save_json_data=save_json_data,
        next_id=next_id,
        logger=logger,
    )


async def seed_cloud_data_from_local(
    *,
    seed_connection_settings_from_legacy_env: Callable[[], None],
    load_json_data: Callable[[str], list[dict[str, Any]]],
    save_json_data: Callable[[str, list[dict[str, Any]]], None],
    next_id: Callable[[list[dict[str, Any]]], int],
    logger: Any,
    startup_preload_collections: tuple[str, ...],
    db_expected: Callable[[], bool],
) -> None:
    await _seed_cloud_data_from_local(
        seed_connection_settings_from_legacy_env=seed_connection_settings_from_legacy_env,
        load_json_data=load_json_data,
        save_json_data=save_json_data,
        next_id=next_id,
        logger=logger,
        startup_preload_collections=startup_preload_collections,
        db_expected=db_expected,
    )


async def list_auth_devices(load_json_data: Callable[[str], list[dict[str, Any]]]) -> list[dict[str, Any]]:
    return await _list_auth_devices(load_json_data=load_json_data)
