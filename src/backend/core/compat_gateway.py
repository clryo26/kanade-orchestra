from __future__ import annotations

from typing import Any

from .. import app_core


def get_compat_app():
    return app_core.app


def run_db_startup_self_check() -> None:
    app_core.run_db_startup_self_check()


async def seed_cloud_data_from_local() -> None:
    await app_core.seed_cloud_data_from_local()


def get_memory_cache_instance():
    return app_core._memory_cache


def load_json_data(name: str):
    return app_core.load_json_data(name)


def save_json_data(name: str, data: list[dict[str, Any]]) -> None:
    app_core.save_json_data(name, data)
