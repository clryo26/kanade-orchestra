#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import psycopg

READ_ONLY_OPTIONS = "-c default_transaction_read_only=on"


@dataclass(frozen=True)
class DatabaseConnectionConfig:
    prod_url: str
    test_url: str
    prod_database: str
    test_database: str
    connect_timeout: int


def _positive_int(value: str, field_name: str) -> int:
    try:
        parsed = int(value.strip())
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an integer") from exc
    if parsed <= 0:
        raise ValueError(f"{field_name} must be greater than zero")
    return parsed


def _required(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name} is required")
    return normalized


def read_config(argv: list[str] | None = None) -> DatabaseConnectionConfig:
    parser = argparse.ArgumentParser(description="Verify prod/test database read-only connections.")
    parser.add_argument(
        "--prod-db-direct-url", default=os.getenv("PROD_DB_DIRECT_URL", "")
    )
    parser.add_argument(
        "--test-db-direct-url", default=os.getenv("TEST_DB_DIRECT_URL", "")
    )
    parser.add_argument("--db-name-prod", default=os.getenv("DB_NAME_PROD", ""))
    parser.add_argument("--db-name-test", default=os.getenv("DB_NAME_TEST", ""))
    parser.add_argument(
        "--db-connect-timeout", default=os.getenv("DB_CONNECT_TIMEOUT", "10")
    )
    args = parser.parse_args(argv)

    prod_database = _required(args.db_name_prod, "DB_NAME_PROD")
    test_database = _required(args.db_name_test, "DB_NAME_TEST")
    if prod_database == test_database:
        raise ValueError("DB_NAME_PROD and DB_NAME_TEST must be different")

    return DatabaseConnectionConfig(
        prod_url=_required(args.prod_db_direct_url, "PROD_DB_DIRECT_URL"),
        test_url=_required(args.test_db_direct_url, "TEST_DB_DIRECT_URL"),
        prod_database=prod_database,
        test_database=test_database,
        connect_timeout=_positive_int(args.db_connect_timeout, "DB_CONNECT_TIMEOUT"),
    )


def _verify_database(
    config: DatabaseConnectionConfig,
    database_url: str,
    database: str,
    connect_fn: Callable[..., Any],
) -> None:
    # Enforce read-only mode in the startup packet, before any verification SQL runs.
    connection = connect_fn(
        database_url,
        connect_timeout=config.connect_timeout,
        options=READ_ONLY_OPTIONS,
    )
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("SHOW transaction_read_only")
            if str(cursor.fetchone()[0]).lower() != "on":
                raise RuntimeError(f"read-only mode is not enabled for {database}")

            cursor.execute("SELECT current_database()")
            if cursor.fetchone()[0] != database:
                raise RuntimeError(f"connected database does not match expected {database}")

            cursor.execute("SELECT 1")
            if cursor.fetchone()[0] != 1:
                raise RuntimeError(f"health check failed for {database}")
        finally:
            cursor.close()
    finally:
        # Never commit this operational check, even though every connection is read-only.
        try:
            connection.rollback()
        finally:
            connection.close()


def verify_prod_test_connections(
    config: DatabaseConnectionConfig,
    connect_fn: Callable[..., Any] | None = None,
) -> None:
    connector = connect_fn or psycopg.connect
    _verify_database(config, config.prod_url, config.prod_database, connector)
    _verify_database(config, config.test_url, config.test_database, connector)


def main(argv: list[str] | None = None) -> int:
    try:
        config = read_config(argv)
        verify_prod_test_connections(config)
    except Exception as exc:
        # Exception details can contain connection parameters; report only the safe type.
        print(
            f"[FAIL] prod/test database connection verification failed ({type(exc).__name__})",
            file=sys.stderr,
        )
        return 1

    print("[PASS] prod/test database read-only connections verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
