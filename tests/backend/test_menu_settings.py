from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from src.backend.core.tenant_context import reset_current_tenant_id, set_current_tenant_id
from src.backend.repositories.menu_settings_repository import MenuSettingsRepository
from src.backend.services import menu_settings_service as service


class MemoryRepository:
    """Test double only; runtime settings always use PostgreSQL."""
    def __init__(self):
        self.rows = {}

    def load(self, org):
        return deepcopy(self.rows.get(org, {}))

    def save(self, org, settings):
        self.rows.setdefault(org, {}).update(deepcopy(settings))
        return self.load(org)


@pytest.fixture
def repository(monkeypatch):
    repo = MemoryRepository()
    monkeypatch.setattr(service, "_repository", lambda: repo)
    monkeypatch.setattr(service, "local_json_fallback_enabled", lambda: False)
    return repo


def test_unregistered_defaults_and_protected_scope(repository):
    settings = service.visibility_settings()
    assert len(settings) == 22
    assert len(service.REQUIRED_MENU_KEYS) == 21
    assert all(settings.values())
    assert "notification-settings" in settings
    assert not {"system", "system-menu-management", "system-auth", "member-absence", "manual"} & settings.keys()


@pytest.mark.parametrize("notifications", [False, True])
def test_save_accepts_exact_required_menus_with_optional_notification(repository, notifications):
    settings = dict.fromkeys(service.REQUIRED_MENU_KEYS, True)
    settings["member-recording"] = False
    repository.rows["default"] = {"notification-settings": False}
    if notifications:
        settings["notification-settings"] = True
    result = service.save_settings(settings)
    assert result["visibility"]["member-recording"] is False
    assert result["visibility"]["notification-settings"] is notifications
    assert result["optional_keys"] == ["notification-settings"]
    assert set(repository.rows["default"]) == set(settings) | {"notification-settings"}
    for key in service.REQUIRED_MENU_KEYS:
        missing = {k: value for k, value in settings.items() if k != key}
        with pytest.raises(HTTPException) as exc:
            service.save_settings(missing)
        assert exc.value.status_code == 400


def test_shared_by_users_and_isolated_between_organizations(repository):
    token = set_current_tenant_id("orchestra-a")
    try:
        settings = service.visibility_settings()
        settings["member-recording"] = False
        service.save_settings(settings)
        # A new request/repository read sees the saved setting without a user key.
        assert not service.visibility_settings()["member-recording"]
        other = set_current_tenant_id("orchestra-b")
        try:
            assert service.visibility_settings()["member-recording"]
        finally:
            reset_current_tenant_id(other)
    finally:
        reset_current_tenant_id(token)


@pytest.mark.parametrize("key", ["system", "system-menu-management", "system-auth", "manual"])
def test_rejects_out_of_scope_and_partial_saves(repository, key):
    settings = service.visibility_settings()
    settings[key] = False
    with pytest.raises(HTTPException) as exc:
        service.save_settings(settings)
    assert exc.value.status_code == 400
    assert repository.rows == {}
    with pytest.raises(HTTPException):
        service.save_settings({"member-recording": False})


def test_database_failure_is_not_treated_as_unregistered(repository, monkeypatch):
    def fail(*args):
        raise RuntimeError("DB unavailable")
    monkeypatch.setattr(repository, "load", fail)
    with pytest.raises(HTTPException) as exc:
        service.visibility_settings()
    assert exc.value.status_code == 503
    monkeypatch.setattr(repository, "save", fail)
    with pytest.raises(HTTPException) as exc:
        service.save_settings(dict.fromkeys(service.MENU_KEYS, True))
    assert exc.value.status_code == 503


def test_explicit_local_mode_does_not_create_alternative_persistence(monkeypatch):
    monkeypatch.setattr(service, "local_json_fallback_enabled", lambda: True)
    assert all(service.visibility_settings().values())
    with pytest.raises(HTTPException) as exc:
        service.save_settings(service.visibility_settings())
    assert exc.value.status_code == 503


@pytest.mark.parametrize("notifications", [False, True])
def test_settings_api_auth_validation_and_shared_bootstrap(client, seed_device_fn, repository, notifications):
    seed_device_fn(device_id="menu-system", permission="システム管理者")
    seed_device_fn(device_id="menu-general", permission="一般")
    seed_device_fn(device_id="menu-admin", permission="管理者")
    path = "/api/system/menu-settings"
    settings = dict.fromkeys(service.REQUIRED_MENU_KEYS, True)
    settings["member-recording"] = False
    if notifications:
        settings["notification-settings"] = False
    for device in ("menu-general", "menu-admin"):
        headers = {"X-Device-Id": device}
        assert client.get(path, headers=headers).status_code == 403
        assert client.put(path, headers=headers, json={"visibility": settings}).status_code == 403
    assert client.put(path, json={"visibility": settings}).status_code == 401
    headers = {"X-Device-Id": "menu-system"}
    invalid = {**settings, "member-recording": "false"}
    assert client.put(path, headers=headers, json={"visibility": invalid}).status_code == 422
    result = client.put(path, headers=headers, json={"visibility": settings})
    assert result.status_code == 200
    expected = {**dict.fromkeys(service.MENU_KEYS, True), **settings}
    assert result.json()["visibility"] == expected
    assert client.get(path, headers=headers).json()["visibility"] == expected
    for device in ("menu-general", "menu-admin", "menu-system"):
        result = client.get("/api/bootstrap-lite", headers={"X-Device-Id": device})
        assert result.status_code == 200
        assert result.json()["menu_visibility"] == expected


@pytest.mark.parametrize("path", ["/api/bootstrap-lite", "/api/bootstrap-core", "/api/bootstrap"])
def test_bootstrap_etag_revalidates_settings_and_tenant(client, repository, path):
    first = client.get(path)
    assert first.status_code == 200
    etag = first.headers["etag"]
    assert client.get(path, headers={"If-None-Match": etag}).status_code == 304
    settings = service.visibility_settings()
    settings["member-schedule"] = False
    service.save_settings(settings)
    changed = client.get(path, headers={"If-None-Match": etag})
    assert changed.status_code == 200
    assert changed.headers["etag"] != etag
    assert changed.json()["menu_visibility"]["member-schedule"] is False
    assert client.get(path, headers={"If-None-Match": changed.headers["etag"]}).status_code == 304
    other = client.get(path, headers={"X-Organization-Id": "other", "If-None-Match": changed.headers["etag"]})
    assert other.status_code == 200
    assert other.json()["menu_visibility"]["member-schedule"] is True


def test_repository_parameterized_read_and_atomic_save(monkeypatch):
    repository = MenuSettingsRepository()
    conn = MagicMock()
    conn.__enter__.return_value = conn
    cur = conn.cursor.return_value.__enter__.return_value
    cur.fetchall.return_value = [("member-recording", False)]
    monkeypatch.setattr(repository, "_connection", lambda: conn)
    assert repository.save("org-a", {"member-recording": False}) == {"member-recording": False}
    query, rows = cur.executemany.call_args.args
    assert "ON CONFLICT (organization_id, menu_key)" in query
    assert rows == [("org-a", "member-recording", False)]
    assert cur.execute.call_args.args[1] == ("org-a",)
    conn.commit.assert_called_once()
    conn.commit.reset_mock()
    cur.executemany.side_effect = RuntimeError("write failed")
    with pytest.raises(RuntimeError):
        repository.save("org-a", {"member-recording": False})
    conn.commit.assert_not_called()
    assert conn.__exit__.call_args.args[0] is RuntimeError


def test_migration_number_is_unique_and_defaults_on():
    files = list(Path("db/migrations").glob("*.sql"))
    versions = [path.name.split("_", 1)[0] for path in files]
    assert len(versions) == len(set(versions))
    sql = Path("db/migrations/016_menu_visibility_settings.sql").read_text(encoding="utf-8")
    assert "PRIMARY KEY (organization_id, menu_key)" in sql
    assert "visible BOOLEAN NOT NULL DEFAULT TRUE" in sql
