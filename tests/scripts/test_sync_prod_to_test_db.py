from __future__ import annotations

import pytest
from psycopg.types.json import Json, Jsonb

import scripts.sync_prod_to_test_db as sync_module
from scripts.sync_prod_to_test_db import (
    APPLICATION_NAME_PROD,
    APPLICATION_NAME_TEST,
    DbSyncConfig,
    ForeignKey,
    TableSpec,
    _connect_kwargs,
    _table_spec,
    _upsert_rows,
    dependency_order,
    read_config,
    synchronize_databases,
)
from scripts.sync_prod_to_test_preflight import EXCLUDED_DB_TABLES, TARGET_DB_TABLES


def config() -> DbSyncConfig:
    return DbSyncConfig(
        prod_url="postgresql://prod_reader:prod_secret@prod.example/kanade_portal?sslmode=require",
        test_url="postgresql://test_writer:test_secret@test.example/kanade_portal_test?sslmode=require",
        prod_database="kanade_portal",
        test_database="kanade_portal_test",
        connect_timeout=10,
    )


def test_read_config_rejects_same_database() -> None:
    with pytest.raises(ValueError, match="must be different"):
        read_config(
            [
                "--prod-db-direct-url",
                "postgresql://prod.example/same",
                "--test-db-direct-url",
                "postgresql://test.example/same",
                "--db-name-prod",
                "same",
                "--db-name-test",
                "same",
            ]
        )


def test_production_connection_is_read_only_and_databases_are_separate() -> None:
    prod = _connect_kwargs(config(), production=True)
    test = _connect_kwargs(config(), production=False)

    assert prod["application_name"] == APPLICATION_NAME_PROD
    assert prod["options"] == "-c default_transaction_read_only=on"
    assert prod["connect_timeout"] == 10
    assert test["application_name"] == APPLICATION_NAME_TEST
    assert test["connect_timeout"] == 10
    assert "options" not in test


def test_dependency_order_is_parent_before_child_and_stable() -> None:
    tables = ("members", "performances", "payments", "payment_performance_fees")
    foreign_keys = (
        ForeignKey("payments_member_fk", "payments", ("member_id",), "members", ("id",)),
        ForeignKey(
            "fees_payment_fk",
            "payment_performance_fees",
            ("payment_id",),
            "payments",
            ("id",),
        ),
        ForeignKey(
            "fees_performance_fk",
            "payment_performance_fees",
            ("performance_id",),
            "performances",
            ("id",),
        ),
    )

    order = dependency_order(tables, foreign_keys)

    assert order.index("members") < order.index("payments")
    assert order.index("payments") < order.index("payment_performance_fees")
    assert order.index("performances") < order.index("payment_performance_fees")


def test_dependency_order_rejects_cycle() -> None:
    foreign_keys = (
        ForeignKey("a_b", "a", ("b_id",), "b", ("id",)),
        ForeignKey("b_a", "b", ("a_id",), "a", ("id",)),
    )
    with pytest.raises(RuntimeError, match="dependency cycle"):
        dependency_order(("a", "b"), foreign_keys)


def test_approved_table_policy_is_used_without_expansion() -> None:
    assert len(TARGET_DB_TABLES) == 34
    assert set(TARGET_DB_TABLES).isdisjoint(EXCLUDED_DB_TABLES)
    assert "members" in TARGET_DB_TABLES
    assert "auth_devices" in EXCLUDED_DB_TABLES
    assert "access_logs" in EXCLUDED_DB_TABLES
    assert "audit_logs" in EXCLUDED_DB_TABLES
    assert "portal_json_collections" in EXCLUDED_DB_TABLES


class MetadataCursor:
    def __init__(self) -> None:
        self.query_index = 0

    def execute(self, *_args: object, **_kwargs: object) -> None:
        self.query_index += 1

    def fetchall(self) -> list[tuple[object, ...]]:
        if self.query_index == 1:
            return [
                ("id", "NEVER", "integer"),
                ("payload", "NEVER", "json"),
                ("detail", "NEVER", "jsonb"),
            ]
        if self.query_index == 2:
            return [("id",)]
        return []

    def fetchone(self) -> tuple[None]:
        return (None,)


def test_table_spec_records_json_and_jsonb_columns() -> None:
    spec = _table_spec(MetadataCursor(), "sample")

    assert spec.columns == ("id", "payload", "detail")
    assert spec.json_columns == (("payload", "json"), ("detail", "jsonb"))


class UpsertCursor:
    def __init__(self) -> None:
        self.rows: list[tuple[object, ...]] = []

    def executemany(
        self, _query: object, rows: list[tuple[object, ...]]
    ) -> None:
        self.rows = rows


def test_upsert_adapts_json_values_before_passing_them_to_psycopg() -> None:
    cursor = UpsertCursor()
    spec = TableSpec(
        "sample",
        ("id", "payload", "detail", "note"),
        ("id",),
        (),
        (("payload", "json"), ("detail", "jsonb")),
    )

    _upsert_rows(
        cursor,
        spec,
        [(1, {"enabled": True}, {"items": [1, 2]}, "unchanged")],
    )

    row = cursor.rows[0]
    assert isinstance(row[1], Json)
    assert row[1].obj == {"enabled": True}
    assert isinstance(row[2], Jsonb)
    assert row[2].obj == {"items": [1, 2]}
    assert row[3] == "unchanged"


def test_upsert_preserves_null_json_values() -> None:
    cursor = UpsertCursor()
    spec = TableSpec(
        "sample",
        ("id", "payload"),
        ("id",),
        (),
        (("payload", "jsonb"),),
    )

    _upsert_rows(cursor, spec, [(1, None)])

    assert cursor.rows == [(1, None)]


class FakeCursor:
    def __init__(self) -> None:
        self.closed = False

    def execute(self, *_args: object, **_kwargs: object) -> None:
        return None

    def fetchone(self) -> tuple[str]:
        return ("unused",)

    def close(self) -> None:
        self.closed = True


class FakeConnection:
    def __init__(self) -> None:
        self.fake_cursor = FakeCursor()
        self.committed = False
        self.rolled_back = False
        self.closed = False

    def cursor(self) -> FakeCursor:
        return self.fake_cursor

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True

    def close(self) -> None:
        self.closed = True


def _patch_database_operations(monkeypatch: pytest.MonkeyPatch, *, target_count: int) -> None:
    spec = TableSpec("unused", ("id",), ("id",), ())
    monkeypatch.setattr(sync_module, "TARGET_DB_TABLES", ("members",))
    monkeypatch.setattr(sync_module, "_assert_connected_database", lambda *_: None)
    monkeypatch.setattr(sync_module, "_existing_tables", lambda _: {"members"})
    monkeypatch.setattr(
        sync_module,
        "_table_spec",
        lambda _cursor, table: TableSpec(table, spec.columns, spec.primary_key, ()),
    )
    monkeypatch.setattr(sync_module, "_fetch_source_rows", lambda *_: [(1,)])
    monkeypatch.setattr(sync_module, "_foreign_keys", lambda _: ())
    monkeypatch.setattr(sync_module, "_excluded_fingerprints", lambda *_: {})
    monkeypatch.setattr(sync_module, "_upsert_rows", lambda *_: None)
    monkeypatch.setattr(sync_module, "_delete_rows_absent_from_source", lambda *_: None)
    monkeypatch.setattr(sync_module, "_reset_sequences", lambda *_: None)
    monkeypatch.setattr(sync_module, "_count_rows", lambda *_: target_count)
    monkeypatch.setattr(sync_module, "_assert_foreign_keys_valid", lambda *_: None)


def test_sync_commits_only_after_all_validations(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_database_operations(monkeypatch, target_count=1)
    prod_connection = FakeConnection()
    test_connection = FakeConnection()
    connections = iter((prod_connection, test_connection))
    captured_urls: list[str] = []

    def connect_fn(database_url: str, **_kwargs: object) -> FakeConnection:
        captured_urls.append(database_url)
        return next(connections)

    result = synchronize_databases(config(), connect_fn)

    assert captured_urls == [config().prod_url, config().test_url]

    assert result.source_counts == {"members": 1}
    assert result.target_counts == {"members": 1}
    assert test_connection.committed is True
    assert test_connection.rolled_back is False
    assert prod_connection.rolled_back is True
    assert prod_connection.closed is True
    assert test_connection.closed is True


def test_sync_rolls_back_all_test_changes_on_validation_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_database_operations(monkeypatch, target_count=0)
    prod_connection = FakeConnection()
    test_connection = FakeConnection()
    connections = iter((prod_connection, test_connection))

    def connect_fn(_database_url: str, **_kwargs: object) -> FakeConnection:
        return next(connections)

    with pytest.raises(RuntimeError, match="row-count validation failed"):
        synchronize_databases(config(), connect_fn)

    assert test_connection.committed is False
    assert test_connection.rolled_back is True
    assert prod_connection.rolled_back is True
    assert prod_connection.closed is True
    assert test_connection.closed is True



def test_main_redacts_cli_database_urls(monkeypatch, capsys) -> None:
    prod_url = (
        "postgresql://prod_reader:prod_secret@prod.example/"
        "kanade_portal?sslmode=require"
    )
    test_url = (
        "postgresql://test_writer:test_secret@test.example/"
        "kanade_portal_test?sslmode=require"
    )
    monkeypatch.delenv("PROD_DB_DIRECT_URL", raising=False)
    monkeypatch.delenv("TEST_DB_DIRECT_URL", raising=False)

    def fail(_config):
        raise ConnectionError(
            f"connections failed: prod={prod_url} test={test_url} "
            "passwords=prod_secret,test_secret"
        )

    monkeypatch.setattr(sync_module, "synchronize_databases", fail)

    argv = [
        "--prod-db-direct-url",
        prod_url,
        "--test-db-direct-url",
        test_url,
        "--db-name-prod",
        "kanade_portal",
        "--db-name-test",
        "kanade_portal_test",
    ]

    assert sync_module.main(argv) == 1
    captured = capsys.readouterr()
    assert prod_url not in captured.err
    assert test_url not in captured.err
    assert "prod_secret" not in captured.err
    assert "test_secret" not in captured.err
    assert "***" in captured.err
