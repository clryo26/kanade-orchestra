from __future__ import annotations

from copy import deepcopy
import json

from fastapi import HTTPException
import pytest


@pytest.fixture
def album_case(backend_env, seed_device_fn):
    for device, member, permission in [
        ("creator", 1, "一般"),
        ("other", 2, "一般"),
        ("admin", 3, "管理者"),
        ("sys", 4, "システム管理者"),
    ]:
        seed_device_fn(
            device_id=device, member_id=member, member_name=device, permission=permission
        )
    photo = {
        "id": 11,
        "filename": "fixture.jpg",
        "object_name": "albums/synthetic/fixture.jpg",
        "url": "/api/albums/1/photos/11",
        "uploaded_by_member_id": 2,
        "uploaded_by_member_name": "other",
        "uploaded_at": "2026-10-23T00:00:00Z",
        "created_at": "2026-10-23T00:00:00Z",
        "updated_at": "2026-10-23T00:00:01Z",
    }
    album = {
        "id": 1,
        "event_name": "Before",
        "created_by_member_id": 1,
        "created_by_member_name": "creator",
        "created_at": "2026-10-23T00:00:00Z",
        "updated_at": "2026-10-23T00:00:02Z",
        "photos": [photo],
    }
    backend_env.save_json_data("albums", [album])
    return album


@pytest.mark.parametrize("wrapper", ["flat", "dict", "string"])
def test_omitted_photos_and_creator_fields_survive_real_http(
    client, backend_env, album_case, wrapper
):
    body = {"event_name": "After"}
    if wrapper != "flat":
        body = {
            "payload": body if wrapper == "dict" else json.dumps(body),
            "expected_updated_at": album_case["updated_at"],
        }
    response = client.put("/api/extra/albums/1", headers={"X-Device-Id": "creator"}, json=body)
    assert response.status_code == 200
    saved = backend_env.load_json_data("albums")[0]
    assert response.json()["photos"] == saved["photos"] == album_case["photos"]
    assert saved["event_name"] == "After"
    for key in ("created_by_member_id", "created_by_member_name", "created_at"):
        assert saved[key] == album_case[key]
    # The creator still has authority after the partial update.
    assert (
        client.put(
            "/api/extra/albums/1", headers={"X-Device-Id": "creator"}, json={"event_name": "Again"}
        ).status_code
        == 200
    )


@pytest.mark.parametrize("value", [None, "", {}, 0, False, [None], [1], [{"id": 11}, "bad"]])
def test_invalid_photo_shapes_reject_without_saving(client, backend_env, album_case, value):
    response = client.put(
        "/api/extra/albums/1",
        headers={"X-Device-Id": "creator"},
        json={"event_name": "No save", "photos": value},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "写真情報の形式が正しくありません"
    assert backend_env.load_json_data("albums")[0] == album_case


@pytest.mark.parametrize(
    "actor,status", [("creator", 200), ("admin", 200), ("sys", 200), ("other", 403), ("", 401)]
)
def test_explicit_empty_array_keeps_existing_authority(
    client, backend_env, album_case, actor, status, monkeypatch
):
    from src.backend.services import album_service

    def no_delete(*args):
        pytest.fail("Generic PUT must not start physical object deletion")

    monkeypatch.setattr(album_service, "_delete_unreferenced", no_delete)
    response = client.put(
        "/api/extra/albums/1",
        headers={"X-Device-Id": actor},
        json={"event_name": "After", "photos": []},
    )
    assert response.status_code == status
    assert backend_env.load_json_data("albums")[0]["photos"] == (
        [] if status == 200 else album_case["photos"]
    )


def test_unauthorized_and_stale_take_precedence_over_bad_photos(client, backend_env, album_case):
    bad = {"event_name": "After", "photos": None}
    response = client.put("/api/extra/albums/1", headers={"X-Device-Id": "other"}, json=bad)
    assert response.status_code == 403
    response = client.put(
        "/api/extra/albums/1",
        headers={"X-Device-Id": "creator"},
        json={"payload": bad, "expected_updated_at": "2026-10-23T00:00:01Z"},
    )
    assert response.status_code == 409
    assert backend_env.load_json_data("albums")[0] == album_case


@pytest.mark.parametrize("version", ["2026-10-23T00:00:02Z", "2026-10-23T09:00:02+09:00", ""])
def test_expected_version_equivalence_and_legacy(client, album_case, version):
    response = client.put(
        "/api/extra/albums/1",
        headers={"X-Device-Id": "creator"},
        json={"payload": {"event_name": "After"}, "expected_updated_at": version},
    )
    assert response.status_code == 200


def test_explicit_creator_field_still_applies_and_omitted_one_is_kept(
    client, backend_env, album_case
):
    response = client.put(
        "/api/extra/albums/1",
        headers={"X-Device-Id": "admin"},
        json={"event_name": "After", "created_by_member_name": "explicit name"},
    )
    assert response.status_code == 200
    saved = backend_env.load_json_data("albums")[0]
    assert saved["created_by_member_id"] == 1 and saved["created_by_member_name"] == "explicit name"
    assert saved["photos"] == album_case["photos"]


@pytest.mark.parametrize("photos", ["missing", None])
def test_legacy_empty_photos_in_local_store(photos):
    from src.backend.repositories.db_item_repository import ListRowStore

    current = {"id": 1, "event_name": "Before"}
    if photos is None:
        current["photos"] = None
    data = [current]
    store = ListRowStore(
        lambda name: data, lambda name, items: data.__setitem__(slice(None), items)
    )
    assert store.update("albums", 1, lambda row: {"event_name": "After"})["photos"] == []


@pytest.mark.parametrize("photos", ["private bad data", {}, [None]])
def test_bad_stored_photos_stop_after_authorization_without_mutating(photos, caplog):
    from src.backend.repositories.db_item_repository import ListRowStore

    current = {"id": 1, "photos": photos}
    original = deepcopy(current)
    store = ListRowStore(lambda name: [current], lambda *args: pytest.fail("No save allowed"))
    with pytest.raises(HTTPException) as denied:
        store.update("albums", 1, lambda row: (_ for _ in ()).throw(HTTPException(403, "denied")))
    assert denied.value.status_code == 403
    assert "stored photos" not in caplog.text
    with pytest.raises(RuntimeError, match="Stored album photos have invalid format"):
        store.update("albums", 1, lambda row: {"photos": []})
    assert current == original
    assert "Album update blocked" in caplog.text and "private bad data" not in caplog.text


def test_mutator_nested_changes_do_not_corrupt_omission_snapshot_or_failed_write():
    from src.backend.repositories.db_item_repository import ListRowStore

    data = [{"id": 1, "photos": [{"id": 11, "object_name": "original"}]}]

    def save(name, items):
        data[:] = items

    store = ListRowStore(lambda name: data, save)

    def mutate(current):
        current["photos"][0]["object_name"] = "mutated"
        return {"event_name": "After"}

    saved = store.update("albums", 1, mutate)
    assert saved["photos"] == [{"id": 11, "object_name": "original"}]

    def fail(current):
        current["photos"].clear()
        return {"photos": None}

    with pytest.raises(HTTPException):
        store.update("albums", 1, fail)
    assert data[0]["photos"] == saved["photos"]


def test_direct_album_service_and_repository_preserve_current_photos(backend_env, album_case):
    from src.backend.services import album_service
    from src.backend.repositories.album_repository import AlbumRepository

    # This service already merges photos explicitly; its existing server
    # timestamp handling is retained. The next mutator really omits photos.
    saved = album_service.update_album(1, {"event_name": "Service"})
    for key in ("id", "object_name", "uploaded_at", "created_at"):
        assert saved["photos"][0][key] == album_case["photos"][0][key]
    assert (
        AlbumRepository().update(1, lambda row: {"event_name": "Repository"})["photos"]
        == saved["photos"]
    )


def test_other_collection_omission_contract_is_not_changed():
    from src.backend.repositories.db_item_repository import ListRowStore

    saved = []
    store = ListRowStore(
        lambda name: [{"id": 1, "members": [{"member_id": 2}]}],
        lambda name, items: saved.extend(items),
    )
    store.update("castings", 1, lambda row: {"piece": "After"})
    assert "members" not in saved[0]


def test_album_other_parent_fields_do_not_become_a_general_patch(client, backend_env, album_case):
    response = client.put(
        "/api/extra/albums/1", headers={"X-Device-Id": "creator"}, json={"photos": []}
    )
    assert response.status_code == 200
    saved = backend_env.load_json_data("albums")[0]
    assert "event_name" not in saved
    assert saved["created_by_member_id"] == 1 and saved["created_by_member_name"] == "creator"


def test_explicit_creator_id_keeps_omitted_name(client, backend_env, album_case):
    response = client.put(
        "/api/extra/albums/1",
        headers={"X-Device-Id": "admin"},
        json={"event_name": "After", "created_by_member_id": 9},
    )
    assert response.status_code == 200
    saved = backend_env.load_json_data("albums")[0]
    assert saved["created_by_member_id"] == 9 and saved["created_by_member_name"] == "creator"
