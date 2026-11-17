from __future__ import annotations

from tests.conftest import seed_device


def _setup(backend_env) -> None:
    backend_env.save_json_data(
        "members",
        [
            {"id": 1, "last_name": "佐藤", "first_name": "花子", "maiden_name": "山田", "permission": "一般"},
            {"id": 2, "last_name": "佐藤", "first_name": "花子", "maiden_name": "山田", "permission": "一般"},
        ],
    )
    backend_env.save_json_data("events", [{"id": 10, "title": "練習会", "date": "2026-12-01"}])
    seed_device(backend_env, device_id="event-1", member_id=1, member_name="佐藤花子", permission="一般")
    seed_device(backend_env, device_id="event-2", member_id=2, member_name="佐藤花子", permission="一般")


def _headers(who: int) -> dict[str, str]:
    return {"X-Device-Id": f"event-{who}"}


def test_create_works_with_maiden_name_and_without_legacy_client_id(client, backend_env):
    _setup(backend_env)
    # Front-end display name contains maiden surname; server's auth name does not.
    created = client.post(
        "/api/extra/event_responses", headers=_headers(1),
        json={"event_id": 10, "name": "佐藤(山田)花子", "status": "参加"},
    )
    assert created.status_code == 200, created.text
    assert str(created.json()["member_id"]) == "1"
    assert created.json()["name"] == "佐藤(山田)花子"


def test_owner_can_update_with_member_id_even_after_name_change(client, backend_env):
    _setup(backend_env)
    created = client.post(
        "/api/extra/event_responses", headers=_headers(1),
        json={"event_id": 10, "name": "佐藤(山田)花子", "status": "参加"},
    )
    assert created.status_code == 200, created.text
    row = created.json()
    updated = client.put(
        f"/api/extra/event_responses/{row['id']}", headers=_headers(1),
        json={"event_id": 10, "member_id": 999, "name": "新表示名", "status": "不参加"},
    )
    assert updated.status_code == 200, updated.text
    assert str(updated.json()["member_id"]) == "1"
    assert updated.json()["status"] == "不参加"
    assert updated.json()["name"] == "新表示名"


def test_other_member_with_identical_name_cannot_modify_or_delete(client, backend_env):
    _setup(backend_env)
    created = client.post(
        "/api/extra/event_responses", headers=_headers(1),
        json={"event_id": 10, "name": "佐藤(山田)花子", "status": "参加"},
    )
    assert created.status_code == 200, created.text
    row = created.json()
    denied_update = client.put(
        f"/api/extra/event_responses/{row['id']}", headers=_headers(2),
        json={"event_id": 10, "member_id": 2, "name": "佐藤(山田)花子", "status": "不参加"},
    )
    assert denied_update.status_code == 403, denied_update.text
    denied_delete = client.delete(f"/api/extra/event_responses/{row['id']}", headers=_headers(2))
    assert denied_delete.status_code == 403, denied_delete.text
    assert client.get("/api/extra/event_responses").json()[0]["status"] == "参加"


def test_forged_member_id_cannot_take_ownership_on_create(client, backend_env):
    _setup(backend_env)
    created = client.post(
        "/api/extra/event_responses", headers=_headers(1),
        json={"event_id": 10, "member_id": 2, "name": "偽名", "status": "参加"},
    )
    assert created.status_code == 200, created.text
    assert str(created.json()["member_id"]) == "1"


def test_ambiguous_legacy_name_only_response_cannot_be_claimed(client, backend_env):
    _setup(backend_env)
    backend_env.save_json_data(
        "event_responses", [{"id": 9, "event_id": 10, "name": "佐藤花子", "status": "参加"}],
    )
    denied = client.put(
        "/api/extra/event_responses/9", headers=_headers(1),
        json={"event_id": 10, "name": "佐藤花子", "status": "不参加"},
    )
    assert denied.status_code == 403, denied.text


def test_unique_legacy_name_only_response_can_be_claimed_by_owner(client, backend_env):
    _setup(backend_env)
    backend_env.save_json_data(
        "members", [{"id": 1, "last_name": "佐藤", "first_name": "花子", "maiden_name": "山田", "permission": "一般"}],
    )
    backend_env.save_json_data(
        "event_responses", [{"id": 9, "event_id": 10, "name": "佐藤花子", "status": "参加"}],
    )
    updated = client.put(
        "/api/extra/event_responses/9", headers=_headers(1),
        json={"event_id": 10, "name": "佐藤花子", "status": "不参加"},
    )
    assert updated.status_code == 200, updated.text
    assert str(updated.json()["member_id"]) == "1"
