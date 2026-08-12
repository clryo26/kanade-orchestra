from __future__ import annotations

from src.backend.routers import access_logs as access_logs_router


def test_access_log_create_and_list(client, seed_device_fn):
    seed_device_fn(device_id="dev-member", permission="一般", member_name="User", member_id=10)
    seed_device_fn(device_id="dev-system", permission="システム管理者", member_name="Sys", member_id=1)

    created = client.post(
        "/api/system/access-logs",
        headers={"X-Device-Id": "dev-member"},
        json={"menu_key": "member-home", "menu_label": "ポータルトップ", "panel": "団員メニュー"},
    )
    assert created.status_code == 200
    payload = created.json()
    assert payload["menu_key"] == "member-home"
    assert payload["member_name"] == "User"

    listed = client.get("/api/system/access-logs?page=1", headers={"X-Device-Id": "dev-system"})
    assert listed.status_code == 200
    data = listed.json()
    assert data["page"] == 1
    assert data["page_size"] == 100
    rows = data["items"]
    assert any(item.get("menu_key") == "member-home" for item in rows)


def test_access_log_create_uses_single_insert_in_db_mode(
    client,
    backend_env,
    seed_device_fn,
    monkeypatch,
):
    seed_device_fn(
        device_id="dev-member",
        permission="member",
        member_name="User",
        member_id=10,
    )

    inserted_payloads = []

    def fake_insert(payload):
        inserted_payloads.append(dict(payload))
        return {**payload, "id": 321}

    def fail_collection_access(*_args, **_kwargs):
        raise AssertionError("DB access-log creation must not use collection load/save")

    backend_env._memory_cache.set(
        "access_logs",
        [{"id": 1, "menu_key": "stale"}],
    )

    monkeypatch.setattr(access_logs_router, "db_data_enabled", lambda: True)
    monkeypatch.setattr(access_logs_router, "insert_access_log", fake_insert)
    monkeypatch.setattr(access_logs_router, "load_json_data", fail_collection_access)
    monkeypatch.setattr(access_logs_router, "save_json_data", fail_collection_access)
    monkeypatch.setattr(
        access_logs_router,
        "get_memory_cache",
        lambda: backend_env._memory_cache,
    )

    created = client.post(
        "/api/system/access-logs",
        headers={"X-Device-Id": "dev-member"},
        json={
            "menu_key": "member-home",
            "menu_label": "Portal",
            "panel": "Member menu",
        },
    )

    assert created.status_code == 200
    assert created.json()["id"] == 321
    assert len(inserted_payloads) == 1
    assert "id" not in inserted_payloads[0]
    assert inserted_payloads[0]["menu_key"] == "member-home"
    assert backend_env._memory_cache.get("access_logs") is None


def test_access_log_list_forwards_db_filters_and_page(client, seed_device_fn, monkeypatch):
    seed_device_fn(
        device_id="dev-system",
        permission="システム管理者",
        member_name="Sys",
        member_id=1,
    )
    captured = {}

    def fake_query_access_logs(**kwargs):
        captured.update(kwargs)
        return {"items": [], "page": 3, "page_size": 100, "total": 0, "total_pages": 1}

    monkeypatch.setattr(access_logs_router, "db_data_enabled", lambda: True)
    monkeypatch.setattr(access_logs_router, "query_access_logs", fake_query_access_logs)

    response = client.get(
        "/api/system/access-logs"
        "?date_from=2026-08-01T00:00:00Z"
        "&date_to=2026-08-03T00:00:00Z"
        "&member_id=10"
        "&member_part=Clarinet"
        "&page=3",
        headers={"X-Device-Id": "dev-system"},
    )

    assert response.status_code == 200
    assert captured["date_from"].isoformat() == "2026-08-01T00:00:00+00:00"
    assert captured["date_to"].isoformat() == "2026-08-03T00:00:00+00:00"
    assert captured["member_id"] == 10
    assert captured["member_part"] == "Clarinet"
    assert captured["page"] == 3


def test_access_log_json_search_uses_fixed_100_item_pages():
    items = [
        {
            "id": index,
            "member_id": 10,
            "member_part": "Clarinet",
            "accessed_at": "2026-08-01T00:00:00+00:00",
        }
        for index in range(205)
    ]

    result = access_logs_router.access_log_service.search_access_logs(
        items,
        member_id=10,
        member_part="Clarinet",
        page=2,
    )

    assert result["total"] == 205
    assert result["page"] == 2
    assert result["page_size"] == 100
    assert result["total_pages"] == 3
    assert len(result["items"]) == 100
