from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


def _load_module():
    path = Path("scripts/verify_prod_test_db_connections.py")
    spec = importlib.util.spec_from_file_location("verify_prod_test_db_for_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeCursor:
    def __init__(self, database, values=None):
        self.database = database
        self.values = values or {}
        self.executed = []
        self.current_query = ""
        self.closed = False

    def execute(self, query):
        self.current_query = query
        self.executed.append(query)

    def fetchone(self):
        defaults = {
            "SHOW transaction_read_only": ("on",),
            "SELECT current_database()": (self.database,),
            "SELECT 1": (1,),
        }
        return self.values.get(self.current_query, defaults[self.current_query])

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, database, values=None):
        self.fake_cursor = FakeCursor(database, values)
        self.rolled_back = False
        self.closed = False

    def cursor(self):
        return self.fake_cursor

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


def _config(module):
    return module.DatabaseConnectionConfig(
        prod_url="postgresql://prod_user:prod_secret@prod.example/kanade_prod?sslmode=require",
        test_url="postgresql://test_user:test_secret@test.example/kanade_test?sslmode=require",
        prod_database="kanade_prod",
        test_database="kanade_test",
        connect_timeout=10,
    )


def _database_for_url(config, database_url):
    if database_url == config.prod_url:
        return config.prod_database
    if database_url == config.test_url:
        return config.test_database
    raise AssertionError(f"unexpected database URL: {database_url}")


def test_verifies_prod_then_test_with_read_only_connections():
    module = _load_module()
    config = _config(module)
    calls = []
    connections = []

    def connect(database_url, **kwargs):
        calls.append((database_url, kwargs))
        connection = FakeConnection(_database_for_url(config, database_url))
        connections.append(connection)
        return connection

    module.verify_prod_test_connections(config, connect)

    assert [database_url for database_url, _ in calls] == [
        config.prod_url,
        config.test_url,
    ]
    assert all(
        kwargs["options"] == "-c default_transaction_read_only=on"
        for _, kwargs in calls
    )
    assert all(kwargs["connect_timeout"] == 10 for _, kwargs in calls)
    assert all(
        connection.fake_cursor.executed
        == ["SHOW transaction_read_only", "SELECT current_database()", "SELECT 1"]
        for connection in connections
    )
    assert all(connection.rolled_back and connection.closed for connection in connections)


@pytest.mark.parametrize(
    ("env_name", "value"),
    [
        ("PROD_DB_DIRECT_URL", ""),
        ("TEST_DB_DIRECT_URL", "   "),
        ("DB_NAME_PROD", ""),
        ("DB_NAME_TEST", "   "),
        ("DB_CONNECT_TIMEOUT", "0"),
        ("DB_CONNECT_TIMEOUT", "not-a-number"),
    ],
)
def test_rejects_invalid_environment_values(monkeypatch, env_name, value):
    module = _load_module()
    values = {
        "PROD_DB_DIRECT_URL": " postgresql://prod.example/kanade_prod ",
        "TEST_DB_DIRECT_URL": " postgresql://test.example/kanade_test ",
        "DB_NAME_PROD": " kanade_prod ",
        "DB_NAME_TEST": " kanade_test ",
        "DB_CONNECT_TIMEOUT": "10",
    }
    values[env_name] = value
    for key, item in values.items():
        monkeypatch.setenv(key, item)

    with pytest.raises(ValueError):
        module.read_config([])


def test_rejects_same_prod_and_test_database(monkeypatch):
    module = _load_module()
    monkeypatch.setenv(
        "PROD_DB_DIRECT_URL",
        "postgresql://prod.example/same_db",
    )
    monkeypatch.setenv(
        "TEST_DB_DIRECT_URL",
        "postgresql://test.example/same_db",
    )
    monkeypatch.setenv("DB_NAME_PROD", " same_db ")
    monkeypatch.setenv("DB_NAME_TEST", "same_db")

    with pytest.raises(ValueError, match="must be different"):
        module.read_config([])


def test_environment_values_are_trimmed(monkeypatch):
    module = _load_module()
    monkeypatch.setenv(
        "PROD_DB_DIRECT_URL",
        " postgresql://prod.example/kanade_prod ",
    )
    monkeypatch.setenv(
        "TEST_DB_DIRECT_URL",
        " postgresql://test.example/kanade_test ",
    )
    monkeypatch.setenv("DB_NAME_PROD", " kanade_prod ")
    monkeypatch.setenv("DB_NAME_TEST", " kanade_test ")
    monkeypatch.setenv("DB_CONNECT_TIMEOUT", " 10 ")

    config = module.read_config([])

    assert config.prod_url == "postgresql://prod.example/kanade_prod"
    assert config.test_url == "postgresql://test.example/kanade_test"
    assert config.prod_database == "kanade_prod"
    assert config.test_database == "kanade_test"
    assert config.connect_timeout == 10


@pytest.mark.parametrize(
    ("query", "value"),
    [
        ("SHOW transaction_read_only", ("off",)),
        ("SELECT current_database()", ("wrong_database",)),
        ("SELECT 1", (0,)),
    ],
)
def test_rejects_failed_database_checks(query, value):
    module = _load_module()
    config = _config(module)

    def connect(database_url, **_kwargs):
        return FakeConnection(
            _database_for_url(config, database_url),
            {query: value},
        )

    with pytest.raises(RuntimeError):
        module.verify_prod_test_connections(config, connect)


@pytest.mark.parametrize("failed_database", ["kanade_prod", "kanade_test"])
def test_connection_failure_fails_the_whole_verification(failed_database):
    module = _load_module()
    config = _config(module)

    def connect(database_url, **_kwargs):
        database = _database_for_url(config, database_url)
        if database == failed_database:
            raise ConnectionError("connection failed")
        return FakeConnection(database)

    with pytest.raises(ConnectionError):
        module.verify_prod_test_connections(config, connect)


def test_main_returns_zero_on_success(monkeypatch, capsys):
    module = _load_module()
    monkeypatch.setattr(module, "read_config", lambda argv: _config(module))
    monkeypatch.setattr(module, "verify_prod_test_connections", lambda config: None)

    assert module.main([]) == 0
    assert "[PASS]" in capsys.readouterr().out


def test_main_returns_one_without_exposing_database_url(monkeypatch, capsys):
    module = _load_module()
    config = _config(module)
    monkeypatch.setattr(module, "read_config", lambda argv: config)

    def fail(_config):
        raise ConnectionError(f"connection failed for {config.prod_url}")

    monkeypatch.setattr(module, "verify_prod_test_connections", fail)

    assert module.main([]) == 1
    captured = capsys.readouterr()
    assert "[FAIL]" in captured.err
    assert config.prod_url not in captured.err
    assert "prod_secret" not in captured.err
