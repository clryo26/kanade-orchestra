from __future__ import annotations

from typing import cast

try:
    import psycopg
    from psycopg import sql as psql
except Exception:  # pragma: no cover - optional dependency guard
    psycopg = None
    psql = None

from ..core.database import assert_db_ready as _assert_db_ready
from ..core.database import db_connection_string as _db_connection_string
from ..core.database import db_configured as _db_configured
from ..core.database import run_startup_self_check as _run_startup_self_check
from ..core.db_runtime import db_expected as _db_expected
from ..core.db_runtime import ensure_db_expected_is_ready as _ensure_db_expected_is_ready
from ..core.db_runtime import local_json_fallback_enabled as _local_json_fallback_enabled


def assert_db_ready() -> None:
    _assert_db_ready(psycopg, psql)


def db_connection_string() -> str:
    return cast(str, _db_connection_string())


def db_data_enabled() -> bool:
    return cast(bool, _db_configured(psycopg, psql))


def db_expected() -> bool:
    return cast(bool, _db_expected(_local_json_fallback_enabled))


def _ensure_db_expected_ready() -> None:
    _ensure_db_expected_is_ready(db_expected, db_data_enabled)


def run_db_startup_self_check() -> None:
    from ..core.db_runtime import ensure_db_schema_compatibility as _ensure_db_schema_compatibility

    _run_startup_self_check(
        assert_db_ready_func=assert_db_ready,
        db_connection_string_func=db_connection_string,
        ensure_db_schema_compatibility_func=_ensure_db_schema_compatibility,
        psycopg_module=psycopg,
        db_expected_func=db_expected,
        ensure_db_expected_is_ready_func=_ensure_db_expected_ready,
    )

__all__ = [
    "assert_db_ready",
    "db_connection_string",
    "db_data_enabled",
    "db_expected",
    "run_db_startup_self_check",
]
