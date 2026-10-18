from __future__ import annotations

import hashlib
from contextlib import contextmanager
from uuid import uuid4

import pytest

from src.backend.repositories import promotion_repository as repo
from src.backend.services import promotion_service as service
from src.backend.services import promotion_image_service as images
from src.backend.services.memory_cache import MemoryCache

PNG = b"\x89PNG\r\n\x1a\n" + b"test-promotion-image"
ADMIN = {"permission": "システム管理者", "hidden_user": True, "member_id": None, "member_name": "Administrator"}


@pytest.fixture
def promotion_client(client, backend_env):
    backend_env.save_json_data("auth_devices", [{"id": 1, "device_id": "promotion-admin", **ADMIN}])
    return client


def headers(key=None):
    return {"X-Device-Id": "promotion-admin", "Idempotency-Key": key or str(uuid4())}


def create(client, key=None, image=True):
    if not image:
        return client.post("/api/extra/promotions", headers=headers(key), json={"title": "Concert", "summary": "Description"})
    return client.post("/api/extra/promotions", headers=headers(key),
                       data={"title": "Concert", "summary": "Description", "image_action": "replace" if image else "remove"},
                       files={"image_url_file": ("flyer.png", PNG, "image/png")} if image else None)


def test_multipart_create_replay_and_list(promotion_client):
    key = str(uuid4())
    created = create(promotion_client, key)
    assert created.status_code == 200, created.text
    assert created.json()["registered_by"] == "Administrator"
    assert "image_url_file" not in created.json()
    assert create(promotion_client, key).json() == created.json()
    listing = promotion_client.get("/api/extra/promotions")
    assert listing.status_code == 200
    assert listing.headers["cache-control"] == "no-store"
    assert len(listing.json()) == 1
    image = promotion_client.get(created.json()["image_url"])
    assert image.status_code == 200 and image.content == PNG


def test_old_form_without_operation_key_gets_reload_guidance(promotion_client):
    response = promotion_client.post("/api/extra/promotions", headers={"X-Device-Id": "promotion-admin"},
                                     json={"title": "Old form"})
    assert response.status_code == 422
    assert "再読み込み" in response.json()["detail"]
    assert repo.list_items() == []


def test_notifications_follow_committed_changes_not_replay_noop_conflict_or_delete(promotion_client, monkeypatch):
    calls = []

    def notified(kind, body, operation):
        # A separate read must already see the committed record when notified.
        assert repo.get_item(body["id"])["title"] == body["title"]
        calls.append((kind, operation))

    monkeypatch.setattr(service, "emit", notified)
    key = str(uuid4())
    item = create(promotion_client, key=key, image=False).json()
    assert create(promotion_client, key=key, image=False).status_code == 200
    assert calls == [("promotions", "created")]
    unchanged = promotion_client.put(f"/api/extra/promotions/{item['id']}", headers=headers(),
                                     json={"title": item["title"], "summary": item["summary"], "expected_revision": 1}).json()
    assert calls == [("promotions", "created")]
    changed = promotion_client.put(f"/api/extra/promotions/{item['id']}", headers=headers(),
                                   json={"title": "Changed", "expected_revision": unchanged["revision"]}).json()
    assert calls == [("promotions", "created"), ("promotions", "updated")]
    assert promotion_client.put(f"/api/extra/promotions/{item['id']}", headers=headers(),
                                json={"title": "Stale", "expected_revision": 1}).status_code == 409
    assert promotion_client.request("DELETE", f"/api/extra/promotions/{item['id']}", headers=headers(),
                                    json={"expected_revision": changed["revision"]}).status_code == 200
    assert len(calls) == 2


def test_legacy_image_survives_list_and_summary_edit(promotion_client):
    import base64

    image_url = "data:image/png;base64," + base64.b64encode(PNG).decode()
    repo.seed_local([{"id": 91, "title": "Existing", "image_url": image_url}])
    image_path = "/api/extra/promotions/91/image"
    assert promotion_client.get(image_path).content == PNG
    updated = promotion_client.put("/api/extra/promotions/91", headers=headers(),
                                   json={"title": "Edited", "summary": "Changed", "expected_revision": 1,
                                         "image_action": "keep"})
    assert updated.status_code == 200, updated.text
    assert updated.json()["image_url"] == image_url
    assert promotion_client.get(image_path).content == PNG
    # A caller cannot use a missing asset ID to read an unrelated v2 asset.
    new = create(promotion_client).json()
    assert promotion_client.get(f"/api/extra/promotions/{new['id']}/image").status_code == 404


def test_legacy_stored_image_is_served_without_asset_id(promotion_client):
    from src.backend.services.image_asset_service import store_data_image
    import base64

    data_url = "data:image/png;base64," + base64.b64encode(PNG).decode()
    route = "/api/extra/promotions/92/image"
    image_url = store_data_image(data_url, object_prefix="promotion-images/92/image", route_path=route)
    repo.seed_local([{"id": 92, "title": "Existing", "image_url": image_url}])
    image = promotion_client.get(image_url)
    assert image.status_code == 200
    assert image.content == PNG


def test_same_format_replace_and_delete_replay(promotion_client):
    old = create(promotion_client).json()
    updated = promotion_client.put(f"/api/extra/promotions/{old['id']}", headers=headers(),
                                  data={"title": "New", "expected_revision": old["revision"], "image_action": "replace"},
                                  files={"image_url_file": ("new.png", PNG + b"new", "image/png")})
    assert updated.status_code == 200, updated.text
    assert updated.json()["image_url"] != old["image_url"]
    assert updated.json()["revision"] == 2
    assert promotion_client.get(updated.json()["image_url"]).status_code == 200
    stale = promotion_client.put(f"/api/extra/promotions/{old['id']}", headers=headers(),
                                json={"title": "Stale", "expected_revision": 1})
    assert stale.status_code == 409
    key = str(uuid4())
    options = dict(headers=headers(key), json={"expected_revision": 2})
    assert promotion_client.request("DELETE", f"/api/extra/promotions/{old['id']}", **options).status_code == 200
    assert promotion_client.request("DELETE", f"/api/extra/promotions/{old['id']}", **options).status_code == 200
    assert promotion_client.get("/api/extra/promotions").json() == []
    assert promotion_client.get(updated.json()["image_url"]).status_code == 404
    assert len(images.cleanup(execute=True)) == 2


def test_failed_upload_does_not_pollute_list(promotion_client, monkeypatch):
    monkeypatch.setattr(images, "upload", lambda *args: (_ for _ in ()).throw(RuntimeError("test failure")))
    assert create(promotion_client).status_code == 503
    assert promotion_client.get("/api/extra/promotions").json() == []


def test_commit_acknowledgement_loss_returns_durable_result(promotion_client, monkeypatch):
    original_transaction = repo.transaction
    original_finish = repo.finish
    state = {"committing": False, "raised": False}

    def finish(*args):
        original_finish(*args)
        state["committing"] = True

    @contextmanager
    def transaction():
        with original_transaction() as cur:
            yield cur
        if state["committing"] and not state["raised"]:
            state["raised"] = True
            raise ConnectionError("commit acknowledgement lost")

    monkeypatch.setattr(repo, "finish", finish)
    monkeypatch.setattr(repo, "transaction", transaction)
    created = create(promotion_client)
    assert created.status_code == 200, created.text
    assert promotion_client.get(created.json()["image_url"]).status_code == 200


def test_old_attempt_cannot_reject_or_release_new_success(backend_env):
    key = str(uuid4())
    digest = hashlib.sha256(b"request").hexdigest()
    old, _, _ = repo.reserve("test-actor", key, "POST", None, digest)
    with repo.transaction() as cur:
        cur.execute("UPDATE promotion_operations SET lease_until=%s WHERE operation_id=%s", ("2000-01-01T00:00:00+00:00", key))
    new, claimed, _ = repo.reserve("test-actor", key, "POST", None, digest)
    assert claimed and new["attempt_id"] != old["attempt_id"]
    with repo.transaction() as cur:
        repo.finish(cur, new, 200, {"id": 123})
    with pytest.raises(repo.LostAttempt):
        with repo.transaction() as cur:
            repo.finish(cur, old, 409, {"detail": "stale"})
    with pytest.raises(repo.LostAttempt):
        repo.release(old)
    assert service.current_result("test-actor", key) == (200, {"id": 123})


def test_cache_keeps_previous_data_and_etag_on_serialization_error():
    cache = MemoryCache()
    cache.set("promotions", [{"id": 1}])
    before = cache.etag("promotions")
    with pytest.raises(TypeError):
        cache.set("promotions", [{"file": object()}])
    assert cache.get("promotions") == [{"id": 1}]
    assert cache.etag("promotions") == before


def test_permissions_and_operation_identity(promotion_client, backend_env):
    old = create(promotion_client, image=False).json()
    backend_env.save_json_data("auth_devices", [{"id": 2, "device_id": "member", "member_id": 7,
                                               "member_name": "Member", "permission": "一般"}])
    denied = promotion_client.put(f"/api/extra/promotions/{old['id']}",
                                  headers={"X-Device-Id": "member", "Idempotency-Key": str(uuid4())},
                                  json={"title": "Forbidden", "expected_revision": 1})
    assert denied.status_code == 403


def test_validation_and_operation_status(promotion_client):
    assert promotion_client.post("/api/extra/promotions", headers=headers(), data={"payload": "{"}).status_code == 422
    invalid = promotion_client.post("/api/extra/promotions", headers=headers(), data={"title": "Bad"},
                                    files={"image_url_file": ("x.jpg", PNG, "image/jpeg")})
    assert invalid.status_code == 415
    key = str(uuid4())
    assert create(promotion_client, key, image=False).status_code == 200
    response = promotion_client.get(f"/api/promotions/operations/{key}", headers=headers())
    assert response.json()["state"] == "succeeded"
    conflict = promotion_client.post("/api/extra/promotions", headers=headers(key), json={"title": "Different"})
    assert conflict.status_code == 409


def test_late_upload_after_not_found_is_reconciled(promotion_client):
    created = create(promotion_client).json()
    promotion_client.request("DELETE", f"/api/extra/promotions/{created['id']}", headers=headers(), json={"expected_revision": 1})
    with repo.transaction() as cur:
        cur.execute("SELECT * FROM promotion_image_assets")
        stored = cur.fetchone()
    images.delete_object(stored["object_name"])
    images.cleanup(execute=True)
    images.upload(stored["object_name"], PNG, "image/png")
    with repo.transaction() as cur:
        cur.execute("UPDATE promotion_image_assets SET next_attempt_at=NULL")
    images.cleanup(execute=True)
    assert not images.local_path(stored["object_name"]).exists()
