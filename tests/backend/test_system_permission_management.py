from __future__ import annotations


SYSTEM_ADMIN = "システム管理者"


def _member_payload(name: str, permission: str) -> dict[str, object]:
    return {
        "name": name,
        "last_name": name,
        "first_name": "太郎",
        "part": "Vn",
        "permission": permission,
    }


def _create_member(client, headers: dict[str, str], name: str, permission: str) -> dict[str, object]:
    response = client.post("/api/members", headers=headers, json=_member_payload(name, permission))
    assert response.status_code == 200
    return response.json()


def test_normal_member_routes_cannot_grant_system_permission(client, seed_device_fn, admin_headers_fixture):
    seed_device_fn(device_id="dev-admin", permission="管理者")

    create_denied = client.post(
        "/api/members",
        headers=admin_headers_fixture,
        json=_member_payload("Create denied", SYSTEM_ADMIN),
    )
    assert create_denied.status_code == 400

    member = _create_member(client, admin_headers_fixture, "General member", "一般")
    update_denied = client.put(
        f"/api/members/{member['id']}",
        headers=admin_headers_fixture,
        json=_member_payload("General member", SYSTEM_ADMIN),
    )
    assert update_denied.status_code == 400

    update_allowed = client.put(
        f"/api/members/{member['id']}",
        headers=admin_headers_fixture,
        json=_member_payload("General member", "管理者"),
    )
    assert update_allowed.status_code == 200
    assert update_allowed.json()["permission"] == "管理者"


def test_system_permission_route_requires_system_admin_and_validates_value(client, seed_device_fn, admin_headers_fixture):
    seed_device_fn(device_id="dev-admin", permission="管理者")
    seed_device_fn(device_id="dev-system", permission=SYSTEM_ADMIN)
    member = _create_member(client, admin_headers_fixture, "Permission target", "一般")

    forbidden = client.put(
        f"/api/system/members/{member['id']}/permission",
        headers=admin_headers_fixture,
        json={"permission": SYSTEM_ADMIN},
    )
    assert forbidden.status_code == 403

    invalid = client.put(
        f"/api/system/members/{member['id']}/permission",
        headers={"X-Device-Id": "dev-system"},
        json={"permission": "invalid"},
    )
    assert invalid.status_code == 400

    granted = client.put(
        f"/api/system/members/{member['id']}/permission",
        headers={"X-Device-Id": "dev-system"},
        json={"permission": SYSTEM_ADMIN},
    )
    assert granted.status_code == 200
    assert granted.json()["permission"] == SYSTEM_ADMIN

    listed = client.get("/api/system/members", headers={"X-Device-Id": "dev-system"})
    assert listed.status_code == 200
    assert {item["id"] for item in listed.json()} == {member["id"]}


def test_member_permission_change_overrides_stale_device_permission(client, seed_device_fn, admin_headers_fixture):
    seed_device_fn(device_id="dev-admin", permission="管理者")
    seed_device_fn(device_id="dev-system", permission=SYSTEM_ADMIN)
    member = _create_member(client, admin_headers_fixture, "Session target", "一般")
    seed_device_fn(
        device_id="dev-target",
        member_id=member["id"],
        member_name="Session target",
        permission="一般",
    )

    granted = client.put(
        f"/api/system/members/{member['id']}/permission",
        headers={"X-Device-Id": "dev-system"},
        json={"permission": SYSTEM_ADMIN},
    )
    assert granted.status_code == 200
    assert client.get("/api/system/readiness-summary", headers={"X-Device-Id": "dev-target"}).status_code == 200
    current_session = client.get("/api/auth/devices/dev-target")
    assert current_session.json()["device"]["permission"] == SYSTEM_ADMIN

    removed = client.put(
        f"/api/members/{member['id']}",
        headers={"X-Device-Id": "dev-target"},
        json=_member_payload("Session target", "管理者"),
    )
    assert removed.status_code == 200
    assert client.get("/api/system/readiness-summary", headers={"X-Device-Id": "dev-target"}).status_code == 403
    downgraded_session = client.get("/api/auth/devices/dev-target")
    assert downgraded_session.json()["device"]["permission"] == "管理者"
