from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest
from fastapi import HTTPException

from src.backend import auth_api
from src.backend.repositories import db_json_repository as repository
from src.backend.services import auth_service


DEVICE = {"id": 3, "device_id": "single-row", "member_id": None,
          "member_name": "Session", "permission": "管理者", "custom": "preserve"}


@pytest.fixture
def direct_db(monkeypatch):
    device = Mock(return_value=dict(DEVICE))
    member = Mock(return_value=None)
    fallback = Mock(return_value=None)
    full = Mock(side_effect=AssertionError("authentication must not load a collection"))
    monkeypatch.setattr(auth_service, "db_data_enabled", lambda: True)
    monkeypatch.setattr(auth_service, "db_load_auth_device", device)
    monkeypatch.setattr(auth_service, "db_load_member", member)
    monkeypatch.setattr(auth_service, "fallback_auth_device", fallback)
    monkeypatch.setattr(auth_service, "load_json_data", full)
    monkeypatch.setattr(repository, "load_json_data", full)
    yield SimpleNamespace(device=device, member=member, fallback=fallback, full=full)
    full.assert_not_called()


def test_device_without_member_keeps_exact_payload(direct_db):
    assert auth_service.device_auth_record("single-row") == DEVICE
    direct_db.device.assert_called_once_with("single-row")
    direct_db.member.assert_not_called()


def test_empty_device_id_still_requires_header(direct_db):
    with pytest.raises(HTTPException) as caught:
        auth_service.device_auth_record("")
    assert (caught.value.status_code, caught.value.detail) == (401, "X-Device-Id is required")
    direct_db.device.assert_not_called()


@pytest.mark.parametrize("permission", ["一般", " 管理者 ", ""])
def test_member_changes_are_visible_without_cache_and_preserve_shape(direct_db, permission):
    stored = {**DEVICE, "member_id": 11, "member_part": "session part"}
    direct_db.device.return_value = stored
    current = {"id": 11, "name": "Current", "permission": permission,
               "system_access_until": None, "is_recording_manager": False, "is_sheet_manager": True}
    direct_db.member.return_value = current
    result = auth_service.device_auth_record("single-row")
    assert result == {**stored, "member_name": "Current", "permission": permission.strip() or "一般",
                      "system_access_until": "", "is_recording_manager": False, "is_sheet_manager": True}
    direct_db.member.return_value = {**current, "last_name": "New", "first_name": "Name",
                                   "permission": "一般", "is_sheet_manager": False}
    second = auth_service.device_auth_record("single-row")
    assert second["member_name"] == "NewName" and second["permission"] == "一般"
    assert second["is_sheet_manager"] is False
    assert stored == {**DEVICE, "member_id": 11, "member_part": "session part"}
    assert direct_db.member.call_count == 2


def test_missing_member_preserves_session(direct_db):
    direct_db.device.return_value = {**DEVICE, "member_id": 11}
    assert auth_service.device_auth_record("single-row") == direct_db.device.return_value
    direct_db.member.assert_called_once_with(11)


def test_expired_extra_is_forbidden(direct_db):
    direct_db.device.return_value = {**DEVICE, "member_id": 11}
    direct_db.member.return_value = {"id": 11, "permission": "エキストラ", "system_access_until": "2000-01-01"}
    with pytest.raises(HTTPException) as caught:
        auth_service.device_auth_record("single-row")
    assert (caught.value.status_code, caught.value.detail) == (403, "Member access expired")
    direct_db.fallback.assert_not_called()


@pytest.mark.parametrize("device_error", [False, True])
@pytest.mark.parametrize("has_fallback", [False, True])
def test_missing_or_failed_device_uses_only_existing_fallback_rules(direct_db, device_error, has_fallback):
    error = RuntimeError("device read failed")
    direct_db.device.return_value = None
    if device_error:
        direct_db.device.side_effect = error
    fallback = {**DEVICE, "device_id": "fallback"} if has_fallback else None
    direct_db.fallback.return_value = fallback
    if has_fallback:
        assert auth_service.device_auth_record("single-row") == fallback
    elif device_error:
        with pytest.raises(RuntimeError) as caught:
            auth_service.device_auth_record("single-row")
        assert caught.value is error
    else:
        with pytest.raises(HTTPException) as caught:
            auth_service.device_auth_record("single-row")
        assert (caught.value.status_code, caught.value.detail) == (401, "Device is not authenticated")
    direct_db.fallback.assert_called_once_with("single-row")
    direct_db.member.assert_not_called()


def test_member_failure_is_not_replaced_with_a_fallback(direct_db):
    error = RuntimeError("member read failed")
    direct_db.device.return_value = {**DEVICE, "member_id": 11}
    direct_db.member.side_effect = error
    direct_db.fallback.return_value = dict(DEVICE)
    with pytest.raises(RuntimeError) as caught:
        auth_service.device_auth_record("single-row")
    assert caught.value is error
    direct_db.fallback.assert_not_called()


def test_local_mode_keeps_collection_lookup_and_does_not_use_single_row_readers(direct_db, monkeypatch):
    monkeypatch.setattr(auth_service, "db_data_enabled", lambda: False)
    local = Mock(side_effect=[[dict(DEVICE)]])
    monkeypatch.setattr(auth_service, "load_json_data", local)
    assert auth_service.device_auth_record("single-row") == DEVICE
    local.assert_called_once_with("auth_devices")
    direct_db.device.assert_not_called()
    direct_db.member.assert_not_called()


@pytest.mark.parametrize("has_org", [False, True])
@pytest.mark.parametrize("table", ["auth_devices", "members"])
@pytest.mark.parametrize("exists", [False, True])
def test_repository_lookup_is_tenant_scoped_ordered_and_converts_rows(monkeypatch, has_org, table, exists):
    cursor = MagicMock()
    cursor.__enter__.return_value = cursor
    cursor.description = [("id",), ("device_id",), ("created_at",)]
    stamp = datetime(2026, 10, 20, tzinfo=timezone.utc)
    # Duplicate IDs arrive out of order; the fake honors the actual SQL order.
    duplicates = [(9, "single-row", stamp), (3, "single-row", stamp)]

    def execute(query, params):
        assert "SELECT * FROM " + table in query
        assert ("organization_id = %s" in query) is has_org
        assert params == (("tenant-auth", "single-row" if table == "auth_devices" else 3) if has_org
                          else ("single-row" if table == "auth_devices" else 3,))
        if table == "auth_devices":
            assert query.endswith("ORDER BY id LIMIT 1")
        else:
            assert query.endswith("id = %s")
        cursor.fetchone.return_value = min(duplicates) if exists else None

    cursor.execute.side_effect = execute
    conn = MagicMock()
    conn.__enter__.return_value = conn
    conn.cursor.return_value = cursor
    connect = Mock(return_value=conn)
    monkeypatch.setattr(repository, "psycopg", SimpleNamespace(connect=connect))
    monkeypatch.setattr(repository, "db_connection_string", lambda: "test-dsn")
    monkeypatch.setattr(repository, "table_has_organization_id", lambda connection, name: has_org)
    monkeypatch.setattr(repository, "get_current_tenant_id", lambda: "tenant-auth")
    full = Mock(side_effect=AssertionError("must not fetch all rows"))
    monkeypatch.setattr(repository, "db_fetch_all", full)
    result = (repository.load_auth_device_by_device_id("single-row") if table == "auth_devices"
              else repository.load_member_by_id(3))
    assert result == ({"id": 3, "device_id": "single-row", "created_at": "2026-10-20T09:00:00.000000+09:00"} if exists else None)
    connect.assert_called_once_with("test-dsn", autocommit=True)
    cursor.fetchone.assert_called_once()
    cursor.fetchall.assert_not_called()
    full.assert_not_called()

    if table == "auth_devices" and exists:
        monkeypatch.setattr(auth_service, "db_data_enabled", lambda: True)
        monkeypatch.setattr(auth_service, "db_load_auth_device", repository.load_auth_device_by_device_id)
        assert auth_service.device_auth_record("single-row")["id"] == 3


@pytest.fixture
def session_db(monkeypatch):
    full = Mock(side_effect=AssertionError("session lookup must not load a collection"))
    gateway = SimpleNamespace(
        db_data_enabled=lambda: True,
        db_load_auth_device=Mock(return_value=dict(DEVICE)), db_load_member=Mock(return_value=None),
        db_touch_auth_device=Mock(side_effect=lambda device_id, member_id, item: {**item, "last_seen_at": "touched"}),
        db_delete_auth_device=Mock(), db_load_json_data=full, load_json_data=full,
        save_json_data=Mock(side_effect=AssertionError("must not replace a collection")),
    )
    monkeypatch.setattr(auth_api, "persistence_api", lambda: gateway)
    monkeypatch.setattr(auth_api, "fallback_auth_device", Mock(return_value=None))
    yield gateway
    full.assert_not_called()
    gateway.save_json_data.assert_not_called()


@pytest.mark.parametrize("linked", [False, True])
def test_session_get_keeps_authenticated_payload(client, session_db, linked):
    expected = {**DEVICE, "last_seen_at": "touched"}
    if linked:
        session_db.db_load_auth_device.return_value = {**DEVICE, "member_id": 11}
        session_db.db_load_member.return_value = {"id": 11, "name": "Current", "part": "Vn", "permission": "一般"}
        expected.update(member_id=11, member_name="Current", member_part="Vn", permission="一般",
                        system_access_until="", is_recording_manager=False, is_sheet_manager=False)
    result = client.get("/api/auth/devices/single-row")
    assert result.status_code == 200
    assert result.json() == {"authenticated": True, "device": expected}
    if not linked:
        session_db.db_load_member.assert_not_called()


def test_session_get_missing_device_is_unauthenticated(client, session_db):
    session_db.db_load_auth_device.return_value = None
    assert client.get("/api/auth/devices/single-row").json() == {"authenticated": False}
    session_db.db_touch_auth_device.assert_not_called()


def test_session_missing_member_keeps_device_fields(client, session_db):
    session_db.db_load_auth_device.return_value = {**DEVICE, "member_id": 11}
    assert client.get("/api/auth/devices/single-row").json() == {
        "authenticated": True, "device": {**DEVICE, "member_id": 11, "last_seen_at": "touched"}}


def test_session_device_error_propagates_when_no_fallback_exists(session_db):
    import asyncio

    error = RuntimeError("device read unavailable")
    session_db.db_load_auth_device.side_effect = error
    with pytest.raises(RuntimeError) as caught:
        asyncio.run(auth_api.get_auth_device("single-row"))
    assert caught.value is error


def test_session_get_expired_extra_deletes_device(client, session_db):
    session_db.db_load_auth_device.return_value = {**DEVICE, "member_id": 11}
    session_db.db_load_member.return_value = {"id": 11, "permission": "エキストラ", "system_access_until": "2000-01-01"}
    assert client.get("/api/auth/devices/single-row").json() == {"authenticated": False}
    session_db.db_delete_auth_device.assert_called_once_with("single-row")
    session_db.db_touch_auth_device.assert_not_called()


@pytest.mark.parametrize("current", [None, {**DEVICE, "member_name": "New login"}])
def test_session_touch_conflict_reads_current_row_without_writing_old_snapshot(client, session_db, current):
    session_db.db_load_auth_device.side_effect = [dict(DEVICE), current]
    session_db.db_touch_auth_device.side_effect = None
    session_db.db_touch_auth_device.return_value = None
    expected = {"authenticated": True, "device": current} if current else {"authenticated": False}
    assert client.get("/api/auth/devices/single-row").json() == expected
    assert session_db.db_load_auth_device.call_args_list == [(('single-row',), {}), (('single-row',), {})]


@pytest.mark.parametrize("read_error", [False, True])
def test_session_get_retains_fallback_payload(client, session_db, monkeypatch, read_error):
    session_db.db_load_auth_device.return_value = None
    if read_error:
        session_db.db_load_auth_device.side_effect = RuntimeError("read unavailable")
    monkeypatch.setattr(auth_api, "fallback_auth_device", lambda device_id: dict(DEVICE))
    assert client.get("/api/auth/devices/single-row").json() == {"authenticated": True, "device": DEVICE}
    session_db.db_touch_auth_device.assert_not_called()


def test_session_touch_failure_keeps_current_response(client, session_db, monkeypatch):
    session_db.db_touch_auth_device.side_effect = RuntimeError("touch unavailable")
    remember = Mock()
    monkeypatch.setattr(auth_api, "remember_auth_device", remember)
    assert client.get("/api/auth/devices/single-row").json() == {"authenticated": True, "device": DEVICE}
    assert remember.call_args.args[0]["device_id"] == "single-row"


def test_session_member_error_propagates_without_fallback(session_db):
    import asyncio

    error = RuntimeError("member read unavailable")
    session_db.db_load_auth_device.return_value = {**DEVICE, "member_id": 11}
    session_db.db_load_member.side_effect = error
    with pytest.raises(RuntimeError) as caught:
        asyncio.run(auth_api.get_auth_device("single-row"))
    assert caught.value is error


@pytest.fixture
def nul_rejecting_db(monkeypatch):
    from psycopg import DataError

    connect = Mock(side_effect=DataError("PostgreSQL text cannot contain NUL"))
    monkeypatch.setattr(repository, "psycopg", SimpleNamespace(connect=connect))
    monkeypatch.setattr(repository, "db_connection_string", lambda: "test-dsn")
    return connect


@pytest.mark.parametrize("lookup", [repository.load_auth_device_by_device_id, repository.load_member_by_id])
def test_nul_identifier_is_no_match_without_sending_it_to_postgres(nul_rejecting_db, lookup):
    assert lookup("a\x00b") is None
    nul_rejecting_db.assert_not_called()


@pytest.mark.parametrize("has_fallback", [False, True])
def test_nul_device_preserves_service_authentication_response(direct_db, nul_rejecting_db, monkeypatch, has_fallback):
    monkeypatch.setattr(auth_service, "db_load_auth_device", repository.load_auth_device_by_device_id)
    fallback = dict(DEVICE) if has_fallback else None
    direct_db.fallback.return_value = fallback
    if has_fallback:
        assert auth_service.device_auth_record("a\x00b") == fallback
    else:
        with pytest.raises(HTTPException) as caught:
            auth_service.device_auth_record("a\x00b")
        assert (caught.value.status_code, caught.value.detail) == (401, "Device is not authenticated")
    direct_db.fallback.assert_called_once_with("a\x00b")
    direct_db.member.assert_not_called()
    nul_rejecting_db.assert_not_called()


@pytest.mark.parametrize("has_fallback", [False, True])
def test_nul_path_preserves_session_response(client, session_db, nul_rejecting_db, monkeypatch, has_fallback):
    session_db.db_load_auth_device = repository.load_auth_device_by_device_id
    fallback = dict(DEVICE) if has_fallback else None
    monkeypatch.setattr(auth_api, "fallback_auth_device", lambda device_id: fallback)
    result = client.get("/api/auth/devices/a%00b")
    assert result.status_code == 200
    assert result.json() == ({"authenticated": True, "device": fallback} if has_fallback else {"authenticated": False})
    session_db.db_load_member.assert_not_called()
    session_db.db_touch_auth_device.assert_not_called()
    nul_rejecting_db.assert_not_called()
