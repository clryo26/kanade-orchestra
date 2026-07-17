#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import psycopg


APPLICATION_NAME = "kanade-prod-to-test-drain-check"


@dataclass(frozen=True)
class DrainCheckConfig:
    host: str
    port: int
    prod_database: str
    test_database: str
    test_user: str
    password: str
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
    parser.add_argument("--db-host", default=os.getenv("DB_HOST", "127.0.0.1"))
    parser.add_argument("--db-port", default=os.getenv("DB_PORT", "5432"))
    parser.add_argument("--db-name-prod", default=os.getenv("DB_NAME_PROD", ""))
    parser.add_argument("--db-name-test", default=os.getenv("DB_NAME_TEST", ""))
    parser.add_argument("--db-user-test", default=os.getenv("DB_USER_TEST", ""))
    parser.add_argument("--db-password", default=os.getenv("DB_PASSWORD", ""))
    parser.add_argument(
        "--db-connect-timeout", default=os.getenv("DB_CONNECT_TIMEOUT", "10")
    )
    args = parser.parse_args(argv)

    prod_database = _required(args.db_name_prod, "DB_NAME_PROD")
    test_database = _required(args.db_name_test, "DB_NAME_TEST")
    if prod_database == test_database:
        raise ValueError("DB_NAME_PROD and DB_NAME_TEST must be different")

    return DrainCheckConfig(
        host=_required(args.db_host, "DB_HOST"),
        port=_positive_int(args.db_port, "DB_PORT"),
        prod_database=prod_database,
        test_database=test_database,
        test_user=_required(args.db_user_test, "DB_USER_TEST"),
        password=_required(args.db_password, "DB_PASSWORD"),
        connect_timeout=_positive_int(args.db_connect_timeout, "DB_CONNECT_TIMEOUT"),
    )


def find_other_test_database_connections(
    config: DrainCheckConfig,
    connect_fn: Callable[..., Any] | None = None,
) -> list[tuple[Any, ...]]:
    connector = connect_fn or psycopg.connect
    connection = connector(
        host=config.host,
        port=config.port,
        dbname=config.test_database,
        user=config.test_user,
        password=config.password,
        connect_timeout=config.connect_timeout,
        application_name=APPLICATION_NAME,
        options="-c default_transaction_read_only=on",
    )
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("SELECT current_database()")
            if cursor.fetchone()[0] != config.test_database:
                raise RuntimeError("connected database does not match DB_NAME_TEST")

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
) -> None:
    connections = find_other_test_database_connections(config, connect_fn)
    if connections:
        raise RuntimeError(
            f"test database still has {len(connections)} other connection(s)"
        )


def main(argv: list[str] | None = None) -> int:
    try:
        config = read_config(argv)
        assert_test_database_connections_drained(config)
    except Exception as exc:
        # Do not print connection parameters or database credentials.
        print(
            f"[FAIL] test database connection drain check failed: {exc}",
            file=sys.stderr,
        )
        return 1

    print("[PASS] test database has no other active connections")
    return 0


if __name__ == "__main__":
    sys.exit(main())
