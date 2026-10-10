"""Run only against an explicitly supplied disposable local PostgreSQL database."""
from __future__ import annotations

import os
from pathlib import Path

import psycopg
import pytest

from src.backend.repositories import menu_settings_repository as module


@pytest.mark.skipif(not os.getenv("MENU_SETTINGS_TEST_DSN"), reason="Disposable PostgreSQL DSN not supplied")
def test_postgres_persistence_defaults_tenant_isolation_and_rollback(monkeypatch):
    dsn = os.environ["MENU_SETTINGS_TEST_DSN"]
    # This opt-in test never uses the application's configured production DSN.
    monkeypatch.setattr(module, "db_connection_string", lambda: dsn)
    with psycopg.connect(dsn) as conn:
        conn.execute(Path("db/migrations/016_menu_visibility_settings.sql").read_text(encoding="utf-8"))
    repository = module.MenuSettingsRepository()
    assert repository.load("test-org-a") == {}
    repository.save("test-org-a", {"member-recording": False, "member-schedule": True})
    assert module.MenuSettingsRepository().load("test-org-a") == {"member-recording": False, "member-schedule": True}
    assert repository.load("test-org-b") == {}
    # Violate NOT NULL after the first write to check actual transaction rollback.
    with pytest.raises(psycopg.errors.NotNullViolation):
        repository.save("test-org-a", {"member-recording": True, "member-schedule": None})
    assert repository.load("test-org-a")["member-recording"] is False
    with psycopg.connect(dsn) as conn:
        conn.execute("INSERT INTO menu_visibility_settings (organization_id, menu_key) VALUES (%s,%s)", ("test-org-b", "member-recording"))
        row = conn.execute("SELECT visible, updated_at FROM menu_visibility_settings WHERE organization_id=%s", ("test-org-b",)).fetchone()
        assert row[0] is True
        assert row[1] is not None
