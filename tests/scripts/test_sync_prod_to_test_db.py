from __future__ import annotations

import pytest

import scripts.sync_prod_to_test_db as sync_module
from scripts.sync_prod_to_test_db import (
    APPLICATION_NAME_PROD,
    APPLICATION_NAME_TEST,
    DbSyncConfig,
    ForeignKey,
    TableSpec,
    _connect_kwargs,
    dependency_order,
    read_config,
    synchronize_databases,
)
from scripts.sync_prod_to_test_preflight import EXCLUDED_DB_TABLES, TARGET_DB_TABLES


def config() -> DbSyncConfig:
    return DbSyncConfig(
        host="127.0.0.1",
        port=5432,
        prod_database="kanade_portal",
        test_database="kanade_portal_test",
        prod_user="prod_reader",
        test_user="test_writer",
        password="secret",
        connect_timeout=10,
    )


def test_read_config_rejects_same_database() -> None:
    with pytest.raises(ValueError, match="must be different"):
        read_config(
            [
                "--db-name-prod",
                "same",
                "--db-name-test",
                "same",
                "--db-user-prod",
                "prod_reader",
                "--db-user-test",
                "test_writer",
                "--db-password",
                "secret",
            ]
        )


def test_production_connection_is_read_only_and_databases_are_separate() -> None:
    prod = _connect_kwargs(config(), production=True)
    test = _connect_kwargs(config(), production=False)

    assert prod["dbname"] == "kanade_portal"
    assert prod["user"] == "prod_reader"
    assert prod["application_name"] == APPLICATION_NAME_PROD
    assert prod["options"] == "-c default_transaction_read_only=on"
    assert test["dbname"] == "kanade_portal_test"
    assert test["user"] == "test_writer"
    assert test["application_name"] == APPLICATION_NAME_TEST
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

    result = synchronize_databases(config(), lambda **_: next(connections))

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

    with pytest.raises(RuntimeError, match="row-count validation failed"):
        synchronize_databases(config(), lambda **_: next(connections))

    assert test_connection.committed is False
    assert test_connection.rolled_back is True
    assert prod_connection.rolled_back is True
    assert prod_connection.closed is True
    assert test_connection.closed is True
