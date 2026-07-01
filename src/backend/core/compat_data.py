from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from fastapi import Request
from fastapi.responses import Response


def load_json_data(
    name: str,
    *,
    load_json_data_compat: Callable[..., list[dict[str, Any]]],
    cache: Any,
    effective_local_json_fallback_enabled: Callable[..., bool],
    db_data_enabled: Callable[[], bool],
    db_expected: Callable[[], bool],
    local_json_fallback_enabled: Callable[[], bool],
    ensure_db_expected_is_ready: Callable[[], None],
    db_load_json_data: Callable[[str], list[dict[str, Any]]],
    json_collection_tables: set[str] | dict[str, str],
    json_data_names: list[str] | set[str] | tuple[str, ...],
    extra_collections: set[str] | list[str] | tuple[str, ...],
    data_dir: Path,
    logger: Any,
) -> list[dict[str, Any]]:
    return load_json_data_compat(
        name,
        cache=cache,
        effective_local_json_fallback_enabled=effective_local_json_fallback_enabled,
        db_data_enabled=db_data_enabled,
        db_expected=db_expected,
        local_json_fallback_enabled=local_json_fallback_enabled,
        ensure_db_expected_is_ready=ensure_db_expected_is_ready,
        db_load_json_data=db_load_json_data,
        json_collection_tables=json_collection_tables,
        json_data_names=json_data_names,
        extra_collections=extra_collections,
        data_dir=data_dir,
        logger=logger,
    )


def save_json_data(
    name: str,
    data: list[dict[str, Any]],
    *,
    save_json_data_compat: Callable[..., None],
    cache: Any,
    effective_local_json_fallback_enabled: Callable[..., bool],
    db_data_enabled: Callable[[], bool],
    db_expected: Callable[[], bool],
    local_json_fallback_enabled: Callable[[], bool],
    ensure_db_expected_is_ready: Callable[[], None],
    db_replace_collection: Callable[[str, list[dict[str, Any]]], None],
    db_writable_collections: set[str] | list[str] | tuple[str, ...],
    json_data_names: list[str] | set[str] | tuple[str, ...],
    extra_collections: set[str] | list[str] | tuple[str, ...],
    data_dir: Path,
) -> None:
    save_json_data_compat(
        name,
        data,
        cache=cache,
        effective_local_json_fallback_enabled=effective_local_json_fallback_enabled,
        db_data_enabled=db_data_enabled,
        db_expected=db_expected,
        local_json_fallback_enabled=local_json_fallback_enabled,
        ensure_db_expected_is_ready=ensure_db_expected_is_ready,
        db_replace_collection=db_replace_collection,
        db_writable_collections=db_writable_collections,
        json_data_names=json_data_names,
        extra_collections=extra_collections,
        data_dir=data_dir,
    )


def seed_connection_settings_from_legacy_env(
    *,
    compat_func: Callable[..., None],
    load_json_data: Callable[[str], list[dict[str, Any]]],
    save_json_data: Callable[[str, list[dict[str, Any]]], None],
    next_id: Callable[[list[dict[str, Any]]], int],
    logger: Any,
) -> None:
    compat_func(
        load_json_data=load_json_data,
        save_json_data=save_json_data,
        next_id=next_id,
        logger=logger,
    )


async def seed_cloud_data_from_local(
    *,
    compat_func: Callable[..., Any],
    seed_connection_settings_from_legacy_env: Callable[[], None],
    load_json_data: Callable[[str], list[dict[str, Any]]],
    save_json_data: Callable[[str, list[dict[str, Any]]], None],
    next_id: Callable[[list[dict[str, Any]]], int],
    logger: Any,
    startup_preload_collections: tuple[str, ...],
    db_expected: Callable[[], bool],
) -> None:
    await compat_func(
        seed_connection_settings_from_legacy_env=seed_connection_settings_from_legacy_env,
        load_json_data=load_json_data,
        save_json_data=save_json_data,
        next_id=next_id,
        logger=logger,
        startup_preload_collections=startup_preload_collections,
        db_expected=db_expected,
    )


async def list_auth_devices(*, compat_func: Callable[..., Any], load_json_data: Callable[[str], list[dict[str, Any]]]) -> list[dict[str, Any]]:
    return await compat_func(load_json_data=load_json_data)


def find_item(
    items: list[dict[str, Any]],
    item_id: int,
    *,
    compat_func: Callable[..., tuple[int, dict[str, Any]]],
    cache: Any,
    cache_names: list[str] | set[str] | tuple[str, ...],
) -> tuple[int, dict[str, Any]]:
    return compat_func(items, item_id, cache=cache, cache_names=cache_names)


def check_etag(request: Request, data_name: str, *, compat_func: Callable[..., Response | None], cache: Any) -> Response | None:
    return compat_func(request, data_name, cache=cache)