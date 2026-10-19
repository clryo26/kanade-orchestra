"""JST spec R04/R08 for authentication (T02/T07/T13)."""
from __future__ import annotations

from datetime import date, datetime

import pytest

from src.backend import auth_helpers
from src.backend.services import auth_session_fallback as fallback


@pytest.mark.parametrize(
    "today,until,expired",
    [
        (date(2026, 10, 19), "2026-10-19", False),  # the last day is valid all day (JST)
        (date(2026, 10, 20), "2026-10-19", True),  # from 00:00 JST of the next day
        (date(2028, 3, 1), "2028-02-29", True),
        (date(2028, 2, 29), "2028-02-29", False),
    ],
)
def test_access_expiry_uses_jst_calendar_day(monkeypatch, today, until, expired):
    monkeypatch.setattr(auth_helpers, "jst_today", lambda: today)
    member = {"permission": "エキストラ", "system_access_until": until}
    assert auth_helpers.member_access_expired(member) is expired


def test_access_expiry_keeps_existing_rules_for_non_extra_and_invalid_values(monkeypatch):
    monkeypatch.setattr(auth_helpers, "jst_today", lambda: date(2099, 1, 1))
    assert auth_helpers.member_access_expired({"permission": "一般", "system_access_until": "2000-01-01"}) is False
    assert auth_helpers.member_access_expired({"permission": "エキストラ", "system_access_until": ""}) is False
    assert auth_helpers.member_access_expired({"permission": "エキストラ", "system_access_until": "2026/10/19"}) is False
    assert auth_helpers.member_access_expired({"permission": "エキストラ", "system_access_until": "2026-02-30"}) is False


def test_jst_today_is_not_the_server_local_date(monkeypatch):
    from src.backend.utils import datetime_utils

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            # 2026-10-19 16:00 UTC == 2026-10-20 01:00 JST
            return datetime(2026, 10, 20, 1, 0, tzinfo=datetime_utils.JST).astimezone(tz)

    monkeypatch.setattr(datetime_utils, "datetime", Clock)
    assert datetime_utils.jst_today() == date(2026, 10, 20)


def test_fallback_lifetime_is_8_hours_on_a_monotonic_clock(monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(fallback, "_now", lambda: clock["now"])
    fallback._fallback_devices.clear()
    fallback.remember_auth_device({"device_id": "d1", "member_id": 1})
    clock["now"] += 8 * 3600 - 1
    device = fallback.fallback_auth_device("d1")
    assert device is not None and device["last_seen_at"].endswith("+09:00")
    clock["now"] += 1
    assert fallback.fallback_auth_device("d1") is None
    fallback._fallback_devices.clear()


def test_device_list_is_ordered_by_instant_not_text(client, backend_env, seed_device_fn):
    devices = [
        {"id": 1, "device_id": "a", "member_id": None, "permission": "システム管理者", "hidden_user": True, "authenticated_at": "2026-10-19T09:00:00+09:00"},
        {"id": 2, "device_id": "b", "member_id": None, "authenticated_at": "2026-10-19T01:00:00Z"},  # 10:00 JST, later
    ]
    backend_env.save_json_data("auth_devices", devices)
    listed = client.get("/api/auth/devices").json()
    assert [item["device_id"] for item in listed] == ["b", "a"]


def test_password_rehash_writes_only_that_member_and_only_if_unchanged(client, backend_env, monkeypatch):
    from src.backend.services.security_service import is_hashed_password

    members = [
        {"id": 1, "name": "Alpha", "part": "Vn", "permission": "一般", "password": "plain-pass", "created_at": "2026-01-01T00:00:00+09:00", "updated_at": "2026-01-01T00:00:00+09:00"},
        {"id": 2, "name": "Beta", "part": "Va", "permission": "一般", "password": "", "created_at": "2026-01-01T00:00:00+09:00", "updated_at": "2026-01-01T00:00:00+09:00"},
    ]
    backend_env.save_json_data("members", members)
    response = client.post("/api/auth/portal-login", json={"name": "Alpha", "part": "Vn", "password": "plain-pass", "device_id": "dev-x"})
    assert response.status_code == 200 and response.json()["authenticated"] is True
    stored = {item["id"]: item for item in backend_env.load_json_data("members")}
    assert is_hashed_password(stored[1]["password"])
    assert stored[2] == members[1]  # the other row was not rewritten
    device = next(item for item in backend_env.load_json_data("auth_devices") if item["device_id"] == "dev-x")
    assert device["authenticated_at"].endswith("+09:00")
