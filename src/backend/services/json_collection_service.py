from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException


MemoryCacheLike = Any
LoadDbCollection = Callable[[str], list[dict[str, Any]]]
SaveDbCollection = Callable[[str, list[dict[str, Any]]], None]
FlagFunc = Callable[[], bool]


def data_file(name: str, *, data_dir: Path) -> Path:
    return data_dir / f"{name}.json"


def load_local_json_data(name: str, *, data_dir: Path, logger) -> list[dict[str, Any]]:
    path = data_file(name, data_dir=data_dir)
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as file:
            loaded = json.load(file)
        return loaded if isinstance(loaded, list) else []
    except json.JSONDecodeError as exc:
        logger.error("Invalid JSON in %s: %s", path, exc)
        raise HTTPException(status_code=500, detail=f"{name}.json is invalid")


def load_json_data(
    name: str,
    *,
    cache: MemoryCacheLike,
    local_json_fallback_enabled: FlagFunc,
    ensure_db_expected_is_ready: Callable[[], None],
    db_load_json_data: LoadDbCollection,
    db_load_generic_json_collection: LoadDbCollection,
    json_collection_tables: set[str] | dict[str, str],
    json_data_names: list[str] | set[str] | tuple[str, ...],
    extra_collections: set[str] | list[str] | tuple[str, ...],
    data_dir: Path,
    logger,
) -> list[dict[str, Any]]:
    cached = cache.get(name)
    if cached is not None:
        return cached

    if not local_json_fallback_enabled():
        ensure_db_expected_is_ready()
        if name in json_collection_tables:
            db_data = db_load_json_data(name)
        elif name in json_data_names or name in extra_collections:
            db_data = db_load_generic_json_collection(name)
        else:
            raise HTTPException(status_code=404, detail=f"Unknown collection: {name}")
        cache.set(name, db_data)
        return db_data

    local_data = load_local_json_data(name, data_dir=data_dir, logger=logger)
    cache.set(name, local_data)
    return local_data


def save_json_data(
    name: str,
    data: list[dict[str, Any]],
    *,
    cache: MemoryCacheLike,
    local_json_fallback_enabled: FlagFunc,
    ensure_db_expected_is_ready: Callable[[], None],
    db_replace_collection: SaveDbCollection,
    db_save_generic_json_collection: SaveDbCollection,
    db_writable_collections: set[str] | list[str] | tuple[str, ...],
    json_data_names: list[str] | set[str] | tuple[str, ...],
    extra_collections: set[str] | list[str] | tuple[str, ...],
    data_dir: Path,
) -> None:
    if not local_json_fallback_enabled():
        ensure_db_expected_is_ready()
        if name in db_writable_collections:
            db_replace_collection(name, data)
        elif name in json_data_names or name in extra_collections:
            db_save_generic_json_collection(name, data)
        else:
            raise HTTPException(status_code=404, detail=f"Unknown collection: {name}")
        cache.set(name, data)
        return

    path = data_file(name, data_dir=data_dir)
    tmp_path = path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
    tmp_path.replace(path)
    cache.set(name, data)


async def list_auth_devices(*, load_json_data: Callable[[str], list[dict[str, Any]]]) -> list[dict[str, Any]]:
    return sorted(
        load_json_data("auth_devices"),
        key=lambda item: str(item.get("authenticated_at") or ""),
        reverse=True,
    )