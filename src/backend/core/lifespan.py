from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Awaitable, Callable

from fastapi import FastAPI


def build_lifespan(
    *,
    startup_self_check: Callable[[], None],
    seed_startup_data: Callable[[], Awaitable[None]],
    open_db_pool: Callable[[], None],
    close_db_pool: Callable[[], None],
):
    @asynccontextmanager
    async def app_lifespan(_: FastAPI):
        open_db_pool()
        try:
            startup_self_check()
            await seed_startup_data()
            yield
        finally:
            close_db_pool()

    return app_lifespan
