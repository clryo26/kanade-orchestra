#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict, deque
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg import sql

from scripts.sync_prod_to_test_preflight import EXCLUDED_DB_TABLES, TARGET_DB_TABLES


APPLICATION_NAME_PROD = "kanade-prod-to-test-db-source"
APPLICATION_NAME_TEST = "kanade-prod-to-test-db-target"


@dataclass(frozen=True)
class DbSyncConfig:
    host: str
    port: int
    prod_database: str
    test_database: str
    prod_user: str
    test_user: str
    password: str
    connect_timeout: int


@dataclass(frozen=True)
class ForeignKey:
    name: str
    child_table: str
    child_columns: tuple[str, ...]
    parent_table: str
    parent_columns: tuple[str, ...]


@dataclass(frozen=True)
class TableSpec:
    name: str
    columns: tuple[str, ...]
    primary_key: tuple[str, ...]
    sequence_columns: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class SyncResult:
    source_counts: dict[str, int]
    target_counts: dict[str, int]
    insert_order: tuple[str, ...]


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


def read_config(argv: list[str] | None = None) -> DbSyncConfig:
    parser = argparse.ArgumentParser(
        description="Synchronize the approved production DB tables to the test DB."
    )
    parser.add_argument("--db-host", default=os.getenv("DB_HOST", "127.0.0.1"))
    parser.add_argument("--db-port", default=os.getenv("DB_PORT", "5432"))
    parser.add_argument("--db-name-prod", default=os.getenv("DB_NAME_PROD", ""))
    parser.add_argument("--db-name-test", default=os.getenv("DB_NAME_TEST", ""))
    parser.add_argument("--db-user-prod", default=os.getenv("DB_USER_PROD", ""))
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

    return DbSyncConfig(
        host=_required(args.db_host, "DB_HOST"),
        port=_positive_int(args.db_port, "DB_PORT"),
        prod_database=prod_database,
        test_database=test_database,
        prod_user=_required(args.db_user_prod, "DB_USER_PROD"),
        test_user=_required(args.db_user_test, "DB_USER_TEST"),
        password=_required(args.db_password, "DB_PASSWORD"),
        connect_timeout=_positive_int(args.db_connect_timeout, "DB_CONNECT_TIMEOUT"),
    )


def dependency_order(tables: Sequence[str], foreign_keys: Iterable[ForeignKey]) -> tuple[str, ...]:
    """Return a stable parent-before-child order and reject dependency cycles."""

    table_set = set(tables)
    children: dict[str, set[str]] = defaultdict(set)
    indegree = {table: 0 for table in tables}
    for foreign_key in foreign_keys:
        parent = foreign_key.parent_table
        child = foreign_key.child_table
        if parent not in table_set or child not in table_set or parent == child:
            continue
        if child not in children[parent]:
            children[parent].add(child)
            indegree[child] += 1

    position = {table: index for index, table in enumerate(tables)}
    ready = deque(sorted((table for table, degree in indegree.items() if degree == 0), key=position.get))
    result: list[str] = []
    while ready:
        parent = ready.popleft()
        result.append(parent)
        for child in sorted(children[parent], key=position.get):
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(child)

    if len(result) != len(tables):
        unresolved = sorted(table for table, degree in indegree.items() if degree)
        raise RuntimeError(f"target table foreign-key dependency cycle: {', '.join(unresolved)}")
    return tuple(result)


def _connect_kwargs(config: DbSyncConfig, *, production: bool) -> dict[str, Any]:
    return {
        "host": config.host,
        "port": config.port,
        "dbname": config.prod_database if production else config.test_database,
        "user": config.prod_user if production else config.test_user,
        "password": config.password,
        "connect_timeout": config.connect_timeout,
        "application_name": APPLICATION_NAME_PROD if production else APPLICATION_NAME_TEST,
        **({"options": "-c default_transaction_read_only=on"} if production else {}),
    }


def _assert_connected_database(cursor: Any, expected_database: str) -> None:
    cursor.execute("SELECT current_database()")
    row = cursor.fetchone()
    if not row or row[0] != expected_database:
        raise RuntimeError(f"connected database does not match expected database {expected_database}")


def _existing_tables(cursor: Any) -> set[str]:
    cursor.execute(
        """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        """
    )
    return {row[0] for row in cursor.fetchall()}


def _table_spec(cursor: Any, table_name: str) -> TableSpec:
    cursor.execute(
        """
        SELECT column_name, is_generated
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
        ORDER BY ordinal_position
        """,
        (table_name,),
    )
    columns = tuple(row[0] for row in cursor.fetchall() if row[1] != "ALWAYS")
    if not columns:
        raise RuntimeError(f"target table has no insertable columns: {table_name}")

    cursor.execute(
        """
        SELECT a.attname
        FROM pg_constraint c
        JOIN unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON TRUE
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
        WHERE c.contype = 'p' AND c.conrelid = %s::regclass
        ORDER BY key.ordinality
        """,
        (f"public.{table_name}",),
    )
    primary_key = tuple(row[0] for row in cursor.fetchall())
    if not primary_key:
        raise RuntimeError(f"target table has no primary key: {table_name}")

    sequence_columns: list[tuple[str, str]] = []
    for column in columns:
        cursor.execute("SELECT pg_get_serial_sequence(%s, %s)", (f"public.{table_name}", column))
        sequence_row = cursor.fetchone()
        if sequence_row and sequence_row[0]:
            sequence_columns.append((column, sequence_row[0]))
    return TableSpec(table_name, columns, primary_key, tuple(sequence_columns))


def _foreign_keys(cursor: Any) -> tuple[ForeignKey, ...]:
    cursor.execute(
        """
        SELECT c.conname,
               child.relname,
               array_agg(child_col.attname ORDER BY child_key.ordinality),
               parent.relname,
               array_agg(parent_col.attname ORDER BY child_key.ordinality)
        FROM pg_constraint c
        JOIN pg_class child ON child.oid = c.conrelid
        JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
        JOIN pg_class parent ON parent.oid = c.confrelid
        JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
        JOIN unnest(c.conkey) WITH ORDINALITY AS child_key(attnum, ordinality) ON TRUE
        JOIN unnest(c.confkey) WITH ORDINALITY AS parent_key(attnum, ordinality)
          ON parent_key.ordinality = child_key.ordinality
        JOIN pg_attribute child_col
          ON child_col.attrelid = c.conrelid AND child_col.attnum = child_key.attnum
        JOIN pg_attribute parent_col
          ON parent_col.attrelid = c.confrelid AND parent_col.attnum = parent_key.attnum
        WHERE c.contype = 'f'
          AND child_ns.nspname = 'public'
          AND parent_ns.nspname = 'public'
        GROUP BY c.conname, child.relname, parent.relname
        ORDER BY child.relname, c.conname
        """
    )
    return tuple(
        ForeignKey(row[0], row[1], tuple(row[2]), row[3], tuple(row[4]))
        for row in cursor.fetchall()
    )


def _excluded_fingerprints(cursor: Any, existing_tables: set[str]) -> dict[str, tuple[int, str]]:
    fingerprints: dict[str, tuple[int, str]] = {}
    for table_name in EXCLUDED_DB_TABLES:
        if table_name not in existing_tables:
            continue
        query = sql.SQL(
            "SELECT count(*), md5(COALESCE(string_agg(row_hash, '' ORDER BY row_hash), '')) "
            "FROM (SELECT md5(row_to_json(t)::text) AS row_hash FROM {} AS t) AS rows"
        ).format(sql.Identifier(table_name))
        cursor.execute(query)
        row = cursor.fetchone()
        fingerprints[table_name] = (int(row[0]), str(row[1]))
    return fingerprints


def _fetch_source_rows(cursor: Any, spec: TableSpec) -> list[tuple[Any, ...]]:
    query = sql.SQL("SELECT {} FROM {}").format(
        sql.SQL(", ").join(map(sql.Identifier, spec.columns)),
        sql.Identifier(spec.name),
    )
    cursor.execute(query)
    return list(cursor.fetchall())


def _upsert_rows(cursor: Any, spec: TableSpec, rows: list[tuple[Any, ...]]) -> None:
    if not rows:
        return
    update_columns = tuple(column for column in spec.columns if column not in spec.primary_key)
    conflict_action = sql.SQL("DO NOTHING")
    if update_columns:
        assignments = sql.SQL(", ").join(
            sql.SQL("{} = EXCLUDED.{}").format(sql.Identifier(column), sql.Identifier(column))
            for column in update_columns
        )
        conflict_action = sql.SQL("DO UPDATE SET {} ").format(assignments)
    query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) {}").format(
        sql.Identifier(spec.name),
        sql.SQL(", ").join(map(sql.Identifier, spec.columns)),
        sql.SQL(", ").join(sql.Placeholder() for _ in spec.columns),
        sql.SQL(", ").join(map(sql.Identifier, spec.primary_key)),
        conflict_action,
    )
    cursor.executemany(query, rows)


def _delete_rows_absent_from_source(
    cursor: Any, spec: TableSpec, source_rows: list[tuple[Any, ...]]
) -> None:
    primary_key_indexes = tuple(spec.columns.index(column) for column in spec.primary_key)
    source_keys = [tuple(row[index] for index in primary_key_indexes) for row in source_rows]
    if not source_keys:
        cursor.execute(sql.SQL("DELETE FROM {}").format(sql.Identifier(spec.name)))
        return

    key_rows = sql.SQL(", ").join(
        sql.SQL("({})").format(sql.SQL(", ").join(sql.Placeholder() for _ in spec.primary_key))
        for _ in source_keys
    )
    match = sql.SQL(" AND ").join(
        sql.SQL("source.{} IS NOT DISTINCT FROM target.{}").format(
            sql.Identifier(column), sql.Identifier(column)
        )
        for column in spec.primary_key
    )
    query = sql.SQL(
        "DELETE FROM {table} AS target WHERE NOT EXISTS "
        "(SELECT 1 FROM (VALUES {values}) AS source ({keys}) WHERE {match})"
    ).format(
        table=sql.Identifier(spec.name),
        values=key_rows,
        keys=sql.SQL(", ").join(map(sql.Identifier, spec.primary_key)),
        match=match,
    )
    cursor.execute(query, tuple(value for key in source_keys for value in key))


def _reset_sequences(cursor: Any, spec: TableSpec) -> None:
    for column, sequence_name in spec.sequence_columns:
        query = sql.SQL("SELECT max({}) FROM {}").format(
            sql.Identifier(column), sql.Identifier(spec.name)
        )
        cursor.execute(query)
        maximum = cursor.fetchone()[0]
        cursor.execute(
            "SELECT setval(%s::regclass, %s, %s)",
            (sequence_name, maximum if maximum is not None else 1, maximum is not None),
        )


def _count_rows(cursor: Any, table_name: str) -> int:
    cursor.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table_name)))
    return int(cursor.fetchone()[0])


def _assert_foreign_keys_valid(cursor: Any, foreign_keys: Iterable[ForeignKey]) -> None:
    for foreign_key in foreign_keys:
        non_null = sql.SQL(" AND ").join(
            sql.SQL("child.{} IS NOT NULL").format(sql.Identifier(column))
            for column in foreign_key.child_columns
        )
        match = sql.SQL(" AND ").join(
            sql.SQL("parent.{} = child.{}").format(
                sql.Identifier(parent_column), sql.Identifier(child_column)
            )
            for child_column, parent_column in zip(
                foreign_key.child_columns, foreign_key.parent_columns, strict=True
            )
        )
        query = sql.SQL(
            "SELECT EXISTS (SELECT 1 FROM {child} AS child WHERE {non_null} "
            "AND NOT EXISTS (SELECT 1 FROM {parent} AS parent WHERE {match}))"
        ).format(
            child=sql.Identifier(foreign_key.child_table),
            non_null=non_null,
            parent=sql.Identifier(foreign_key.parent_table),
            match=match,
        )
        cursor.execute(query)
        if cursor.fetchone()[0]:
            raise RuntimeError(f"foreign-key validation failed: {foreign_key.name}")


def synchronize_databases(
    config: DbSyncConfig,
    connect_fn: Callable[..., Any] | None = None,
) -> SyncResult:
    connector = connect_fn or psycopg.connect
    prod_connection = connector(**_connect_kwargs(config, production=True))
    test_connection = None
    try:
        prod_cursor = prod_connection.cursor()
        try:
            # Take every source table from one consistent, read-only snapshot.
            prod_cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            _assert_connected_database(prod_cursor, config.prod_database)
            prod_tables = _existing_tables(prod_cursor)
            missing_prod = sorted(set(TARGET_DB_TABLES) - prod_tables)
            if missing_prod:
                raise RuntimeError(
                    f"production database is missing required tables: {', '.join(missing_prod)}"
                )
            prod_specs = {table: _table_spec(prod_cursor, table) for table in TARGET_DB_TABLES}
            source_rows = {
                table: _fetch_source_rows(prod_cursor, prod_specs[table]) for table in TARGET_DB_TABLES
            }
            source_counts = {table: len(source_rows[table]) for table in TARGET_DB_TABLES}

            test_connection = connector(**_connect_kwargs(config, production=False))
            test_cursor = test_connection.cursor()
            try:
                _assert_connected_database(test_cursor, config.test_database)
                test_tables = _existing_tables(test_cursor)
                missing_test = sorted(set(TARGET_DB_TABLES) - test_tables)
                if missing_test:
                    raise RuntimeError(
                        f"test database is missing required tables: {', '.join(missing_test)}"
                    )
                test_specs = {table: _table_spec(test_cursor, table) for table in TARGET_DB_TABLES}
                for table in TARGET_DB_TABLES:
                    if prod_specs[table].columns != test_specs[table].columns:
                        raise RuntimeError(f"source/target column mismatch: {table}")
                    if prod_specs[table].primary_key != test_specs[table].primary_key:
                        raise RuntimeError(f"source/target primary-key mismatch: {table}")

                foreign_keys = _foreign_keys(test_cursor)
                order = dependency_order(TARGET_DB_TABLES, foreign_keys)
                excluded_before = _excluded_fingerprints(test_cursor, test_tables)

                # Keep rows with matching primary keys in place. This avoids ON DELETE
                # side effects in excluded audit/access tables while making target data exact.
                for table in order:
                    _upsert_rows(test_cursor, test_specs[table], source_rows[table])
                for table in reversed(order):
                    _delete_rows_absent_from_source(
                        test_cursor, test_specs[table], source_rows[table]
                    )
                for table in order:
                    _reset_sequences(test_cursor, test_specs[table])

                target_counts = {table: _count_rows(test_cursor, table) for table in TARGET_DB_TABLES}
                if target_counts != source_counts:
                    mismatches = [
                        f"{table}: source={source_counts[table]} target={target_counts[table]}"
                        for table in TARGET_DB_TABLES
                        if source_counts[table] != target_counts[table]
                    ]
                    raise RuntimeError(f"row-count validation failed: {'; '.join(mismatches)}")

                relevant_foreign_keys = tuple(
                    foreign_key
                    for foreign_key in foreign_keys
                    if foreign_key.child_table in TARGET_DB_TABLES
                    or foreign_key.parent_table in TARGET_DB_TABLES
                )
                _assert_foreign_keys_valid(test_cursor, relevant_foreign_keys)
                excluded_after = _excluded_fingerprints(test_cursor, test_tables)
                if excluded_after != excluded_before:
                    raise RuntimeError("excluded database tables changed during synchronization")

                test_connection.commit()
                return SyncResult(source_counts, target_counts, order)
            except Exception:
                test_connection.rollback()
                raise
            finally:
                test_cursor.close()
        finally:
            prod_connection.rollback()
            prod_cursor.close()
    finally:
        if test_connection is not None:
            test_connection.close()
        prod_connection.close()


def main(argv: list[str] | None = None) -> int:
    try:
        result = synchronize_databases(read_config(argv))
    except Exception as exc:
        # Connection parameters and credentials must never be emitted.
        print(f"[FAIL] production-to-test DB synchronization failed: {exc}", file=sys.stderr)
        return 1

    total_rows = sum(result.target_counts.values())
    print(
        f"[PASS] production-to-test DB synchronization completed: "
        f"{len(result.target_counts)} tables, {total_rows} rows"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
