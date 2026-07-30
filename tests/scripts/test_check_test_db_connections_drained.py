from __future__ import annotations

import pytest

from scripts.check_test_db_connections_drained import (
    APPLICATION_NAME,
    ConnectionsNotDrainedError,
    DatabaseNameMismatchError,
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


class FakeClock:
    def __init__(self) -> None:
        self.current = 0.0
        self.sleep_calls: list[float] = []

    def monotonic(self) -> float:
        return self.current

    def sleep(self, seconds: float) -> None:
        self.sleep_calls.append(seconds)
        self.current += seconds


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


def test_connection_check_ignores_neon_internal_pgbouncer_session() -> None:
    internal_pgbouncer_row = (
        674,
        "neondb_owner",
        "pgbouncer",
        "::1/128",
        "idle",
        "client backend",
    )
    cursor = FakeCursor("kanade_portal_test", [internal_pgbouncer_row])
    connection = FakeConnection(cursor)

    result = find_other_test_database_connections(
        config(), lambda _database_url, **_: connection
    )

    assert result == []


def test_connection_check_keeps_non_internal_pgbouncer_session() -> None:
    external_pgbouncer_row = (
        675,
        "neondb_owner",
        "pgbouncer",
        "203.0.113.10/32",
        "idle",
        "client backend",
    )
    cursor = FakeCursor("kanade_portal_test", [external_pgbouncer_row])
    connection = FakeConnection(cursor)

    result = find_other_test_database_connections(
        config(), lambda _database_url, **_: connection
    )

    assert result == [external_pgbouncer_row]


def test_connection_check_fails_closed_when_another_session_exists() -> None:
    connection_row = (
        123,
        "app",
        "cloud-run",
        "127.0.0.1",
        "idle",
        "client backend",
    )
    clock = FakeClock()

    with pytest.raises(ConnectionsNotDrainedError, match=r"1 other connection\(s\)"):
        assert_test_database_connections_drained(
            config(),
            lambda _database_url, **_: FakeConnection(
                FakeCursor("kanade_portal_test", [connection_row])
            ),
            sleep_fn=clock.sleep,
            monotonic_fn=clock.monotonic,
        )

    assert clock.current == 60
    assert clock.sleep_calls == [5.0] * 12


def test_connection_check_rejects_unexpected_connected_database() -> None:
    cursor = FakeCursor("kanade_portal", [])
    connection = FakeConnection(cursor)

    with pytest.raises(DatabaseNameMismatchError, match="does not match DB_NAME_TEST"):
        find_other_test_database_connections(
            config(), lambda _database_url, **_: connection
        )

    assert connection.rolled_back is True
    assert connection.closed is True


def test_connection_check_retries_then_succeeds_when_connections_drain() -> None:
    connection_results = [
        [(123, "app", "cloud-run", "127.0.0.1", "idle", "client backend")],
        [],
    ]
    clock = FakeClock()

    def connect_fn(_database_url: str, **_: object) -> FakeConnection:
        return FakeConnection(
            FakeCursor("kanade_portal_test", connection_results.pop(0))
        )

    assert_test_database_connections_drained(
        config(),
        connect_fn,
        sleep_fn=clock.sleep,
        monotonic_fn=clock.monotonic,
    )

    assert clock.sleep_calls == [5.0]
    assert connection_results == []


def test_database_name_mismatch_is_not_retried() -> None:
    clock = FakeClock()
    connect_calls = 0

    def connect_fn(_database_url: str, **_: object) -> FakeConnection:
        nonlocal connect_calls
        connect_calls += 1
        return FakeConnection(FakeCursor("kanade_portal", []))

    with pytest.raises(DatabaseNameMismatchError):
        assert_test_database_connections_drained(
            config(),
            connect_fn,
            sleep_fn=clock.sleep,
            monotonic_fn=clock.monotonic,
        )

    assert connect_calls == 1
    assert clock.sleep_calls == []


def test_database_connection_error_is_not_retried() -> None:
    clock = FakeClock()
    connect_calls = 0

    def connect_fn(_database_url: str, **_: object) -> FakeConnection:
        nonlocal connect_calls
        connect_calls += 1
        raise ConnectionError("temporary connection failure")

    with pytest.raises(ConnectionError):
        assert_test_database_connections_drained(
            config(),
            connect_fn,
            sleep_fn=clock.sleep,
            monotonic_fn=clock.monotonic,
        )

    assert connect_calls == 1
    assert clock.sleep_calls == []


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


def test_main_reports_remaining_connection_count_without_credentials(
    monkeypatch, capsys
) -> None:
    import scripts.check_test_db_connections_drained as module

    test_config = config()
    monkeypatch.setattr(module, "read_config", lambda argv: test_config)

    def fail(_config):
        raise ConnectionsNotDrainedError(
            "test database still has 2 other connection(s) after waiting 60 seconds"
        )

    monkeypatch.setattr(module, "assert_test_database_connections_drained", fail)

    assert module.main([]) == 1
    captured = capsys.readouterr()
    assert "2 other connection(s)" in captured.err
    assert test_config.test_url not in captured.err
    assert "test_secret" not in captured.err
