from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from src.backend.core import tenant_context
from src.backend.repositories import access_log_repository, db_row_repository


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


def test_insert_access_log_uses_identity_and_current_tenant_without_retention_delete(monkeypatch):
    connection = _FakeConnection(inserted_id=321)
    connect_calls: list[tuple[str, bool]] = []

    def fake_connect(connection_string: str, *, autocommit: bool):
        connect_calls.append((connection_string, autocommit))
        return connection

    monkeypatch.setattr(access_log_repository.psycopg, "connect", fake_connect)
    monkeypatch.setattr(access_log_repository, "db_connection_string", lambda: "postgresql://test")
    monkeypatch.setattr(access_log_repository, "get_current_tenant_id", lambda: "tenant-a")
    monkeypatch.setattr(access_log_repository, "table_has_organization_id", lambda _conn, _table: True)

    result = access_log_repository.insert_access_log(_payload())

    assert result["id"] == 321
    assert "organization_id" not in result
    assert connect_calls == [("postgresql://test", False)]
    assert connection.commit_count == 1

    executions = connection.cursor_instance.executions
    assert len(executions) == 1

    insert_params = executions[0][1]
    assert 999 not in insert_params
    assert insert_params[-1] == "tenant-a"


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

    result = access_log_repository.insert_access_log(_payload())

    assert result["id"] == 654
    assert connection.commit_count == 1

    executions = connection.cursor_instance.executions
    assert len(executions) == 1

    insert_params = executions[0][1]
    assert 999 not in insert_params
    assert "tenant-a" not in insert_params
    assert "untrusted-tenant" not in insert_params


def test_query_access_logs_keeps_tenant_filters_and_clamps_last_page(monkeypatch):
    date_from = datetime(2026, 8, 1, tzinfo=timezone.utc)
    date_to = datetime(2026, 8, 3, tzinfo=timezone.utc)
    accessed_at = datetime(2026, 8, 2, 12, 30, tzinfo=timezone.utc)
    rows = [(row_id, 10, "Clarinet", accessed_at) for row_id in range(205, 200, -1)]

    class SearchCursor(_FakeCursor):
        def __init__(self):
            super().__init__(inserted_id=205)
            self.description = [(name,) for name in ("id", "member_id", "member_part", "accessed_at")]

        def fetchone(self):
            query, _params = self.executions[-1]
            # Keep the real schema-column check; only its database result is doubled.
            if isinstance(query, str) and "information_schema.columns" in query:
                return (1,)
            assert query.as_string().startswith('SELECT COUNT(*) FROM "access_logs"')
            return (205,)

        def fetchall(self):
            return rows

    connection = _FakeConnection(inserted_id=205)
    cursor = SearchCursor()
    connection.cursor_instance = cursor
    connect_calls = []

    def fake_connect(connection_string: str, *, autocommit: bool):
        connect_calls.append((connection_string, autocommit))
        return connection

    previous_tenant = tenant_context.get_current_tenant_id()
    previous_cache = db_row_repository._ORG_COLUMN_CACHE
    cache_snapshot = dict(previous_cache)
    # Restore configuration, the schema cache and the connection boundary after the call.
    with monkeypatch.context() as patch:
        patch.setenv("DB_URL", "postgresql://search-test")
        patch.setattr(db_row_repository, "_ORG_COLUMN_CACHE", {})
        patch.setattr(access_log_repository.psycopg, "connect", fake_connect)
        token = tenant_context.set_current_tenant_id("tenant-a")
        try:
            result = access_log_repository.query_access_logs(
                date_from=date_from,
                date_to=date_to,
                member_id=10,
                member_part="  Clarinet  ",
                page=99,
            )
        finally:
            tenant_context.reset_current_tenant_id(token)

    assert tenant_context.get_current_tenant_id() == previous_tenant
    assert db_row_repository._ORG_COLUMN_CACHE is previous_cache
    assert previous_cache == cache_snapshot
    assert connect_calls == [("postgresql://search-test", True)]
    assert connection.commit_count == 0
    assert len(cursor.executions) == 3
    schema_query, schema_params = cursor.executions[0]
    assert "information_schema.columns" in schema_query
    assert schema_params == ("access_logs",)
    count_query, count_params = cursor.executions[1]
    list_query, list_params = cursor.executions[2]
    where = (
        " WHERE organization_id = %s AND accessed_at >= %s AND accessed_at < %s"
        " AND member_id = %s AND member_part = %s"
    )
    # Check both SQL and bindings so tenant or date-boundary regressions cannot pass.
    assert count_query.as_string() == 'SELECT COUNT(*) FROM "access_logs"' + where
    assert list_query.as_string() == (
        'SELECT * FROM "access_logs"' + where
        + " ORDER BY accessed_at DESC, id DESC LIMIT %s OFFSET %s"
    )
    assert count_params == ("tenant-a", date_from, date_to, 10, "Clarinet")
    assert list_params == (*count_params, 100, 200)
    assert result == {
        "items": [
            {"id": row_id, "member_id": 10, "member_part": "Clarinet", "accessed_at": accessed_at.isoformat()}
            for row_id in range(205, 200, -1)
        ],
        "page": 3,
        "page_size": 100,
        "total": 205,
        "total_pages": 3,
    }
