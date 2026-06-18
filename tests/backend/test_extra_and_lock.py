from __future__ import annotations


def _create_date_adjustment(client, device_id: str):
    return client.post(
        "/api/extra/date_adjustments",
        headers={"X-Device-Id": device_id},
        json={
            "title": "lock-test",
            "deadline": "2026-07-01",
            "notes": "n",
            "created_by": "owner-a",
            "candidates": [
                {
                    "id": "cand-1",
                    "date": "2026-07-10",
                    "start_time": "18:00",
                    "end_time": "21:00",
                    "note": "candidate",
                }
            ],
        },
    )


def test_extra_collection_not_found(client):
    response = client.get("/api/extra/not_found_collection")
    assert response.status_code == 404


def test_optimistic_lock_conflict_on_stale_update(client, seed_device_fn):
    seed_device_fn(
        device_id="dev-owner",
        permission="一般",
        member_name="owner-a",
    )

    created = _create_date_adjustment(client, "dev-owner")
    assert created.status_code == 200
    payload = created.json()
    item_id = payload["id"]
    stale_updated_at = payload["updated_at"]

    first_update = client.put(
        f"/api/extra/date_adjustments/{item_id}",
        headers={"X-Device-Id": "dev-owner"},
        json={
            "payload": {
                "title": "lock-test",
                "deadline": "2026-07-01",
                "notes": "updated-once",
                "created_by": "owner-a",
                "candidates": payload["candidates"],
            },
            "expected_updated_at": stale_updated_at,
        },
    )
    assert first_update.status_code == 200

    stale_update = client.put(
        f"/api/extra/date_adjustments/{item_id}",
        headers={"X-Device-Id": "dev-owner"},
        json={
            "payload": {
                "title": "lock-test",
                "deadline": "2026-07-01",
                "notes": "stale",
                "created_by": "owner-a",
                "candidates": payload["candidates"],
            },
            "expected_updated_at": stale_updated_at,
        },
    )
    assert stale_update.status_code == 409


def test_date_adjustment_owner_guard(client, seed_device_fn):
    seed_device_fn(device_id="dev-owner", permission="一般", member_name="owner-a")
    seed_device_fn(device_id="dev-other", permission="一般", member_name="owner-b")

    created = _create_date_adjustment(client, "dev-owner")
    assert created.status_code == 200
    body = created.json()

    denied = client.put(
        f"/api/extra/date_adjustments/{body['id']}",
        headers={"X-Device-Id": "dev-other"},
        json={
            "payload": {
                "title": body["title"],
                "deadline": body.get("deadline", ""),
                "notes": "hijack",
                "created_by": "owner-a",
                "candidates": body["candidates"],
            },
            "expected_updated_at": body["updated_at"],
        },
    )
    assert denied.status_code == 403


def test_date_adjustment_duplicate_candidate_validation(client, seed_device_fn):
    seed_device_fn(device_id="dev-owner", permission="一般", member_name="owner-a")
    response = client.post(
        "/api/extra/date_adjustments",
        headers={"X-Device-Id": "dev-owner"},
        json={
            "title": "dup",
            "created_by": "owner-a",
            "candidates": [
                {"id": "c1", "date": "2026-07-10", "start_time": "18:00", "end_time": "21:00"},
                {"id": "c2", "date": "2026-07-10", "start_time": "18:00", "end_time": "21:00"},
            ],
        },
    )
    assert response.status_code == 400


def test_date_adjustment_response_status_validation(client, seed_device_fn):
    seed_device_fn(device_id="dev-owner", permission="一般", member_name="owner-a")
    response = client.post(
        "/api/extra/date_adjustment_responses",
        headers={"X-Device-Id": "dev-owner"},
        json={
            "adjustment_id": 1,
            "candidate_id": "cand-1",
            "name": "owner-a",
            "status": "invalid",
            "note": "x",
        },
    )
    assert response.status_code == 400
