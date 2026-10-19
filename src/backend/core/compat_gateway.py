from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from ..repositories.db_item_repository import ListRowStore, PostgresRowStore

from .. import app_core


def get_compat_app():
    return app_core.app


def run_db_startup_self_check() -> None:
    app_core.run_db_startup_self_check()


async def seed_cloud_data_from_local() -> None:
    await app_core.seed_cloud_data_from_local()


def get_memory_cache_instance():
    return app_core._memory_cache


def get_runtime_data_paths() -> tuple[Path, Path]:
    """Respect legacy runtime/test path overrides at the compatibility boundary."""
    return app_core.DATA_DIR, app_core.UPLOAD_DIR


def load_json_data(name: str):
    return app_core.load_json_data(name)


def save_json_data(name: str, data: list[dict[str, Any]]) -> None:
    app_core.save_json_data(name, data)


def mutate_json_data(name: str, mutator):
    """Locked read-modify-write of a list-saved collection (patchable through app_core)."""
    return app_core.mutate_json_data(name, mutator)


# Marker: these gateway savers can be upgraded to the locked mutation.
save_json_data.supports_locked_mutation = True  # type: ignore[attr-defined]


def row_store() -> PostgresRowStore | ListRowStore:
    """Row-level store for the active backend (patchable through app_core)."""
    return cast("PostgresRowStore | ListRowStore", app_core.row_store())
