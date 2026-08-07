"""bootstrap-lite payments server-side filter regression tests."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from tests.conftest import seed_device  # noqa: E402


@pytest.fixture
def two_member_env(backend_env):
    backend_env.save_json_data(
        "members",
        [
            {
                "id": 1, "name": "Alice", "last_name": "Alice", "first_name": "", "part": "Vn",
                "password": "", "permission": "\u4e00\u822c",
                "is_recording_manager": False, "is_sheet_manager": False,
            },
            {
                "id": 2, "name": "Bob", "last_name": "Bob", "first_name": "", "part": "Va",
                "password": "", "permission": "\u4e00\u822c",
                "is_recording_manager": False, "is_sheet_manager": False,
            },
            {
                "id": 3, "name": "Admin", "last_name": "Admin", "first_name": "", "part": "Vn",
                "password": "", "permission": "\u7ba1\u7406\u8005",
                "is_recording_manager": False, "is_sheet_manager": False,
            },
        ],
    )
    backend_env.save_json_data(
        "payments",
        [
            {"id": 1, "member_id": 1, "name": "Alice", "paid_until_month": "2026-06"},
            {"id": 2, "member_id": 2, "name": "Bob", "paid_until_month": "2026-05"},
            {"id": 3, "member_id": 3, "name": "Admin", "paid_until_month": "2026-06"},
        ],
    )
    seed_device(backend_env, device_id="dev-alice", permission="\u4e00\u822c", member_id=1, member_name="Alice")
    seed_device(backend_env, device_id="dev-bob", permission="\u4e00\u822c", member_id=2, member_name="Bob")
    seed_device(backend_env, device_id="dev-admin", permission="\u7ba1\u7406\u8005", member_id=3, member_name="Admin")
    seed_device(backend_env, device_id="dev-sysadmin", permission="\u30b7\u30b9\u30c6\u30e0\u7ba1\u7406\u8005", member_id=3, member_name="Admin")
    return backend_env


@pytest.fixture
def two_member_client(two_member_env):
    return TestClient(two_member_env.app)


# --- general member: own payment only ---

def test_general_member_receives_own_payment_only(two_member_client):
    resp = two_member_client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-alice"})
    assert resp.status_code == 200
    payments = resp.json()["extras"]["payments"]
    assert len(payments) == 1
    assert payments[0]["member_id"] == 1


def test_general_member_does_not_receive_other_members_payments(two_member_client):
    resp = two_member_client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-alice"})
    assert resp.status_code == 200
    payments = resp.json()["extras"]["payments"]
    member_ids = [p["member_id"] for p in payments]
    assert 2 not in member_ids
    assert 3 not in member_ids


def test_another_general_member_receives_own_payment_only(two_member_client):
    resp = two_member_client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-bob"})
    assert resp.status_code == 200
    payments = resp.json()["extras"]["payments"]
    assert len(payments) == 1
    assert payments[0]["member_id"] == 2


# --- member_id takes priority over name: same name different id must be excluded ---

def test_same_name_different_member_id_is_not_returned(two_member_env):
    """member_id がある場合、同姓同名でも別 member_id の payment は返さない。"""
    two_member_env.save_json_data(
        "payments",
        [
            {"id": 1, "member_id": 1, "name": "Alice", "paid_until_month": "2026-06"},
            {"id": 9, "member_id": 99, "name": "Alice", "paid_until_month": "2026-01"},
        ],
    )
    client = TestClient(two_member_env.app)
    resp = client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-alice"})
    assert resp.status_code == 200
    payments = resp.json()["extras"]["payments"]
    assert len(payments) == 1
    assert payments[0]["id"] == 1
    assert payments[0]["member_id"] == 1


# --- name fallback only when member_id is absent ---

def test_member_matched_by_name_when_member_id_is_none(two_member_env):
    """device.member_id が存在しない場合のみ name で照合する。"""
    seed_device(two_member_env, device_id="dev-name-only", permission="\u4e00\u822c",
                member_id=None, member_name="Alice")
    two_member_env.save_json_data(
        "payments",
        [
            {"id": 10, "member_id": None, "name": "Alice", "paid_until_month": "2026-04"},
            {"id": 11, "member_id": None, "name": "Bob", "paid_until_month": "2026-03"},
        ],
    )
    client = TestClient(two_member_env.app)
    resp = client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-name-only"})
    assert resp.status_code == 200
    payments = resp.json()["extras"]["payments"]
    assert len(payments) == 1
    assert payments[0]["name"] == "Alice"


def test_member_with_id_does_not_use_name_fallback(two_member_env):
    """device.member_id がある場合は name 照合を行わない。"""
    two_member_env.save_json_data(
        "payments",
        [
            {"id": 1, "member_id": 1, "name": "Alice", "paid_until_month": "2026-06"},
            {"id": 20, "member_id": None, "name": "Alice", "paid_until_month": "2026-01"},
        ],
    )
    client = TestClient(two_member_env.app)
    resp = client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-alice"})
    assert resp.status_code == 200
    payments = resp.json()["extras"]["payments"]
    assert len(payments) == 1
    assert payments[0]["member_id"] == 1


# --- admin: own payment in bootstrap-lite, all payments in payment-admin ---

def test_admin_receives_own_payment_only_in_bootstrap_lite(two_member_client):
    resp = two_member_client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-admin"})
    assert resp.status_code == 200
    payments = resp.json()["extras"]["payments"]
    assert len(payments) == 1
    assert payments[0]["member_id"] == 3


def test_system_admin_receives_own_payment_only_in_bootstrap_lite(two_member_client):
    resp = two_member_client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-sysadmin"})
    assert resp.status_code == 200
    payments = resp.json()["extras"]["payments"]
    assert len(payments) == 1
    assert payments[0]["member_id"] == 3


def test_admin_payment_admin_view_receives_all_payments(two_member_client):
    resp = two_member_client.get("/api/extra/payments", headers={"X-Device-Id": "dev-admin"})
    assert resp.status_code == 200
    assert len(resp.json()) == 3


# --- no payment record: empty list ---

def test_member_without_payment_record_receives_empty(two_member_env):
    seed_device(two_member_env, device_id="dev-charlie", permission="\u4e00\u822c", member_id=99, member_name="Charlie")
    client = TestClient(two_member_env.app)
    resp = client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-charlie"})
    assert resp.status_code == 200
    assert resp.json()["extras"]["payments"] == []


# --- unauthenticated: empty list ---

def test_unauthenticated_request_receives_empty_payments(two_member_client):
    resp = two_member_client.get("/api/bootstrap-lite")
    assert resp.status_code == 200
    assert resp.json()["extras"]["payments"] == []


# --- invalid device: 401 is treated as unauthenticated, returns 200 with empty payments ---

def test_invalid_device_id_receives_empty_payments(two_member_client):
    resp = two_member_client.get("/api/bootstrap-lite", headers={"X-Device-Id": "no-such-device"})
    assert resp.status_code == 200
    assert resp.json()["extras"]["payments"] == []


# --- 500-level HTTPException is not suppressed ---

def test_server_error_in_device_auth_is_not_swallowed(two_member_env, monkeypatch):
    """device_auth_record が 500 を raise した場合、握りつぶさず 500 を返す。"""
    import src.backend.routers.bootstrap as bootstrap_router

    def raise_500(device_id: str):
        raise HTTPException(status_code=500, detail="DB connection failed")

    monkeypatch.setattr(bootstrap_router, "device_auth_record", raise_500)
    client = TestClient(two_member_env.app, raise_server_exceptions=False)
    resp = client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-alice"})
    assert resp.status_code == 500


# --- response structure compatibility ---

def test_payments_field_name_and_location_unchanged(two_member_client):
    resp = two_member_client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-alice"})
    assert resp.status_code == 200
    body = resp.json()
    assert "extras" in body
    assert "payments" in body["extras"]
    assert isinstance(body["extras"]["payments"], list)


def test_other_fields_not_affected(two_member_client, two_member_env):
    two_member_env.save_json_data("performances", [{"id": 1, "title": "Concert", "pieces": []}])
    two_member_env.save_json_data("schedules", [{"id": 1, "date": "2026-07-01"}])
    two_member_env.save_json_data("announcements", [{"id": 1, "content": "Notice"}])

    resp = two_member_client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-alice"})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["performances"]) == 1
    assert len(body["schedules"]) == 1
    assert len(body["announcements"]) == 1
    assert "members" in body
    assert "cloudRunRevision" in body


# --- no sensitive fields in response ---

def test_no_sensitive_fields_in_payment_response(two_member_client):
    resp = two_member_client.get("/api/bootstrap-lite", headers={"X-Device-Id": "dev-admin"})
    assert resp.status_code == 200
    for payment in resp.json()["extras"]["payments"]:
        assert "password" not in payment
        assert "device_id" not in payment
