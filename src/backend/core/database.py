from __future__ import annotations

from typing import Any

from .db_config import assert_db_ready as _assert_db_ready
from .db_config import db_connection_string as _db_connection_string
from .db_config import mask_db_value as _mask_db_value
from .db_runtime import db_data_enabled as _db_data_enabled

def db_configured(psycopg_module: Any, psql_module: Any) -> bool:
    return _db_data_enabled(psycopg_module, psql_module)


def db_connection_string() -> str:
    return _db_connection_string()


def mask_db_value(column_name: str, value: Any) -> Any:
    return _mask_db_value(column_name, value)


def assert_db_ready(psycopg_module: Any, psql_module: Any) -> None:
    _assert_db_ready(psycopg_module, psql_module)


def run_startup_self_check(assert_db_ready_func: Any, db_connection_string_func: Any, ensure_db_schema_compatibility_func: Any, psycopg_module: Any, db_expected_func: Any, ensure_db_expected_is_ready_func: Any) -> None:
    from .db_runtime import run_db_startup_self_check as _run_db_startup_self_check

    _run_db_startup_self_check(
        db_expected_func=db_expected_func,
        ensure_db_expected_is_ready_func=ensure_db_expected_is_ready_func,
        assert_db_ready_func=assert_db_ready_func,
        psycopg=psycopg_module,
        db_connection_string_func=db_connection_string_func,
        ensure_db_schema_compatibility_func=ensure_db_schema_compatibility_func,
    )
