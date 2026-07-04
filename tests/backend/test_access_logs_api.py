from __future__ import annotations


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

    listed = client.get("/api/system/access-logs?limit=10", headers={"X-Device-Id": "dev-system"})
    assert listed.status_code == 200
    rows = listed.json()
    assert any(item.get("menu_key") == "member-home" for item in rows)
