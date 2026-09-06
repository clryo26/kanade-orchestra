from __future__ import annotations

from typing import Any

from src.backend.core import app_lifecycle
from src.backend.core import database


def _captured_schema_compatibility(monkeypatch, env_value: str | None):
    captured: dict[str, Any] = {}

    def fake_run_startup_self_check(**kwargs: Any) -> None:
        captured.update(kwargs)

    monkeypatch.setattr(database, "run_startup_self_check", fake_run_startup_self_check)
    if env_value is None:
        monkeypatch.delenv("SKIP_STARTUP_SCHEMA_COMPATIBILITY", raising=False)
    else:
        monkeypatch.setenv("SKIP_STARTUP_SCHEMA_COMPATIBILITY", env_value)

    calls: list[Any] = []

    def schema_compatibility(conn: Any) -> None:
        calls.append(conn)

    app_lifecycle.run_db_startup_self_check(
        assert_db_ready=lambda: None,
        db_connection_string=lambda: "postgresql://example",
        ensure_db_schema_compatibility=schema_compatibility,
        psycopg=object(),
        db_expected=lambda: True,
        ensure_db_expected_is_ready=lambda: None,
    )

    captured["ensure_db_schema_compatibility_func"]("connection")
    return calls


def test_startup_schema_compatibility_runs_by_default(monkeypatch):
    assert _captured_schema_compatibility(monkeypatch, None) == ["connection"]


def test_startup_schema_compatibility_can_be_skipped_after_managed_migrations(monkeypatch):
    assert _captured_schema_compatibility(monkeypatch, "true") == []
