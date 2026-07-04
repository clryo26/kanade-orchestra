from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from ..services.json_collection_service import load_json_data as service_load_json_data
from ..services.json_collection_service import save_json_data as service_save_json_data


def load_json_data_compat(
    name: str,
    *,
    cache: Any,
    effective_local_json_fallback_enabled: Callable[..., bool],
    db_data_enabled: Callable[[], bool],
    db_expected: Callable[[], bool],
    local_json_fallback_enabled: Callable[[], bool],
    ensure_db_expected_is_ready: Callable[[], None],
    db_load_json_data: Callable[[str], list[dict[str, Any]]],
    db_load_generic_json_collection: Callable[[str], list[dict[str, Any]]],
    json_collection_tables: set[str] | dict[str, str],
    json_data_names: list[str] | set[str] | tuple[str, ...],
    extra_collections: set[str] | list[str] | tuple[str, ...],
    data_dir: Path,
    logger: Any,
) -> list[dict[str, Any]]:
    return service_load_json_data(
        name,
        cache=cache,
        local_json_fallback_enabled=lambda: effective_local_json_fallback_enabled(
            db_data_enabled=db_data_enabled,
            db_expected=db_expected,
            local_json_fallback_enabled=local_json_fallback_enabled,
        ),
        ensure_db_expected_is_ready=ensure_db_expected_is_ready,
        db_load_json_data=db_load_json_data,
        db_load_generic_json_collection=db_load_generic_json_collection,
        json_collection_tables=json_collection_tables,
        json_data_names=json_data_names,
        extra_collections=extra_collections,
        data_dir=data_dir,
        logger=logger,
    )


def save_json_data_compat(
    name: str,
    data: list[dict[str, Any]],
    *,
    cache: Any,
    effective_local_json_fallback_enabled: Callable[..., bool],
    db_data_enabled: Callable[[], bool],
    db_expected: Callable[[], bool],
    local_json_fallback_enabled: Callable[[], bool],
    ensure_db_expected_is_ready: Callable[[], None],
    db_replace_collection: Callable[[str, list[dict[str, Any]]], None],
    db_save_generic_json_collection: Callable[[str, list[dict[str, Any]]], None],
    db_writable_collections: set[str] | list[str] | tuple[str, ...],
    json_data_names: list[str] | set[str] | tuple[str, ...],
    extra_collections: set[str] | list[str] | tuple[str, ...],
    data_dir: Path,
) -> None:
    service_save_json_data(
        name,
        data,
        cache=cache,
        local_json_fallback_enabled=lambda: effective_local_json_fallback_enabled(
            db_data_enabled=db_data_enabled,
            db_expected=db_expected,
            local_json_fallback_enabled=local_json_fallback_enabled,
        ),
        ensure_db_expected_is_ready=ensure_db_expected_is_ready,
        db_replace_collection=db_replace_collection,
        db_save_generic_json_collection=db_save_generic_json_collection,
        db_writable_collections=db_writable_collections,
        json_data_names=json_data_names,
        extra_collections=extra_collections,
        data_dir=data_dir,
    )


def seed_connection_settings_from_legacy_env_compat(
    *,
    startup_seed_connection_settings_from_legacy_env: Callable[..., None],
    load_json_data: Callable[[str], list[dict[str, Any]]],
    save_json_data: Callable[[str, list[dict[str, Any]]], None],
    next_id: Callable[[list[dict[str, Any]]], int],
    logger: Any,
) -> None:
    startup_seed_connection_settings_from_legacy_env(
        load_json_data=load_json_data,
        save_json_data=save_json_data,
        next_id=next_id,
        logger=logger,
    )


async def seed_cloud_data_from_local_compat(
    *,
    startup_seed_cloud_data_from_local: Callable[..., Any],
    seed_connection_settings_from_legacy_env: Callable[[], None],
    load_json_data: Callable[[str], list[dict[str, Any]]],
    save_json_data: Callable[[str, list[dict[str, Any]]], None],
    next_id: Callable[[list[dict[str, Any]]], int],
    logger: Any,
    startup_preload_collections: tuple[str, ...],
    db_expected: Callable[[], bool],
) -> None:
    await startup_seed_cloud_data_from_local(
        seed_connection_settings_from_legacy_env=seed_connection_settings_from_legacy_env,
        load_json_data=load_json_data,
        save_json_data=save_json_data,
        next_id=next_id,
        logger=logger,
        startup_preload_collections=startup_preload_collections,
        db_expected=db_expected,
    )
