from __future__ import annotations


def _headers(device_id: str) -> dict[str, str]:
    return {"X-Device-Id": device_id}


def _seed_general_members(seed_device_fn) -> None:
    seed_device_fn(
        device_id="dev-owner",
        permission="一般",
        member_id="member-owner",
        member_name="owner-a",
    )
    seed_device_fn(
        device_id="dev-other",
        permission="一般",
        member_id="member-other",
        member_name="owner-b",
    )


def test_general_member_can_create_and_update_own_desired_piece(client, seed_device_fn):
    _seed_general_members(seed_device_fn)
    created = client.post(
        "/api/extra/desired_pieces",
        headers=_headers("dev-owner"),
        json={
            "title": "Symphony No. 1",
            "composer": "Composer A",
            "member_id": "forged-member",
            "registered_by": "forged-name",
            "votes": [],
        },
    )
    assert created.status_code == 200
    body = created.json()
    assert body["member_id"] == "member-owner"
    assert body["registered_by"] == "owner-a"

    updated = client.put(
        f"/api/extra/desired_pieces/{body['id']}",
        headers=_headers("dev-owner"),
        json={
            "payload": {
                **body,
                "title": "Symphony No. 1 revised",
                "member_id": "forged-again",
                "registered_by": "forged-again",
            },
            "expected_updated_at": body["updated_at"],
        },
    )
    assert updated.status_code == 200
    updated_body = updated.json()
    assert updated_body["title"] == "Symphony No. 1 revised"
    assert updated_body["member_id"] == "member-owner"
    assert updated_body["registered_by"] == "owner-a"


def test_general_member_can_vote_but_cannot_edit_other_desired_piece(client, seed_device_fn):
    _seed_general_members(seed_device_fn)
    created = client.post(
        "/api/extra/desired_pieces",
        headers=_headers("dev-owner"),
        json={"title": "Symphony No. 2", "composer": "Composer B", "votes": []},
    )
    assert created.status_code == 200
    body = created.json()

    voted = client.put(
        f"/api/extra/desired_pieces/{body['id']}",
        headers=_headers("dev-other"),
        json={
            "payload": {
                **body,
                "votes": [{"member_id": "member-other", "name": "owner-b"}],
            },
            "expected_updated_at": body["updated_at"],
        },
    )
    assert voted.status_code == 200
    voted_body = voted.json()

    denied_update = client.put(
        f"/api/extra/desired_pieces/{body['id']}",
        headers=_headers("dev-other"),
        json={
            "payload": {**voted_body, "title": "Unauthorized title"},
            "expected_updated_at": voted_body["updated_at"],
        },
    )
    assert denied_update.status_code == 403

    denied_delete = client.delete(
        f"/api/extra/desired_pieces/{body['id']}",
        headers=_headers("dev-other"),
    )
    assert denied_delete.status_code == 403


def test_general_member_can_manage_only_own_promotion(client, seed_device_fn):
    _seed_general_members(seed_device_fn)
    created = client.post(
        "/api/extra/promotions",
        headers=_headers("dev-owner"),
        json={
            "title": "Owner promotion",
            "description": "Initial",
            "member_id": "forged-member",
            "registered_by": "forged-name",
        },
    )
    assert created.status_code == 200
    body = created.json()
    assert body["member_id"] == "member-owner"
    assert body["registered_by"] == "owner-a"

    updated = client.put(
        f"/api/extra/promotions/{body['id']}",
        headers=_headers("dev-owner"),
        json={
            "payload": {**body, "description": "Updated"},
            "expected_updated_at": body["updated_at"],
        },
    )
    assert updated.status_code == 200

    denied_update = client.put(
        f"/api/extra/promotions/{body['id']}",
        headers=_headers("dev-other"),
        json={
            "payload": {**updated.json(), "description": "Unauthorized"},
            "expected_updated_at": updated.json()["updated_at"],
        },
    )
    assert denied_update.status_code == 403

    denied_delete = client.delete(
        f"/api/extra/promotions/{body['id']}",
        headers=_headers("dev-other"),
    )
    assert denied_delete.status_code == 403
