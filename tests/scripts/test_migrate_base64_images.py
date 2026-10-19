from __future__ import annotations

from copy import deepcopy

from scripts import migrate_base64_images as module


def _make_store():
    return {
        "members": [
            {"id": 1, "photo_url": "data:image/png;base64,ZmFrZQ=="},
            {"id": 2, "photo_url": "/api/members/2/photo?ext=png"},
        ],
        "performances": [],
        "org_settings": [],
    }


def test_migrate_base64_images_dry_run_is_read_only(monkeypatch):
    store = _make_store()
    calls: list[tuple] = []

    monkeypatch.setattr(module, "load_json_data", lambda name: deepcopy(store.get(name, [])))

    async def fake_migrate(*args, **kwargs):
        calls.append(args)
        return 200, {}

    monkeypatch.setattr(module, "migrate_inline_image", fake_migrate)

    results = module.run_migration(apply=False, collections=["members"])

    assert results == [
        {
            "collection": "members",
            "field": "photo_url",
            "migrated": 0,
            "planned": 1,
            "failed": [],
            "changes": [
                {
                    "collection": "members",
                    "id": 1,
                    "field": "photo_url",
                    "from": "data:image/png;base64,ZmFrZQ==",
                    "to": "/api/members/1/photo",
                }
            ],
        }
    ]
    assert calls == []
    assert store["members"][0]["photo_url"].startswith("data:image/")


def test_migrate_base64_images_apply_is_idempotent_and_uses_file_operations(monkeypatch):
    store = _make_store()
    calls: list[tuple] = []

    monkeypatch.setattr(module, "load_json_data", lambda name: deepcopy(store.get(name, [])))

    async def fake_migrate(kind, owner_id, expected_value, *, run_id):
        calls.append((kind, owner_id, run_id))
        url = f"/api/members/{owner_id}/photo?asset=a&ext=png"
        store["members"][0]["photo_url"] = url
        return 200, {"to": url}

    monkeypatch.setattr(module, "migrate_inline_image", fake_migrate)

    first = module.run_migration(apply=True, collections=["members"], run_id="r1")
    second = module.run_migration(apply=True, collections=["members"], run_id="r1")

    assert first[0]["migrated"] == 1
    assert second[0]["migrated"] == 0
    assert calls == [("member_photo", 1, "r1")]
    assert store["members"][0]["photo_url"] == "/api/members/1/photo?asset=a&ext=png"


def test_migrate_base64_images_reports_rows_changed_meanwhile(monkeypatch):
    store = _make_store()
    monkeypatch.setattr(module, "load_json_data", lambda name: deepcopy(store.get(name, [])))

    async def stale(*args, **kwargs):
        return 409, {"detail": "changed"}

    monkeypatch.setattr(module, "migrate_inline_image", stale)
    result = module.run_migration(apply=True, collections=["members"])
    assert result[0]["migrated"] == 0
    assert result[0]["failed"] == [{"collection": "members", "id": 1, "field": "photo_url", "from": "data:image/png;base64,ZmFrZQ==", "status": 409}]
