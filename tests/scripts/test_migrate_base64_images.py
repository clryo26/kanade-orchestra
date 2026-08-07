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
        "promotions": [],
        "org_settings": [],
    }


def test_migrate_base64_images_dry_run_is_read_only(monkeypatch):
    store = _make_store()
    writes: list[tuple[str, list[dict[str, object]]]] = []
    uploads: list[str] = []

    monkeypatch.setattr(module, "load_json_data", lambda name: deepcopy(store.get(name, [])))
    monkeypatch.setattr(module, "save_json_data", lambda name, items: writes.append((name, deepcopy(items))))
    monkeypatch.setattr(
        module,
        "store_data_image",
        lambda value, *, object_prefix, route_path: uploads.append(route_path) or f"{route_path}?ext=png",
    )

    results = module.run_migration(apply=False, collections=["members"])

    assert results == [
        {
            "collection": "members",
            "field": "photo_url",
            "migrated": 0,
            "planned": 1,
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
    assert writes == []
    assert uploads == []
    assert store["members"][0]["photo_url"].startswith("data:image/")


def test_migrate_base64_images_apply_is_idempotent(monkeypatch):
    store = _make_store()
    writes: list[tuple[str, list[dict[str, object]]]] = []
    uploads: list[str] = []

    def fake_load_json_data(name: str):
        return deepcopy(store.get(name, []))

    def fake_save_json_data(name: str, items):
        store[name] = deepcopy(items)
        writes.append((name, deepcopy(items)))

    def fake_store_data_image(value, *, object_prefix, route_path):
        uploads.append(route_path)
        return f"{route_path}?ext=png"

    monkeypatch.setattr(module, "load_json_data", fake_load_json_data)
    monkeypatch.setattr(module, "save_json_data", fake_save_json_data)
    monkeypatch.setattr(module, "store_data_image", fake_store_data_image)

    first = module.run_migration(apply=True, collections=["members"])
    second = module.run_migration(apply=True, collections=["members"])

    assert first[0]["migrated"] == 1
    assert second[0]["migrated"] == 0
    assert store["members"][0]["photo_url"] == "/api/members/1/photo?ext=png"
    assert writes[0][0] == "members"
    assert len(uploads) == 1
