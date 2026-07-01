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
    from .database import run_startup_self_check as _run_startup_self_check

    _run_startup_self_check(
        assert_db_ready_func=assert_db_ready,
        db_connection_string_func=db_connection_string,
        ensure_db_schema_compatibility_func=ensure_db_schema_compatibility,
        psycopg_module=psycopg,
        db_expected_func=db_expected,
        ensure_db_expected_is_ready_func=ensure_db_expected_is_ready,
    )