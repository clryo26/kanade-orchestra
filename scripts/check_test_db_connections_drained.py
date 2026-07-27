#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import psycopg


APPLICATION_NAME = "kanade-prod-to-test-drain-check"
CONNECTION_DRAIN_TIMEOUT_SECONDS = 60.0
CONNECTION_DRAIN_RETRY_INTERVAL_SECONDS = 5.0


class DatabaseNameMismatchError(RuntimeError):
    """Raised when the connection is not attached to the configured test DB."""


class ConnectionsNotDrainedError(RuntimeError):
    """Raised when other test database connections remain after the timeout."""


@dataclass(frozen=True)
class DrainCheckConfig:
    test_url: str
    prod_database: str
    test_database: str
    connect_timeout: int


def _required(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name} is required")
    return normalized


def _positive_int(value: str, field_name: str) -> int:
    try:
        parsed = int(value.strip())
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an integer") from exc
    if parsed <= 0:
        raise ValueError(f"{field_name} must be greater than zero")
    return parsed


def read_config(argv: list[str] | None = None) -> DrainCheckConfig:
    parser = argparse.ArgumentParser(
        description="Fail unless the test database has no connections other than this check."
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

    return DrainCheckConfig(
        test_url=_required(args.test_db_direct_url, "TEST_DB_DIRECT_URL"),
        prod_database=prod_database,
        test_database=test_database,
        connect_timeout=_positive_int(args.db_connect_timeout, "DB_CONNECT_TIMEOUT"),
    )


def find_other_test_database_connections(
    config: DrainCheckConfig,
    connect_fn: Callable[..., Any] | None = None,
) -> list[tuple[Any, ...]]:
    connector = connect_fn or psycopg.connect
    connection = connector(
        config.test_url,
        connect_timeout=config.connect_timeout,
        application_name=APPLICATION_NAME,
        options="-c default_transaction_read_only=on",
    )
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("SELECT current_database()")
            if cursor.fetchone()[0] != config.test_database:
                raise DatabaseNameMismatchError(
                    "connected database does not match DB_NAME_TEST"
                )

            # Exclude only this checker connection. Any other session attached to
            # the test database can race with pg_restore and therefore blocks it.
            cursor.execute(
                """
                SELECT pid, usename, application_name, client_addr::text, state, backend_type
                FROM pg_stat_activity
                WHERE datname = %s
                  AND pid <> pg_backend_pid()
                ORDER BY pid
                """,
                (config.test_database,),
            )
            return list(cursor.fetchall())
        finally:
            cursor.close()
    finally:
        try:
            connection.rollback()
        finally:
            connection.close()


def assert_test_database_connections_drained(
    config: DrainCheckConfig,
    connect_fn: Callable[..., Any] | None = None,
    *,
    sleep_fn: Callable[[float], None] = time.sleep,
    monotonic_fn: Callable[[], float] = time.monotonic,
) -> None:
    started_at = monotonic_fn()

    while True:
        connections = find_other_test_database_connections(config, connect_fn)
        if not connections:
            return

        elapsed = monotonic_fn() - started_at
        if elapsed >= CONNECTION_DRAIN_TIMEOUT_SECONDS:
            raise ConnectionsNotDrainedError(
                f"test database still has {len(connections)} other connection(s) "
                "after waiting 60 seconds"
            )

        # Retry only when valid inspection results show that other sessions remain.
        sleep_fn(
            min(
                CONNECTION_DRAIN_RETRY_INTERVAL_SECONDS,
                CONNECTION_DRAIN_TIMEOUT_SECONDS - elapsed,
            )
        )


def main(argv: list[str] | None = None) -> int:
    try:
        config = read_config(argv)
        assert_test_database_connections_drained(config)
    except ConnectionsNotDrainedError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1
    except DatabaseNameMismatchError:
        print(
            "[FAIL] connected database does not match DB_NAME_TEST",
            file=sys.stderr,
        )
        return 1
    except ValueError:
        print("[FAIL] invalid database drain check configuration", file=sys.stderr)
        return 1
    except (psycopg.Error, ConnectionError):
        print("[FAIL] test database connection error", file=sys.stderr)
        return 1
    except Exception as exc:
        # Print only the exception type, never connection parameters or credentials.
        print(
            f"[FAIL] unexpected database drain check failure ({type(exc).__name__})",
            file=sys.stderr,
        )
        return 1

    print("[PASS] test database has no other active connections")
    return 0


if __name__ == "__main__":
    sys.exit(main())
