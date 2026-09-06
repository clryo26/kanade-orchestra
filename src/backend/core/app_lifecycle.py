from __future__ import annotations

from typing import Any, Callable


def local_json_fallback_enabled(*, env_flag_enabled: Callable[[str], bool]) -> bool:
    from .db_runtime import local_json_fallback_enabled as _local_json_fallback_enabled

    return _local_json_fallback_enabled(env_flag_enabled)


def db_expected(
    *,
    local_json_fallback_enabled: Callable[[], bool],
    env_flag_enabled: Callable[[str], bool],
) -> bool:
    from .db_runtime import db_expected as _db_expected

    return _db_expected(local_json_fallback_enabled, env_flag_enabled)


def ensure_db_expected_is_ready(*, db_expected: Callable[[], bool], db_data_enabled: Callable[[], bool]) -> None:
    from .db_runtime import ensure_db_expected_is_ready as _ensure_db_expected_is_ready

    _ensure_db_expected_is_ready(db_expected, db_data_enabled)


def run_db_startup_self_check(
    *,
    assert_db_ready: Callable[[], None],
    db_connection_string: Callable[[], str],
    ensure_db_schema_compatibility: Callable[[Any], None],
    psycopg: Any,
    db_expected: Callable[[], bool],
    ensure_db_expected_is_ready: Callable[[], None],
) -> None:
    import logging
    from time import perf_counter

    from .database import run_startup_self_check as _run_startup_self_check

    logger = logging.getLogger(__name__)

    def timed_ensure_db_expected_is_ready() -> None:
        started_at = perf_counter()
        ensure_db_expected_is_ready()
        logger.info(
            "DB startup self-check dependency done: ensure_db_expected_is_ready (%.1f ms)",
            (perf_counter() - started_at) * 1000,
        )

    def timed_assert_db_ready() -> None:
        started_at = perf_counter()
        assert_db_ready()
        logger.info(
            "DB startup self-check dependency done: assert_db_ready (%.1f ms)",
            (perf_counter() - started_at) * 1000,
        )

    def timed_db_connection_string() -> str:
        started_at = perf_counter()
        value = db_connection_string()
        logger.info(
            "DB startup self-check dependency done: db_connection_string (%.1f ms)",
            (perf_counter() - started_at) * 1000,
        )
        return value

    def timed_ensure_db_schema_compatibility(conn: Any) -> None:
        started_at = perf_counter()
        ensure_db_schema_compatibility(conn)
        logger.info(
            "DB startup self-check dependency done: schema_compatibility (%.1f ms)",
            (perf_counter() - started_at) * 1000,
        )

    class TimedPsycopg:
        def __getattr__(self, name: str) -> Any:
            return getattr(psycopg, name)

        def connect(self, *args: Any, **kwargs: Any) -> Any:
            started_at = perf_counter()
            connection = psycopg.connect(*args, **kwargs)
            logger.info(
                "DB startup self-check dependency done: db_connect (%.1f ms)",
                (perf_counter() - started_at) * 1000,
            )
            return connection

    _run_startup_self_check(
        assert_db_ready_func=timed_assert_db_ready,
        db_connection_string_func=timed_db_connection_string,
        ensure_db_schema_compatibility_func=timed_ensure_db_schema_compatibility,
        psycopg_module=TimedPsycopg(),
        db_expected_func=db_expected,
        ensure_db_expected_is_ready_func=timed_ensure_db_expected_is_ready,
    )