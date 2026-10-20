"""File-operation protocol branches (JST spec R05-A/R05-B/R06-A; T19-T24).

Runs on the explicit local adapter (SQLite). The PostgreSQL transaction
semantics are covered by test_portal_file_operations_postgres.py.
"""
from __future__ import annotations

import io
from PIL import Image


import json
import uuid
from datetime import timedelta

import pytest

from src.backend.repositories import portal_file_repository as file_repo
from src.backend.services import extra_service
from src.backend.services import portal_file_asset_service as file_assets


def _portrait_bytes():
    output = io.BytesIO()
    Image.new("RGB", (32, 24), "blue").save(output, format="PNG")
    return output.getvalue()


def _pdf(label: str = "x") -> bytes:
    return f"%PDF-1.4\n%{label}\n%%EOF\n".encode("ascii")


def _payload(**overrides):
    payload = {"title": "Wish", "composer": "C", "duration": "", "genre": "クラシック", "formation": "", "reference_audio_url": "", "notes": "", "votes": []}
    payload.update(overrides)
    return payload


@pytest.fixture
def owner(seed_device_fn):
    seed_device_fn(device_id="dev-owner", permission="一般", member_id="member-owner", member_name="owner-a")
    return {"X-Device-Id": "dev-owner"}


def _post(client, headers, key, label="a", **payload):
    return client.post(
        "/api/extra/desired_pieces",
        headers={**headers, "Idempotency-Key": key},
        data={"payload": json.dumps(_payload(**payload))},
        files={"reference_score_file": ("s.pdf", _pdf(label), "application/pdf")},
    )


def _sql(query, params=()):
    with file_repo.local_transaction() as cur:
        cur.execute(query, params)
        try:
            return cur.fetchall()
        except Exception:
            return []


def test_same_key_different_content_is_rejected_without_touching_the_result(client, owner, backend_env):
    key = str(uuid.uuid4())
    first = _post(client, owner, key, "a")
    assert first.status_code == 200
    other = _post(client, owner, key, "b")
    assert other.status_code == 409
    assert other.json()["detail"]["code"] == "file_operation_conflict"
    assert len(backend_env.load_json_data("desired_pieces")) == 1
    assert _post(client, owner, key, "a").json() == first.json()


def test_success_replay_after_target_deleted_returns_the_original_result(client, owner, backend_env):
    key = str(uuid.uuid4())
    created = _post(client, owner, key).json()
    deleted = client.delete(f"/api/extra/desired_pieces/{created['id']}", headers={**owner, "Idempotency-Key": str(uuid.uuid4())})
    assert deleted.status_code == 200
    replay = _post(client, owner, key)
    assert replay.status_code == 200 and replay.json() == created  # not 404 (R05-B)
    assert backend_env.load_json_data("desired_pieces") == []  # not re-created


def test_rejected_result_is_replayed_even_if_the_target_changes(client, owner, backend_env):
    created = _post(client, owner, str(uuid.uuid4())).json()
    key = str(uuid.uuid4())
    stale = client.put(
        f"/api/extra/desired_pieces/{created['id']}",
        headers={**owner, "Idempotency-Key": key},
        data={"payload": json.dumps({**created, "notes": "n"}), "expected_updated_at": "2000-01-01T00:00:00+09:00"},
        files={"reference_score_file": ("s.pdf", _pdf("b"), "application/pdf")},
    )
    assert stale.status_code == 409
    again = client.put(
        f"/api/extra/desired_pieces/{created['id']}",
        headers={**owner, "Idempotency-Key": key},
        data={"payload": json.dumps({**created, "notes": "n"}), "expected_updated_at": "2000-01-01T00:00:00+09:00"},
        files={"reference_score_file": ("s.pdf", _pdf("b"), "application/pdf")},
    )
    assert again.status_code == 409 and again.json() == stale.json()
    # R05-B step 4: the version is checked before any staging, so the
    # rejected request never uploaded anything; only the original file exists.
    states = sorted(row[0] for row in _sql("SELECT state FROM portal_file_assets"))
    assert states == ["active"]


def test_expected_version_in_another_notation_is_the_same_request(client, owner):
    created = _post(client, owner, str(uuid.uuid4())).json()
    key = str(uuid.uuid4())
    from src.backend.utils.datetime_utils import parse_instant

    zulu = parse_instant(created["updated_at"]).astimezone(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z")
    body = {"payload": json.dumps({**created, "notes": "n"})}
    first = client.put(
        f"/api/extra/desired_pieces/{created['id']}", headers={**owner, "Idempotency-Key": key},
        data={**body, "expected_updated_at": created["updated_at"]},
        files={"reference_score_file": ("s.pdf", _pdf("c"), "application/pdf")},
    )
    second = client.put(
        f"/api/extra/desired_pieces/{created['id']}", headers={**owner, "Idempotency-Key": key},
        data={**body, "expected_updated_at": zulu},
        files={"reference_score_file": ("s.pdf", _pdf("c"), "application/pdf")},
    )
    assert first.status_code == 200 and second.json() == first.json()


def test_processing_operation_with_live_lease_is_not_run_twice(client, owner, backend_env, monkeypatch):
    key = str(uuid.uuid4())
    uploads = []
    real_upload = file_assets.upload

    def slow_upload(name, file):
        uploads.append(name)
        # A second request with the same key arrives while this one runs.
        nested = _post(client, owner, key)
        assert nested.status_code == 202
        return real_upload(name, file)

    monkeypatch.setattr(file_assets, "upload", slow_upload)
    response = _post(client, owner, key)
    assert response.status_code == 200
    assert len(uploads) == 1 and len(backend_env.load_json_data("desired_pieces")) == 1


def test_expired_lease_is_taken_over_and_the_old_attempt_cannot_commit(owner, backend_env):
    actor = "member:member-owner:local-development"
    key = str(uuid.uuid4())
    with file_repo.local_transaction() as cur:
        old, claimed, _ = file_repo.reserve(cur, actor_key=actor, operation_id=key, kind="desired_piece_reference_score", method="POST", target_id=None, view_scope="owner", digest="d")
        assert claimed
        file_repo.stage_asset(cur, old, kind="desired_piece_reference_score", owner_id=None, object_name="late/old.pdf", asset_id=str(uuid.uuid4()), source="local", filename="", content_type="application/pdf", byte_size=1, sha256="")
        cur.execute("UPDATE portal_file_operations SET lease_until=%s", ((file_repo.utc_now() - timedelta(seconds=1)).isoformat(),))
    with file_repo.local_transaction() as cur:
        new, claimed, _ = file_repo.reserve(cur, actor_key=actor, operation_id=key, kind="desired_piece_reference_score", method="POST", target_id=None, view_scope="owner", digest="d")
        assert claimed and new["attempt_id"] != old["attempt_id"]
    with file_repo.local_transaction() as cur:
        with pytest.raises(file_repo.LostAttempt):
            file_repo.require_attempt(cur, old)
        with pytest.raises(file_repo.LostAttempt):
            file_repo.finish(cur, old, 200, {"stale": True})
        old_asset = _sql_row(cur, "SELECT asset_id FROM portal_file_assets")
        with pytest.raises(file_repo.LostAttempt):
            file_repo.activate(cur, new, old_asset, owner_id=1, generation=None)  # old attempt's file
        file_repo.finish(cur, new, 200, {"ok": True})
    with file_repo.local_transaction() as cur:
        assert file_repo.operation(cur, actor, key)["result_body"] == {"ok": True}


def _sql_row(cur, query):
    cur.execute(query)
    return cur.fetchone()[0]


def test_status_query_unknown_processing_terminal_and_other_actor(client, owner, seed_device_fn):
    unknown = client.get(f"/api/portal-file-operations/{uuid.uuid4()}", headers=owner)
    assert unknown.status_code == 404 and unknown.json()["state"] == "unknown"
    key = str(uuid.uuid4())
    created = _post(client, owner, key)
    status = client.get(f"/api/portal-file-operations/{key}", headers=owner)
    assert status.status_code == 200
    assert status.json()["state"] == "succeeded" and status.json()["result_body"] == created.json()
    seed_device_fn(device_id="dev-other", permission="一般", member_id="member-other", member_name="other")
    other = client.get(f"/api/portal-file-operations/{key}", headers={"X-Device-Id": "dev-other"})
    assert other.status_code == 404  # another actor never sees this operation
    invalid = client.get("/api/portal-file-operations/not-a-uuid", headers=owner)
    assert invalid.status_code == 422


def test_status_query_db_failure_is_unknown_not_missing(client, owner, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr(file_assets.repo, "operation", broken)
    response = client.get(f"/api/portal-file-operations/{uuid.uuid4()}", headers=owner)
    assert response.status_code == 503


def test_admin_scoped_result_is_not_returned_after_permission_loss(client, seed_device_fn, backend_env):
    seed_device_fn(device_id="dev-admin", permission="管理者", member_id="member-admin", member_name="admin")
    key = str(uuid.uuid4())
    created = client.post(
        "/api/extra/org_settings",
        headers={"X-Device-Id": "dev-admin", "Idempotency-Key": key},
        data={"organization_name": "Orchestra", "short_name": "O"},
        files={"icon_url_file": ("icon.png", b"\x89PNG\r\n\x1a\nicon", "image/png")},
    )
    assert created.status_code == 200, created.text
    assert created.json()["icon_url"].startswith(f"/api/extra/org_settings/{created.json()['id']}/icon?asset=")
    devices = backend_env.load_json_data("auth_devices")
    for device in devices:
        if device.get("device_id") == "dev-admin":
            device["permission"] = "一般"  # the session lost the admin permission
    backend_env.save_json_data("auth_devices", devices)
    status = client.get(f"/api/portal-file-operations/{key}", headers={"X-Device-Id": "dev-admin"})
    assert status.status_code == 403


def test_expired_result_is_reported_not_rerun(client, owner, backend_env):
    key = str(uuid.uuid4())
    assert _post(client, owner, key).status_code == 200
    _sql("UPDATE portal_file_operations SET result_expires_at=%s", ((file_repo.utc_now() - timedelta(seconds=1)).isoformat(),))
    file_assets.cleanup(execute=True)
    replay = _post(client, owner, key)
    assert replay.status_code == 409 and replay.json()["detail"]["code"] == "file_operation_expired"
    assert len(backend_env.load_json_data("desired_pieces")) == 1


def test_cleanup_respects_grace_live_lease_and_rechecks_late_objects(client, owner, backend_env):
    created = _post(client, owner, str(uuid.uuid4()), "a").json()
    client.put(
        f"/api/extra/desired_pieces/{created['id']}",
        headers={**owner, "Idempotency-Key": str(uuid.uuid4())},
        data={"payload": json.dumps(created), "expected_updated_at": created["updated_at"]},
        files={"reference_score_file": ("s.pdf", _pdf("b"), "application/pdf")},
    )
    retired_name = _sql("SELECT object_name FROM portal_file_assets WHERE state='retired'")[0][0]
    path = backend_env.UPLOAD_DIR / retired_name
    file_assets.cleanup(execute=True)
    assert path.exists()  # within the 15 minute grace: in-flight downloads keep working
    past = (file_repo.utc_now() - timedelta(minutes=16)).isoformat()
    _sql("UPDATE portal_file_assets SET retired_at=%s, next_attempt_at=NULL WHERE state='retired'", (past,))
    file_assets.cleanup(execute=True)
    assert not path.exists()
    assert _sql("SELECT state FROM portal_file_assets WHERE object_name=%s", (retired_name,))[0][0] == "deleted"
    # A delayed upload recreates the object after deletion: the re-check reclaims it.
    path.write_bytes(b"late")
    _sql("UPDATE portal_file_assets SET next_attempt_at=%s WHERE object_name=%s", (past, retired_name))
    file_assets.cleanup(execute=True)
    assert not path.exists()
    # The active file is never touched.
    active_name = _sql("SELECT object_name FROM portal_file_assets WHERE state='active'")[0][0]
    assert (backend_env.UPLOAD_DIR / active_name).exists()


@pytest.mark.parametrize("pinned", [True, False])
def test_delivery_survives_cleanup_across_retirement_grace(client, owner, backend_env, monkeypatch, pinned):
    created = _post(client, owner, str(uuid.uuid4()), "a").json()
    old_id, old_name = _sql("SELECT asset_id,object_name FROM portal_file_assets WHERE state='active'")[0]
    old_path = backend_env.UPLOAD_DIR / old_name

    def replace():
        response = client.put(
            f"/api/extra/desired_pieces/{created['id']}",
            headers={**owner, "Idempotency-Key": str(uuid.uuid4())},
            data={"payload": json.dumps(created), "expected_updated_at": created["updated_at"]},
            files={"reference_score_file": ("s.pdf", _pdf("b"), "application/pdf")},
        )
        assert response.status_code == 200

    if pinned:
        replace()
        before = (file_repo.utc_now() - timedelta(minutes=14, seconds=59)).isoformat()
        _sql("UPDATE portal_file_assets SET retired_at=%s WHERE asset_id=%s", (before, old_id))
    read = file_assets._read_bytes

    def read_while_reclaiming(stored):
        if not pinned:
            # The logical-current request has already selected the old version.
            replace()
        after = (file_repo.utc_now() - timedelta(minutes=15, seconds=1)).isoformat()
        _sql("UPDATE portal_file_assets SET retired_at=%s,next_attempt_at=NULL WHERE asset_id=%s", (after, old_id))
        report = file_assets.cleanup(execute=True)
        assert any(row["asset_id"] == old_id and row["decision"] == "read-protected" for row in report["candidates"])
        assert old_path.exists()
        return read(stored)

    monkeypatch.setattr(file_assets, "_read_bytes", read_while_reclaiming)
    response = file_assets.deliver("desired_piece_reference_score", created["id"], old_id if pinned else None)
    assert response.body == _pdf("a")  # Never silently substitute the new version.
    expired = (file_repo.utc_now() - timedelta(seconds=1)).isoformat()
    _sql("UPDATE portal_file_assets SET read_protected_until=%s,next_attempt_at=NULL WHERE asset_id=%s", (expired, old_id))
    file_assets.cleanup(execute=True)
    assert not old_path.exists()
    active_name = _sql("SELECT object_name FROM portal_file_assets WHERE state='active'")[0][0]
    assert (backend_env.UPLOAD_DIR / active_name).exists()


def test_existing_local_database_adds_read_protection_and_closes(backend_env, tmp_path, monkeypatch):
    import sqlite3
    from contextlib import closing

    root = tmp_path / "legacy-file-db"
    root.mkdir()
    with closing(sqlite3.connect(root / "portal-files-local.sqlite3")) as conn:
        conn.executescript(file_repo._LOCAL_SCHEMA.replace("read_protected_until TEXT, ", ""))
    monkeypatch.setattr("src.backend.core.compat_gateway.get_runtime_data_paths", lambda: (root,))
    for _ in range(2):
        with file_repo.local_transaction() as cur:
            cur.execute("PRAGMA table_info(portal_file_assets)")
            assert "read_protected_until" in {row[1] for row in cur.fetchall()}
        with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
            cur.conn.execute("SELECT 1")


def test_failed_read_keeps_finite_protection_and_does_not_shorten_other_readers(client, owner, monkeypatch):
    from fastapi import HTTPException

    created = _post(client, owner, str(uuid.uuid4())).json()
    asset_id = _sql("SELECT asset_id FROM portal_file_assets")[0][0]
    longer = (file_repo.utc_now() + timedelta(minutes=20)).isoformat()
    _sql("UPDATE portal_file_assets SET read_protected_until=%s", (longer,))

    def unavailable(stored):
        raise FileNotFoundError()

    monkeypatch.setattr(file_assets, "_read_bytes", unavailable)
    with pytest.raises(HTTPException) as error:
        file_assets.deliver("desired_piece_reference_score", created["id"], asset_id)
    assert error.value.status_code == 404
    assert _sql("SELECT read_protected_until FROM portal_file_assets")[0][0] == longer


@pytest.mark.parametrize("pinned", [True, False])
def test_delivery_cannot_start_after_cleanup_claims_asset(client, owner, monkeypatch, pinned):
    from fastapi import HTTPException

    created = _post(client, owner, str(uuid.uuid4())).json()
    asset_id = _sql("SELECT asset_id FROM portal_file_assets")[0][0]
    _sql("UPDATE portal_file_assets SET state='delete_pending'")

    def must_not_read(stored):
        pytest.fail("A cleanup-claimed asset must not start a storage read")

    monkeypatch.setattr(file_assets, "_read_bytes", must_not_read)
    with pytest.raises(HTTPException) as error:
        file_assets.deliver("desired_piece_reference_score", created["id"], asset_id if pinned else None)
    assert error.value.status_code == 404
    assert _sql("SELECT read_protected_until FROM portal_file_assets")[0][0] is None


def test_delete_of_row_with_confirmed_file_requires_operation_key(client, owner, backend_env):
    created = _post(client, owner, str(uuid.uuid4())).json()
    response = client.delete(f"/api/extra/desired_pieces/{created['id']}", headers=owner)
    assert response.status_code == 428
    assert len(backend_env.load_json_data("desired_pieces")) == 1


def test_plain_updates_never_change_the_file_reference(client, owner):
    created = _post(client, owner, str(uuid.uuid4())).json()
    updated = client.put(
        f"/api/extra/desired_pieces/{created['id']}",
        headers=owner,
        json={"payload": {**created, "notes": "plain", "reference_score_url": "https://evil.example/x.pdf"}, "expected_updated_at": created["updated_at"]},
    )
    assert updated.status_code == 200
    assert updated.json()["reference_score_url"] == created["reference_score_url"]


def test_runner_lost_attempt_returns_current_state(monkeypatch, owner, client):
    def lose(*args, **kwargs):
        raise file_repo.LostAttempt()

    monkeypatch.setattr(extra_service, "create_row", lose)
    response = _post(client, owner, str(uuid.uuid4()))
    assert response.status_code == 202


@pytest.mark.parametrize("collection,path,payload,file_field", [
    ("members", "/api/members", {"name": "New", "part": "Violin", "permission": "一般"}, "photo_file"),
    ("performances", "/api/performances", {"title": "Concert", "date": "2026-10-19"}, "flyer_file"),
])
def test_common_image_update_replay_after_target_deleted(client, seed_device_fn, backend_env, collection, path, payload, file_field):
    seed_device_fn(device_id="dev-admin", permission="管理者", member_id="member-admin", member_name="admin")
    headers = {"X-Device-Id": "dev-admin"}
    created = client.post(path, headers=headers, json=payload)
    assert created.status_code == 200, created.text
    item_id = created.json()["id"]
    key = str(uuid.uuid4())
    request_headers = {**headers, "Idempotency-Key": key}

    def upload():
        return client.put(f"{path}/{item_id}", headers=request_headers, data=payload,
                          files={file_field: ("photo.png", _portrait_bytes() if collection == "members" else b"image-content", "image/png")})

    first = upload()
    assert first.status_code == 200, first.text
    backend_env.save_json_data(collection, [item for item in backend_env.load_json_data(collection) if str(item["id"]) != str(item_id)])
    replay = upload()
    assert replay.status_code == first.status_code
    assert replay.json() == first.json()


def test_image_removal_replay_does_not_depend_on_current_reference(client, seed_device_fn):
    seed_device_fn(device_id="dev-admin", permission="管理者", member_id="member-admin", member_name="admin")
    headers = {"X-Device-Id": "dev-admin"}
    payload = {"title": "Concert", "date": "2026-10-19"}
    created = client.post("/api/performances", headers={**headers, "Idempotency-Key": str(uuid.uuid4())}, data=payload,
                          files={"flyer_file": ("photo.png", b"image-content", "image/png")})
    assert created.status_code == 200, created.text
    url = f'/api/performances/{created.json()["id"]}'
    remove = {**payload, "flyer_image": ""}
    headers["Idempotency-Key"] = str(uuid.uuid4())
    first = client.put(url, headers=headers, json=remove)
    assert first.status_code == 200, first.text
    assert client.put(url, headers=headers, json=remove).json() == first.json()


def test_browser_actor_scope_is_opaque_tenant_scoped_and_generation_scoped(client, owner, monkeypatch):
    from src.backend.core.tenant_context import reset_current_tenant_id, set_current_tenant_id

    birth = {"value": "member:1:birth-a"}
    monkeypatch.setattr(file_assets, "actor_key", lambda device: birth["value"])
    first = client.get('/api/portal-file-actor', headers=owner)
    assert first.status_code == 200
    scope = first.json()["scope"]
    assert len(scope) == 64 and "member" not in scope
    assert first.headers["cache-control"] == 'no-store'
    assert client.get('/api/portal-file-actor', headers=owner).json()["scope"] == scope
    birth["value"] = "member:1:birth-b"
    assert client.get('/api/portal-file-actor', headers=owner).json()["scope"] != scope
    birth["value"] = "member:1:birth-a"
    token = set_current_tenant_id('other-tenant')
    try:
        # Service scope includes the current tenant independently of middleware.
        assert file_assets.public_actor_scope({}) != scope
    finally:
        reset_current_tenant_id(token)
