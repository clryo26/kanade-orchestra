"""Read authorization and bootstrap privacy contracts (synthetic data only)."""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from src.backend.services.extra_collection_helpers import (
    ADMIN_ONLY_READ_EXTRA_COLLECTIONS,
    EXTRA_COLLECTIONS,
)
from tests.conftest import seed_device


PAYMENTS = [
    {"id": 1, "member_id": 1, "name": "Alice", "paid_until_month": "2026-06"},
    {"id": 2, "member_id": 2, "name": "Bob", "paid_until_month": "2026-05"},
    {"id": 3, "member_id": 3, "name": "Admin", "paid_until_month": "2026-04"},
    {"id": 4, "member_id": 4, "name": "System", "paid_until_month": "2026-03"},
]
CONNECTION_SETTINGS = [
    {"id": 1, "google_service_account_json": "synthetic-account-marker",
     "google_service_account_file": "synthetic-account-file"},
]
DEVICES = (
    ("dev-alice", 1, "Alice", "一般"),
    ("dev-bob", 2, "Bob", "一般"),
    ("dev-admin", 3, "Admin", "管理者"),
    ("dev-sysadmin", 4, "System", "システム管理者"),
)
ADMIN_DEVICES = ("dev-admin", "dev-sysadmin")


def headers(device_id):
    return {"X-Device-Id": device_id} if device_id else {}


@pytest.fixture
def read_permission_env(backend_env, monkeypatch):
    from src.backend.services import auth_session_fallback

    # Device-list assertions must not inherit fallback sessions from other tests.
    monkeypatch.setattr(auth_session_fallback, "_fallback_devices", {})
    # Keep the system administrator on a separate member: linked members'
    # current permissions override the role saved on an auth device.
    backend_env.save_json_data("members", [
        {"id": member_id, "name": name, "last_name": name, "first_name": "",
         "part": "Vn", "password": "", "permission": permission,
         "is_recording_manager": False, "is_sheet_manager": False}
        for _, member_id, name, permission in DEVICES
    ])
    backend_env.save_json_data("payments", PAYMENTS)
    backend_env.save_json_data("connection_settings", CONNECTION_SETTINGS)
    for device_id, member_id, name, permission in DEVICES:
        seed_device(backend_env, device_id=device_id, permission=permission,
                    member_id=member_id, member_name=name)
    return backend_env


@pytest.fixture
def read_client(read_permission_env):
    return TestClient(read_permission_env.app)


@pytest.mark.parametrize("collection", ["payments", "connection_settings"])
@pytest.mark.parametrize("device_id,status", [
    (None, 401), ("no-such-device", 401), ("dev-alice", 403), ("dev-bob", 403),
])
def test_restricted_reads_reject_without_disclosing_rows(read_client, collection, device_id, status):
    response = read_client.get(f"/api/extra/{collection}", headers=headers(device_id))
    assert response.status_code == status
    if status == 403:
        assert response.json() == {"detail": "Admin permission is required"}
    else:
        assert set(response.json()) == {"detail"}
    for marker in ("paid_until_month", "Alice", "Bob", "synthetic-account-marker",
                   "synthetic-account-file"):
        assert marker not in response.text


@pytest.mark.parametrize("device_id", ADMIN_DEVICES)
@pytest.mark.parametrize("collection,expected", [
    ("payments", PAYMENTS), ("connection_settings", CONNECTION_SETTINGS),
])
def test_admin_reads_return_all_rows_without_caching(read_client, device_id, collection, expected):
    response = read_client.get(f"/api/extra/{collection}", headers=headers(device_id))
    assert response.status_code == 200
    assert response.json() == expected
    assert "no-store" in response.headers["Cache-Control"]


@pytest.mark.parametrize("collection", sorted(
    EXTRA_COLLECTIONS - ADMIN_ONLY_READ_EXTRA_COLLECTIONS - {"promotions"}
))
@pytest.mark.parametrize("device_id", [None, "dev-alice"])
def test_public_collection_reads_still_need_no_admin(read_client, collection, device_id):
    response = read_client.get(f"/api/extra/{collection}", headers=headers(device_id))
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_promotions_keep_dedicated_public_no_store_route(read_client, monkeypatch):
    from src.backend.routers import albums

    # A distinctive result proves the dedicated promotion service is used.
    expected = [{"id": 91, "title": "Public promotion"}]
    monkeypatch.setattr(albums.promotion_service, "list_items", lambda: expected)
    response = read_client.get("/api/extra/promotions")
    assert response.status_code == 200
    assert response.json() == expected
    assert "no-store" in response.headers["Cache-Control"]


def test_unknown_collection_still_returns_404_without_auth(read_client):
    assert read_client.get("/api/extra/no_such_collection").status_code == 404


def test_member_payment_write_still_requires_admin(read_client, read_permission_env):
    response = read_client.post("/api/extra/payments", headers=headers("dev-alice"),
                                json={"member_id": 1, "name": "Alice",
                                      "paid_until_month": "2026-07"})
    assert response.status_code == 403
    assert response.json() == {"detail": "Admin permission is required"}
    assert read_permission_env.load_json_data("payments") == PAYMENTS


@pytest.mark.parametrize("device_id,expected_payments,is_admin", [
    (None, [], False), ("no-such-device", [], False),
    ("dev-alice", [PAYMENTS[0]], False), ("dev-bob", [PAYMENTS[1]], False),
    ("dev-admin", PAYMENTS, True), ("dev-sysadmin", PAYMENTS, True),
])
def test_full_bootstrap_preserves_schema_and_filters_private_data(
    read_client, read_permission_env, device_id, expected_payments, is_admin,
):
    response = read_client.get("/api/bootstrap", headers=headers(device_id))
    assert response.status_code == 200
    assert "no-store" in response.headers["Cache-Control"]
    body = response.json()
    assert set(body) == {
        "performances", "schedules", "announcements", "events", "members",
        "recordings", "sheets", "extras", "auth_devices", "cloudRunRevision", "menu_visibility",
    }
    assert set(body["extras"]) == {
        "absences", "event_responses", "date_adjustments", "date_adjustment_responses",
        "sheet_library", "payments", "castings", "piece_infos", "practice_instructions",
        "performance_day_infos", "albums", "part_settings", "venue_settings",
        "flyer_distributions", "flyer_distribution_assignments", "org_settings",
        "sns_settings", "connection_settings", "desired_pieces", "promotions",
    }
    assert body["extras"]["payments"] == expected_payments
    assert body["extras"]["connection_settings"] == (CONNECTION_SETTINGS if is_admin else [])
    if is_admin:
        assert body["auth_devices"] == read_permission_env.load_json_data("auth_devices")
    else:
        assert body["auth_devices"] == []
        for marker in (*ADMIN_DEVICES, "synthetic-account-marker", "synthetic-account-file"):
            assert marker not in response.text

    # Full bootstrap must always send a body, even with a matching/wildcard validator.
    conditional = read_client.get("/api/bootstrap", headers={
        **headers(device_id), "If-None-Match": response.headers.get("ETag", "*"),
    })
    assert conditional.status_code == 200
    assert conditional.json() == body
    assert "no-store" in conditional.headers["Cache-Control"]


@pytest.mark.parametrize("endpoint", ["/api/bootstrap", "/api/bootstrap-lite"])
@pytest.mark.parametrize("status", [401, 403, 500, 503])
def test_bootstrap_optional_auth_only_suppresses_auth_failures(
    read_client, monkeypatch, endpoint, status,
):
    from src.backend.routers import bootstrap

    def fail_auth(device_id):
        raise HTTPException(status_code=status, detail="synthetic auth failure")

    monkeypatch.setattr(bootstrap, "device_auth_record", fail_auth)
    response = read_client.get(endpoint, headers=headers("dev-alice"))
    if status in {401, 403}:
        assert response.status_code == 200
        body = response.json()
        assert body["extras"]["payments"] == []
        if endpoint == "/api/bootstrap":
            assert body["extras"]["connection_settings"] == []
            assert body["auth_devices"] == []
    else:
        assert response.status_code == status
        assert response.json() == {"detail": "synthetic auth failure"}


def test_lite_etag_does_not_reuse_another_members_payments(read_client):
    alice = read_client.get("/api/bootstrap-lite", headers=headers("dev-alice"))
    assert alice.status_code == 200
    assert alice.json()["extras"]["payments"] == [PAYMENTS[0]]
    alice_tag = alice.headers["ETag"]
    bob = read_client.get("/api/bootstrap-lite", headers={
        **headers("dev-bob"), "If-None-Match": alice_tag,
    })
    assert bob.status_code == 200
    assert bob.json()["extras"]["payments"] == [PAYMENTS[1]]
    assert bob.headers["ETag"] != alice_tag
    for device_id, tag in (("dev-alice", alice_tag), ("dev-bob", bob.headers["ETag"])):
        unchanged = read_client.get("/api/bootstrap-lite", headers={
            **headers(device_id), "If-None-Match": tag,
        })
        assert unchanged.status_code == 304
        assert unchanged.content == b""
        assert unchanged.headers["ETag"] == tag


@pytest.mark.parametrize("device_id,expected_payments", [
    (None, []), ("no-such-device", []),
    ("dev-alice", [PAYMENTS[0]]), ("dev-bob", [PAYMENTS[1]]),
    ("dev-admin", [PAYMENTS[2]]), ("dev-sysadmin", [PAYMENTS[3]]),
])
def test_lite_preserves_schema_and_only_personal_payments_for_every_role(
    read_client, device_id, expected_payments,
):
    response = read_client.get("/api/bootstrap-lite", headers=headers(device_id))
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "performances", "announcements", "members", "extras",
        "cloudRunRevision", "menu_visibility",
    }
    assert set(body["extras"]) == {"payments", "part_settings", "org_settings"}
    assert body["extras"]["payments"] == expected_payments
    for marker in (*ADMIN_DEVICES, "synthetic-account-marker", "synthetic-account-file"):
        assert marker not in response.text
    # Even administrators receive only their own rows through lite, and each
    # role (including anonymous) retains same-principal conditional requests.
    unchanged = read_client.get("/api/bootstrap-lite", headers={
        **headers(device_id), "If-None-Match": response.headers["ETag"],
    })
    assert unchanged.status_code == 304
    assert unchanged.content == b""
    assert unchanged.headers["ETag"] == response.headers["ETag"]


@pytest.mark.parametrize("device_id", [None, "dev-alice", "dev-bob", *ADMIN_DEVICES])
def test_core_keeps_shared_etag_and_response_without_personal_data(read_client, device_id):
    first = read_client.get("/api/bootstrap-core")
    assert first.status_code == 200
    assert set(first.json()) == {"extras", "cloudRunRevision", "menu_visibility"}
    assert first.json()["extras"] == {}
    response = read_client.get("/api/bootstrap-core", headers=headers(device_id))
    assert response.status_code == 200
    assert response.json() == first.json()
    assert response.headers["ETag"] == first.headers["ETag"]
    unchanged = read_client.get("/api/bootstrap-core", headers={
        **headers(device_id), "If-None-Match": first.headers["ETag"],
    })
    assert unchanged.status_code == 304
    assert unchanged.content == b""


@pytest.mark.parametrize("device_id", ADMIN_DEVICES)
def test_removed_admin_permission_cannot_reuse_warm_private_data(
    read_client, read_permission_env, device_id,
):
    # Prime the shared server collection caches with successful admin reads.
    # Keep the saved device role unchanged: authorization must resolve the
    # linked member's current permission on every subsequent response.
    for collection, expected in (("payments", PAYMENTS), ("connection_settings", CONNECTION_SETTINGS)):
        response = read_client.get(f"/api/extra/{collection}", headers=headers(device_id))
        assert response.status_code == 200
        assert response.json() == expected
    listed = read_client.get("/api/auth/devices", headers=headers(device_id))
    assert listed.status_code == 200
    assert {item["device_id"] for item in listed.json()} == {item[0] for item in DEVICES}
    full = read_client.get("/api/bootstrap", headers=headers(device_id))
    assert full.status_code == 200
    assert full.json()["extras"]["payments"] == PAYMENTS

    _, member_id, _, old_permission = next(item for item in DEVICES if item[0] == device_id)
    members = read_permission_env.load_json_data("members")
    for member in members:
        if member["id"] == member_id:
            member["permission"] = "一般"
    read_permission_env.save_json_data("members", members)
    saved_device = next(item for item in read_permission_env.load_json_data("auth_devices")
                        if item["device_id"] == device_id)
    assert saved_device["permission"] == old_permission

    for endpoint in ("/api/extra/payments", "/api/extra/connection_settings", "/api/auth/devices"):
        denied = read_client.get(endpoint, headers={
            **headers(device_id), "If-None-Match": "*",
        })
        assert denied.status_code == 403
        assert denied.json() == {"detail": "Admin permission is required"}
        for marker in (*ADMIN_DEVICES, "paid_until_month", "synthetic-account-marker"):
            assert marker not in denied.text
    filtered = read_client.get("/api/bootstrap", headers=headers(device_id))
    assert filtered.status_code == 200
    assert "no-store" in filtered.headers["Cache-Control"]
    body = filtered.json()
    assert body["extras"]["payments"] == [payment for payment in PAYMENTS if payment["member_id"] == member_id]
    assert body["extras"]["connection_settings"] == []
    assert body["auth_devices"] == []
    for marker in (*ADMIN_DEVICES, "synthetic-account-marker", "synthetic-account-file"):
        assert marker not in filtered.text


@pytest.mark.parametrize("change,expected_payments", [
    ({"member_id": 2}, [PAYMENTS[1]]),
    ({"member_name": "Renamed Alice"}, [PAYMENTS[0]]),
    ({"permission": "管理者"}, [PAYMENTS[0]]),
    (None, []),
])
def test_lite_etag_changes_with_same_devices_principal(
    read_client, monkeypatch, change, expected_payments,
):
    from src.backend.routers import bootstrap

    initial = read_client.get("/api/bootstrap-lite", headers=headers("dev-alice"))
    assert initial.status_code == 200
    old_tag = initial.headers["ETag"]
    device = {"member_id": 1, "member_name": "Alice", "permission": "一般"}
    device = {**device, **change} if change is not None else None
    # Change only the resolved principal, leaving all collection digests fixed.
    # This prevents a collection update from masking a missing principal scope.
    monkeypatch.setattr(bootstrap, "device_auth_record", lambda device_id: device)
    changed = read_client.get("/api/bootstrap-lite", headers={
        **headers("dev-alice"), "If-None-Match": old_tag,
    })
    assert changed.status_code == 200
    assert changed.headers["ETag"] != old_tag
    assert changed.json()["extras"]["payments"] == expected_payments
    unchanged = read_client.get("/api/bootstrap-lite", headers={
        **headers("dev-alice"), "If-None-Match": changed.headers["ETag"],
    })
    assert unchanged.status_code == 304


def test_lite_etag_separates_devices_even_for_same_member(read_client, monkeypatch):
    from src.backend.routers import bootstrap

    monkeypatch.setattr(bootstrap, "device_auth_record", lambda device_id: {
        "member_id": 1, "member_name": "Alice", "permission": "一般",
    })
    first = read_client.get("/api/bootstrap-lite", headers=headers("dev-alice"))
    assert first.status_code == 200
    second = read_client.get("/api/bootstrap-lite", headers={
        **headers("dev-bob"), "If-None-Match": first.headers["ETag"],
    })
    assert second.status_code == 200
    assert second.headers["ETag"] != first.headers["ETag"]
    assert second.json()["extras"]["payments"] == [PAYMENTS[0]]


@pytest.mark.parametrize("device_id,status", [
    (None, 401), ("no-such-device", 401), ("dev-alice", 403), ("dev-bob", 403),
])
def test_device_list_rejects_without_disclosing_any_device_id(read_client, device_id, status):
    response = read_client.get("/api/auth/devices", headers=headers(device_id))
    assert response.status_code == status
    if status == 403:
        assert response.json() == {"detail": "Admin permission is required"}
    for known_device_id, _, _, _ in DEVICES:
        assert known_device_id not in response.text
    assert "device_id" not in response.text


@pytest.mark.parametrize("device_id", ADMIN_DEVICES)
def test_admin_device_list_preserves_all_devices_and_disables_caching(
    read_client, read_permission_env, device_id,
):
    response = read_client.get("/api/auth/devices", headers=headers(device_id))
    assert response.status_code == 200
    assert "no-store" in response.headers["Cache-Control"]
    assert response.json() == read_permission_env.load_json_data("auth_devices")
    assert {item["device_id"] for item in response.json()} == {item[0] for item in DEVICES}
