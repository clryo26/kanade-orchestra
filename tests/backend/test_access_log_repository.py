from __future__ import annotations

from typing import Any

from src.backend.repositories import access_log_repository


class _FakeCursor:
    def __init__(self, inserted_id: int) -> None:
        self.inserted_id = inserted_id
        self.executions: list[tuple[Any, tuple[Any, ...]]] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, query: Any, params: tuple[Any, ...]) -> None:
        self.executions.append((query, params))

    def fetchone(self) -> tuple[int]:
        return (self.inserted_id,)


class _FakeConnection:
    def __init__(self, inserted_id: int) -> None:
        self.cursor_instance = _FakeCursor(inserted_id)
        self.commit_count = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def cursor(self) -> _FakeCursor:
        return self.cursor_instance

    def commit(self) -> None:
        self.commit_count += 1


def _payload() -> dict[str, Any]:
    return {
        "id": 999,
        "member_id": 10,
        "member_name": "User",
        "member_part": "Clarinet",
        "permission": "member",
        "menu_key": "member-home",
        "menu_label": "Portal",
        "panel": "Member menu",
        "device_id": "device-1",
        "device_name": "Phone",
        "user_agent": "TestAgent",
        "accessed_at": "2026-08-05T00:00:00+09:00",
        "created_at": "2026-08-05T00:00:00+09:00",
        "updated_at": "2026-08-05T00:00:00+09:00",
        "organization_id": "untrusted-tenant",
    }


def test_insert_access_log_uses_identity_and_limits_current_tenant(monkeypatch):
    connection = _FakeConnection(inserted_id=321)
    connect_calls: list[tuple[str, bool]] = []

    def fake_connect(connection_string: str, *, autocommit: bool):
        connect_calls.append((connection_string, autocommit))
        return connection

    monkeypatch.setattr(access_log_repository.psycopg, "connect", fake_connect)
    monkeypatch.setattr(access_log_repository, "db_connection_string", lambda: "postgresql://test")
    monkeypatch.setattr(access_log_repository, "get_current_tenant_id", lambda: "tenant-a")
    monkeypatch.setattr(access_log_repository, "table_has_organization_id", lambda _conn, _table: True)

    result = access_log_repository.insert_access_log(_payload(), max_items=2000)

    assert result["id"] == 321
    assert "organization_id" not in result
    assert connect_calls == [("postgresql://test", False)]
    assert connection.commit_count == 1

    executions = connection.cursor_instance.executions
    assert len(executions) == 2

    insert_params = executions[0][1]
    assert 999 not in insert_params
    assert insert_params[-1] == "tenant-a"

    delete_params = executions[1][1]
    assert delete_params == ("tenant-a", "tenant-a", 2000)


def test_insert_access_log_supports_legacy_table_without_organization_id(monkeypatch):
    connection = _FakeConnection(inserted_id=654)

    monkeypatch.setattr(
        access_log_repository.psycopg,
        "connect",
        lambda _connection_string, *, autocommit: connection,
    )
    monkeypatch.setattr(access_log_repository, "db_connection_string", lambda: "postgresql://test")
    monkeypatch.setattr(access_log_repository, "get_current_tenant_id", lambda: "tenant-a")
    monkeypatch.setattr(access_log_repository, "table_has_organization_id", lambda _conn, _table: False)

    result = access_log_repository.insert_access_log(_payload(), max_items=0)

    assert result["id"] == 654
    assert connection.commit_count == 1

    executions = connection.cursor_instance.executions
    assert len(executions) == 2

    insert_params = executions[0][1]
    assert 999 not in insert_params
    assert "tenant-a" not in insert_params
    assert "untrusted-tenant" not in insert_params

    delete_params = executions[1][1]
    assert delete_params == (1,)
