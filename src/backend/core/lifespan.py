from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from time import perf_counter
from typing import Awaitable, Callable

from fastapi import FastAPI


logger = logging.getLogger(__name__)


def build_lifespan(
    *,
    startup_self_check: Callable[[], None],
    seed_startup_data: Callable[[], Awaitable[None]],
    open_db_pool: Callable[[], None],
    close_db_pool: Callable[[], None],
):
    @asynccontextmanager
    async def app_lifespan(_: FastAPI):
        logger.info("Startup phase begin: open_db_pool")
        started_at = perf_counter()
        open_db_pool()
        logger.info(
            "Startup phase done: open_db_pool (%.1f ms)",
            (perf_counter() - started_at) * 1000,
        )
        try:
            logger.info("Startup phase begin: startup_self_check")
            started_at = perf_counter()
            startup_self_check()
            logger.info(
                "Startup phase done: startup_self_check (%.1f ms)",
                (perf_counter() - started_at) * 1000,
            )

            logger.info("Startup phase begin: seed_startup_data")
            started_at = perf_counter()
            await seed_startup_data()
            logger.info(
                "Startup phase done: seed_startup_data (%.1f ms)",
                (perf_counter() - started_at) * 1000,
            )
            yield
        finally:
            close_db_pool()

    return app_lifespan
