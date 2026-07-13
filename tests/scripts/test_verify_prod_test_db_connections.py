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
        host="127.0.0.1",
        port=5432,
        prod_database="kanade_prod",
        test_database="kanade_test",
        prod_user="prod_reader",
        test_user="test_reader",
        password="do-not-print-this-password",
        connect_timeout=10,
    )


def test_verifies_prod_then_test_with_read_only_connections():
    module = _load_module()
    calls = []
    connections = []

    def connect(**kwargs):
        calls.append(kwargs)
        connection = FakeConnection(kwargs["dbname"])
        connections.append(connection)
        return connection

    module.verify_prod_test_connections(_config(module), connect)

    assert [call["dbname"] for call in calls] == ["kanade_prod", "kanade_test"]
    assert [call["user"] for call in calls] == ["prod_reader", "test_reader"]
    assert all(call["options"] == "-c default_transaction_read_only=on" for call in calls)
    assert all(call["connect_timeout"] == 10 for call in calls)
    assert all(
        connection.fake_cursor.executed
        == ["SHOW transaction_read_only", "SELECT current_database()", "SELECT 1"]
        for connection in connections
    )
    assert all(connection.rolled_back and connection.closed for connection in connections)


@pytest.mark.parametrize(
    ("env_name", "value"),
    [
        ("DB_NAME_PROD", ""),
        ("DB_NAME_TEST", "   "),
        ("DB_USER_PROD", ""),
        ("DB_USER_TEST", ""),
        ("DB_PASSWORD", ""),
        ("DB_PORT", "not-a-number"),
        ("DB_CONNECT_TIMEOUT", "0"),
    ],
)
def test_rejects_invalid_environment_values(monkeypatch, env_name, value):
    module = _load_module()
    values = {
        "DB_NAME_PROD": " kanade_prod ",
        "DB_NAME_TEST": " kanade_test ",
        "DB_USER_PROD": " prod_reader ",
        "DB_USER_TEST": " test_reader ",
        "DB_PASSWORD": " secret ",
        "DB_PORT": "5432",
        "DB_CONNECT_TIMEOUT": "10",
    }
    values[env_name] = value
    for key, item in values.items():
        monkeypatch.setenv(key, item)

    with pytest.raises(ValueError):
        module.read_config([])


def test_rejects_same_prod_and_test_database(monkeypatch):
    module = _load_module()
    monkeypatch.setenv("DB_NAME_PROD", " same_db ")
    monkeypatch.setenv("DB_NAME_TEST", "same_db")
    monkeypatch.setenv("DB_USER_PROD", "prod_reader")
    monkeypatch.setenv("DB_USER_TEST", "test_reader")
    monkeypatch.setenv("DB_PASSWORD", "secret")

    with pytest.raises(ValueError, match="must be different"):
        module.read_config([])


def test_environment_values_are_trimmed(monkeypatch):
    module = _load_module()
    monkeypatch.setenv("DB_HOST", " 127.0.0.1 ")
    monkeypatch.setenv("DB_PORT", " 5432 ")
    monkeypatch.setenv("DB_NAME_PROD", " kanade_prod ")
    monkeypatch.setenv("DB_NAME_TEST", " kanade_test ")
    monkeypatch.setenv("DB_USER_PROD", " prod_reader ")
    monkeypatch.setenv("DB_USER_TEST", " test_reader ")
    monkeypatch.setenv("DB_PASSWORD", " secret ")
    monkeypatch.setenv("DB_CONNECT_TIMEOUT", " 10 ")

    config = module.read_config([])

    assert config.host == "127.0.0.1"
    assert config.prod_database == "kanade_prod"
    assert config.test_database == "kanade_test"
    assert config.prod_user == "prod_reader"
    assert config.test_user == "test_reader"
    assert config.password == "secret"


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

    def connect(**kwargs):
        return FakeConnection(kwargs["dbname"], {query: value})

    with pytest.raises(RuntimeError):
        module.verify_prod_test_connections(_config(module), connect)


@pytest.mark.parametrize("failed_database", ["kanade_prod", "kanade_test"])
def test_connection_failure_fails_the_whole_verification(failed_database):
    module = _load_module()

    def connect(**kwargs):
        if kwargs["dbname"] == failed_database:
            raise ConnectionError("connection failed")
        return FakeConnection(kwargs["dbname"])

    with pytest.raises(ConnectionError):
        module.verify_prod_test_connections(_config(module), connect)


def test_main_returns_zero_on_success(monkeypatch, capsys):
    module = _load_module()
    monkeypatch.setattr(module, "read_config", lambda argv: _config(module))
    monkeypatch.setattr(module, "verify_prod_test_connections", lambda config: None)

    assert module.main([]) == 0
    assert "[PASS]" in capsys.readouterr().out


def test_main_returns_one_without_exposing_password(monkeypatch, capsys):
    module = _load_module()
    password = "do-not-print-this-password"
    monkeypatch.setattr(module, "read_config", lambda argv: _config(module))

    def fail(_config):
        raise ConnectionError(f"connection failed with password={password}")

    monkeypatch.setattr(module, "verify_prod_test_connections", fail)

    assert module.main([]) == 1
    captured = capsys.readouterr()
    assert "[FAIL]" in captured.err
    assert password not in captured.err
