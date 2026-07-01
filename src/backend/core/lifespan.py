from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Awaitable, Callable

from fastapi import FastAPI


def build_lifespan(
    *,
    startup_self_check: Callable[[], None],
    seed_startup_data: Callable[[], Awaitable[None]],
):
    @asynccontextmanager
    async def app_lifespan(_: FastAPI):
        startup_self_check()
        await seed_startup_data()
        yield

    return app_lifespan
