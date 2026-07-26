from __future__ import annotations

import pytest

from scripts.check_test_db_connections_drained import (
    APPLICATION_NAME,
    DrainCheckConfig,
    assert_test_database_connections_drained,
    find_other_test_database_connections,
    read_config,
)


class FakeCursor:
    def __init__(self, database: str, connections: list[tuple[object, ...]]) -> None:
        self.database = database
        self.connections = connections
        self.execute_calls: list[tuple[object, object]] = []
        self._current_result = ""
        self.closed = False

    def execute(self, query: object, params: object = None) -> None:
        self.execute_calls.append((query, params))
        self._current_result = "database" if "current_database" in str(query) else "connections"

    def fetchone(self) -> tuple[str]:
        assert self._current_result == "database"
        return (self.database,)

    def fetchall(self) -> list[tuple[object, ...]]:
        assert self._current_result == "connections"
        return self.connections

    def close(self) -> None:
        self.closed = True


class FakeConnection:
    def __init__(self, cursor: FakeCursor) -> None:
        self.fake_cursor = cursor
        self.rolled_back = False
        self.closed = False

    def cursor(self) -> FakeCursor:
        return self.fake_cursor

    def rollback(self) -> None:
        self.rolled_back = True

    def close(self) -> None:
        self.closed = True


def config() -> DrainCheckConfig:
    return DrainCheckConfig(
        test_url="postgresql://test_user:test_secret@test.example/kanade_portal_test?sslmode=require",
        prod_database="kanade_portal",
        test_database="kanade_portal_test",
        connect_timeout=10,
    )


def test_read_config_rejects_same_prod_and_test_database() -> None:
    with pytest.raises(ValueError, match="must be different"):
        read_config(
            [
                "--test-db-direct-url",
                "postgresql://test.example/same",
                "--db-name-prod",
                "same",
                "--db-name-test",
                "same",
            ]
        )


def test_connection_check_excludes_only_its_own_backend() -> None:
    cursor = FakeCursor("kanade_portal_test", [])
    connection = FakeConnection(cursor)
    captured: dict[str, object] = {}

    def connect_fn(database_url: str, **kwargs: object) -> FakeConnection:
        captured["database_url"] = database_url
        captured.update(kwargs)
        return connection

    result = find_other_test_database_connections(config(), connect_fn)

    assert result == []
    assert captured["database_url"] == config().test_url
    assert captured["application_name"] == APPLICATION_NAME
    assert captured["options"] == "-c default_transaction_read_only=on"
    activity_query, activity_params = cursor.execute_calls[1]
    assert "pid <> pg_backend_pid()" in str(activity_query)
    assert activity_params == ("kanade_portal_test",)
    assert connection.rolled_back is True
    assert connection.closed is True
    assert cursor.closed is True


def test_connection_check_fails_closed_when_another_session_exists() -> None:
    cursor = FakeCursor(
        "kanade_portal_test",
        [(123, "app", "cloud-run", "127.0.0.1", "idle", "client backend")],
    )
    connection = FakeConnection(cursor)

    with pytest.raises(RuntimeError, match=r"1 other connection\(s\)"):
        assert_test_database_connections_drained(
            config(), lambda _database_url, **_: connection
        )


def test_connection_check_rejects_unexpected_connected_database() -> None:
    cursor = FakeCursor("kanade_portal", [])
    connection = FakeConnection(cursor)

    with pytest.raises(RuntimeError, match="does not match DB_NAME_TEST"):
        find_other_test_database_connections(
            config(), lambda _database_url, **_: connection
        )

    assert connection.rolled_back is True
    assert connection.closed is True


def test_main_returns_one_without_exposing_database_url(monkeypatch, capsys) -> None:
    import scripts.check_test_db_connections_drained as module

    test_config = config()
    monkeypatch.setattr(module, "read_config", lambda argv: test_config)

    def fail(_config):
        raise ConnectionError(f"connection failed for {test_config.test_url}")

    monkeypatch.setattr(module, "assert_test_database_connections_drained", fail)

    assert module.main([]) == 1
    captured = capsys.readouterr()
    assert "[FAIL]" in captured.err
    assert test_config.test_url not in captured.err
    assert "test_secret" not in captured.err
