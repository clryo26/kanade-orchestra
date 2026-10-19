"""Opt-in PostgreSQL tests: session writes never rewind a newer login (JST spec R08, N03; T13)."""
from __future__ import annotations

import os

import pytest

psycopg = pytest.importorskip("psycopg")

from src.backend.core import db_runtime  # noqa: E402
from src.backend.core.tenant_context import reset_current_tenant_id, set_current_tenant_id  # noqa: E402
from src.backend.repositories import db_json_repository as repo  # noqa: E402
from src.backend.repositories.db_row_repository import _ORG_COLUMN_CACHE  # noqa: E402
from src.backend.utils.datetime_utils import parse_instant  # noqa: E402

DSN = os.environ.get("PORTAL_TEST_DB_URL", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Set PORTAL_TEST_DB_URL to an isolated PostgreSQL test instance")


@pytest.fixture
def db(monkeypatch):
    monkeypatch.setenv("DB_URL", DSN)
    _ORG_COLUMN_CACHE.clear()
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute('DROP TABLE IF EXISTS "auth_devices" CASCADE')
        db_runtime.ensure_db_schema_compatibility(conn)
    token = set_current_tenant_id("tenant-a")
    try:
        yield
    finally:
        reset_current_tenant_id(token)


def _device(member_id, name, permission="一般"):
    # Same keys as the portal_login payload.
    return {
        "device_id": "browser-1", "device_name": "B", "member_id": member_id, "member_name": name,
        "member_part": "Vn", "permission": permission, "system_access_until": "",
        "is_recording_manager": False, "is_sheet_manager": False, "hidden_user": False, "user_agent": "ua",
    }


def test_login_is_stamped_from_the_db_clock(db):
    saved = repo.record_login(_device(1, "A"))
    assert saved["authenticated_at"].endswith("+09:00") and saved["authenticated_at"] == saved["last_seen_at"]


def test_stale_session_check_cannot_rewind_a_newer_login_for_another_member(db):
    repo.record_login(_device(1, "A"))
    # Member B logs in on the same browser after A's session check read the row.
    newer = repo.record_login(_device(2, "B", "管理者"))
    touched = repo.touch_auth_device("browser-1", 1, {"member_name": "A", "permission": "一般"})
    assert touched is None
    with psycopg.connect(DSN) as conn:
        member_id, name, permission, authenticated_at = conn.execute(
            "SELECT member_id, member_name, permission, authenticated_at FROM auth_devices WHERE device_id='browser-1'"
        ).fetchone()
    assert (member_id, name, permission) == (2, "B", "管理者")
    assert authenticated_at == parse_instant(newer["authenticated_at"])


def test_session_check_updates_only_last_seen_and_member_fields(db):
    login = repo.record_login(_device(1, "A"))
    touched = repo.touch_auth_device("browser-1", 1, {"member_name": "A2", "permission": "管理者", "authenticated_at": login["authenticated_at"], "created_at": "2000-01-01T00:00:00Z"})
    assert touched["member_name"] == "A2" and touched["permission"] == "管理者"
    assert touched["authenticated_at"] == login["authenticated_at"]  # never rewritten (session generation)
    assert parse_instant(touched["last_seen_at"]) >= parse_instant(login["last_seen_at"])


def test_session_check_after_logout_does_not_resurrect_the_row(db):
    repo.record_login(_device(1, "A"))
    repo.delete_auth_device("browser-1")
    assert repo.touch_auth_device("browser-1", 1, {"member_name": "A"}) is None
    with psycopg.connect(DSN) as conn:
        assert conn.execute("SELECT count(*) FROM auth_devices").fetchone()[0] == 0


def test_same_member_relogin_cannot_be_rewound_by_old_check(db):
    older = repo.record_login(_device(1, "A", "一般"))
    newer = repo.record_login(_device(1, "A-new", "管理者"))
    assert older["authenticated_at"] != newer["authenticated_at"]
    assert repo.touch_auth_device("browser-1", 1, older) is None
    with psycopg.connect(DSN) as conn:
        name, permission, authenticated_at = conn.execute(
            "SELECT member_name, permission, authenticated_at FROM auth_devices WHERE device_id='browser-1'"
        ).fetchone()
    assert (name, permission) == ("A-new", "管理者")
    assert authenticated_at == parse_instant(newer["authenticated_at"])
