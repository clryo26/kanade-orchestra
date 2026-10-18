"""Sheet library reliability (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md).

Local-mode tests through the HTTP routes: the explicit SQLite adapter and the
local file store. PostgreSQL concurrency is in test_sheet_library_postgres.py;
real GCS, real iPhone saving and real PDF rendering are NOT covered here.
"""
from __future__ import annotations

import io
import zipfile
from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from src.backend.repositories import sheet_repository as repo
from src.backend.services import sheet_cleanup_service as cleanup
from src.backend.services import sheet_library_service as library
from src.backend.services import sheet_zip_service as zips

ADMIN = {"X-Device-Id": "dev-admin"}
MEMBER = {"X-Device-Id": "dev-member"}


def pdf(tag: str) -> bytes:
    return b"%PDF-1.4\n% " + tag.encode() + b"\n" + b"x" * 64


@pytest.fixture
def api(backend_env, monkeypatch):
    backend_env.save_json_data("performances", [{"id": 1, "title": "Concert", "pieces": ["Sym", "Ov"]}])
    backend_env.save_json_data("members", [{"id": 7, "name": "Member", "permission": "一般", "created_at": "2026-01-01T00:00:00+00:00"}])
    backend_env.save_json_data("auth_devices", [
        {"id": 1, "device_id": "dev-admin", "permission": "システム管理者", "hidden_user": True, "member_id": None},
        {"id": 2, "device_id": "dev-member", "permission": "一般", "member_id": 7, "member_name": "Member"},
    ])
    emitted = []
    from src.backend.services import notification_service
    monkeypatch.setattr(notification_service, "emit", lambda *args, **kwargs: emitted.append(args))
    client = TestClient(backend_env.app)
    client.emitted = emitted
    client.uploads = backend_env.UPLOAD_DIR
    return client


def upload(client, name="a.pdf", content=None, key=None, piece="Sym"):
    headers = dict(ADMIN)
    if key is not False:
        headers["Idempotency-Key"] = key or str(uuid4())
    return client.post("/api/sheets/upload", headers=headers,
                       data={"performance_id": "1", "performance_title": "Concert", "piece": piece},
                       files={"file": (name, content if content is not None else pdf(name), "application/pdf")})


def listing(client):
    response = client.get("/api/sheets", headers=MEMBER)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def test_list_is_read_from_the_store_not_from_a_process_cache(api, backend_env):
    # "Another server" = another process cache that still holds an old list.
    first = upload(api, "a.pdf").json()["file"]
    backend_env._memory_cache.set("sheet_library", [])
    data = listing(api)
    assert [f["id"] for f in data["files"]] == [first["id"]]
    assert data["list_version"] >= 1
    # The bootstrap payload carries the same list with its version.
    boot = api.get("/api/bootstrap", headers=MEMBER).json()
    assert [f["id"] for f in boot["sheets"]["files"]] == [first["id"]]
    assert boot["sheets"]["list_version"] == data["list_version"]


def test_cleanup_dry_run_keeps_database_and_files_unchanged(api):
    a = upload(api, "dry-run.pdf").json()["file"]
    api.request("DELETE", "/api/sheets", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
                json={"items": [{"id": a["id"], "expected_revision": a["revision"]}]})
    tables = ("sheet_files", "sheet_file_leases", "sheet_operations", "sheet_zip_jobs", "sheet_download_tickets")

    def snapshot():
        with repo.transaction() as cur:
            result = {}
            for table in tables:
                cur.execute(f"SELECT * FROM {table}")
                result[table] = [dict(row) for row in cur.fetchall()]
            return result

    before = snapshot()
    assert cleanup.run(execute=False)["files"][0]["kept"] == "grace"
    assert cleanup.run(execute=False)["files"][0]["kept"] == "grace"
    assert snapshot() == before
    assert (api.uploads / a["path"]).exists()


def test_cleanup_records_only_counts_and_deletes_the_selected_organization(api):
    a = upload(api).json()["file"]
    with repo.transaction() as cur:
        cur.execute("SELECT file_id FROM sheet_files WHERE sheet_id=%s", (a["id"],))
        file_id = cur.fetchone()["file_id"]
        for org in ("default", "other-organization"):
            old = "2000-01-01T00:00:00+00:00"
            cur.execute("INSERT INTO sheet_download_tickets (ticket_hash,organization_id,device_id,target_kind,target_id,created_at,expires_at) "
                        "VALUES (%s,%s,'dev-admin','file','1',%s,%s)", (org, org, old, old))
            cur.execute("INSERT INTO sheet_file_leases (lease_id,organization_id,file_id,holder,expires_at,created_at) "
                        "VALUES (%s,%s,%s,%s,%s,%s)", (str(uuid4()), org, file_id, org, old, old))
            cur.execute("INSERT INTO sheet_operations (organization_id,actor_key,operation_id,kind,request_hash,state,attempt_id,lease_until,"
                        "result_status,result_body,created_at,updated_at) VALUES (%s,'actor',%s,'delete',%s,'succeeded',%s,%s,200,'{}',%s,%s)",
                        (org, str(uuid4()), "a" * 64, str(uuid4()), old, old, old))
    assert cleanup.cleanup_records(execute=False) == {"tickets": 1, "leases": 1, "operations": 1}
    assert cleanup.cleanup_records(execute=True) == {"tickets": 1, "leases": 1, "operations": 1}
    with repo.transaction() as cur:
        for table in ("sheet_download_tickets", "sheet_file_leases", "sheet_operations"):
            cur.execute(f"SELECT COUNT(*) AS n FROM {table} WHERE organization_id=%s", ("other-organization",))
            assert cur.fetchone()["n"] == 1


def test_old_whole_list_save_can_no_longer_remove_newer_sheets(api, backend_env, monkeypatch):
    upload(api, "a.pdf")
    stale = listing(api)["files"]
    upload(api, "b.pdf")
    # In DB mode a whole-list save is refused (this was the path that deleted
    # rows missing from an old copy).
    from src.backend.services import json_collection_service as module
    with pytest.raises(Exception) as caught:
        module.save_json_data("sheet_library", stale, cache=backend_env._memory_cache, local_json_fallback_enabled=lambda: False,
                              ensure_db_expected_is_ready=lambda: None, db_replace_collection=lambda *a: None,
                              db_save_generic_json_collection=lambda *a: None, db_writable_collections=("sheet_library",),
                              json_data_names=(), extra_collections=(), data_dir=backend_env.DATA_DIR)
    assert getattr(caught.value, "status_code", None) == 409
    assert len(listing(api)["files"]) == 2
    # The generic collection API refuses sheet writes too.
    assert api.post("/api/extra/sheet_library", headers=ADMIN, json={"name": "x.pdf"}).status_code == 409


def test_upload_resend_returns_the_same_result_and_conflicting_reuse_is_refused(api):
    key = str(uuid4())
    first = upload(api, "a.pdf", key=key)
    again = upload(api, "a.pdf", key=key)
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json()
    assert len(listing(api)["files"]) == 1
    other = upload(api, "a.pdf", content=pdf("different"), key=key)
    assert other.status_code == 409
    assert other.json()["detail"]["code"] == "sheet_operation_conflict"
    assert len(listing(api)["files"]) == 1


def test_lost_acknowledgement_after_commit_is_answered_from_the_stored_result(api, monkeypatch):
    real_finish = repo.finish
    calls = {"n": 0}

    def finish_then_fail(cur, op, status, body):
        real_finish(cur, op, status, body)
        calls["n"] += 1
        if calls["n"] == 1:
            # The commit succeeds but this process "loses" the reply.
            cur.conn.commit()
            raise ConnectionError("acknowledgement lost")

    monkeypatch.setattr(repo, "finish", finish_then_fail)
    key = str(uuid4())
    first = upload(api, "a.pdf", key=key)
    assert first.status_code == 200, first.text  # read back from the durable operation
    monkeypatch.setattr(repo, "finish", real_finish)
    again = upload(api, "a.pdf", key=key)
    assert again.json() == first.json()
    assert len(listing(api)["files"]) == 1


def test_files_of_a_batch_are_independent_and_a_failed_one_can_be_retried(api):
    keys = [str(uuid4()) for _ in range(3)]
    assert upload(api, "1.pdf", key=keys[0]).status_code == 200
    broken = upload(api, "2.pdf", content=b"not a pdf", key=keys[1])
    assert broken.status_code == 415
    assert upload(api, "3.pdf", key=keys[2]).status_code == 200
    # Resume: the finished ones answer with their results, nothing doubles.
    assert upload(api, "1.pdf", key=keys[0]).status_code == 200
    assert upload(api, "2.pdf", key=str(uuid4())).status_code == 200
    names = sorted(f["name"] for f in listing(api)["files"])
    assert names == ["1.pdf", "2.pdf", "3.pdf"]


def test_old_screen_upload_without_key_still_inserts_one_row(api):
    response = upload(api, "legacy.pdf", key=False)
    assert response.status_code == 200
    assert response.json()["name"] == "legacy.pdf"  # the bare record old screens read
    assert len(listing(api)["files"]) == 1


def test_part_changes_check_the_revision_and_tell_resend_from_conflict(api):
    sheet = upload(api, "a.pdf").json()["file"]
    key = str(uuid4())
    body = {"part": "Vn", "expected_revision": sheet["revision"]}
    first = api.put(f"/api/sheets/{sheet['id']}/part", headers={**ADMIN, "Idempotency-Key": key}, json=body)
    assert first.status_code == 200
    resent = api.put(f"/api/sheets/{sheet['id']}/part", headers={**ADMIN, "Idempotency-Key": key}, json=body)
    assert resent.json() == first.json()  # same operation: same result
    stale = api.put(f"/api/sheets/{sheet['id']}/part", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
                    json={"part": "Va", "expected_revision": sheet["revision"]})
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "sheet_revision_conflict"
    assert listing(api)["files"][0]["part"] == "Vn"
    legacy = api.put(f"/api/sheets/{sheet['id']}/part", headers=ADMIN, json={"part": "Vc"})
    assert legacy.status_code == 428


def test_bulk_part_is_all_or_nothing(api):
    a = upload(api, "a.pdf").json()["file"]
    b = upload(api, "b.pdf").json()["file"]
    api.put(f"/api/sheets/{b['id']}/part", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
            json={"part": "Vc", "expected_revision": b["revision"]})
    bulk = api.put("/api/sheets/parts", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
                   json={"part": "Vn", "items": [{"id": a["id"], "expected_revision": a["revision"]},
                                                 {"id": b["id"], "expected_revision": b["revision"]}]})
    assert bulk.status_code == 409
    assert bulk.json()["detail"]["changed_ids"] == [b["id"]]
    parts = {f["id"]: f["part"] for f in listing(api)["files"]}
    assert parts == {a["id"]: "", b["id"]: "Vc"}


def test_delete_takes_listed_ids_only_and_never_a_scope(api):
    seen = upload(api, "a.pdf").json()["file"]
    later = upload(api, "b.pdf").json()["file"]  # registered on another device after the list was read
    old_scope = api.request("DELETE", "/api/sheets", headers=ADMIN, json={"performance_id": "1", "piece": "Sym"})
    assert old_scope.status_code == 428
    removed = api.request("DELETE", "/api/sheets", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
                          json={"items": [{"id": seen["id"], "expected_revision": seen["revision"]}]})
    assert removed.status_code == 200
    assert [f["id"] for f in listing(api)["files"]] == [later["id"]]


def test_list_version_rises_with_every_change_and_is_cheap_to_poll(api):
    v0 = api.get("/api/sheets/version", headers=MEMBER).json()["list_version"]
    sheet = upload(api, "a.pdf").json()
    assert sheet["list_version"] > v0
    v1 = api.get("/api/sheets/version", headers=MEMBER).json()["list_version"]
    assert v1 == sheet["list_version"]
    assert api.get("/api/sheets/version").status_code == 401


def test_no_member_notification_for_sheet_operations(api):
    sheet = upload(api, "a.pdf").json()["file"]
    api.put(f"/api/sheets/{sheet['id']}/part", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
            json={"part": "Vn", "expected_revision": 1})
    api.request("DELETE", "/api/sheets", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
                json={"items": [{"id": sheet["id"], "expected_revision": 2}]})
    assert api.emitted == []


def test_files_need_a_device_and_must_be_a_published_sheet(api):
    sheet = upload(api, "a.pdf").json()["file"]
    without = api.get(sheet["view_url"])
    assert without.status_code == 401
    assert "ポータルに戻る" in without.text
    viewed = api.get(sheet["view_url"], headers=MEMBER)
    assert viewed.status_code == 200
    assert viewed.content.startswith(b"%PDF-1.4")
    assert viewed.headers["cache-control"] == "private, no-store"
    # A stored object that is not a published sheet is never served.
    stray = api.uploads / "sheets" / "stray.pdf"
    stray.write_bytes(pdf("stray"))
    assert api.get("/api/sheets/view/sheets/stray.pdf", headers=MEMBER).status_code == 404


def test_ticket_download_rechecks_the_device_and_expires(api, backend_env):
    sheet = upload(api, "a.pdf").json()["file"]
    ticket = api.post("/api/sheets/tickets", headers=MEMBER, json={"kind": "file", "id": sheet["id"]}).json()
    got = api.get(ticket["url"])  # navigation: no device header
    assert got.status_code == 200
    assert got.headers["content-disposition"].startswith("attachment;")
    # A logged-out device cannot use an issued ticket.
    backend_env.save_json_data("auth_devices", [{"id": 1, "device_id": "dev-admin", "permission": "システム管理者",
                                                 "hidden_user": True, "member_id": None}])
    assert api.get(ticket["url"]).status_code == 401
    assert api.get("/api/sheets/tickets/not-a-ticket").status_code == 410


def _drive(client, job):
    for _ in range(50):
        if job["state"] != "building":
            return job
        job = client.post(f"/api/sheets/zip-jobs/{job['job_id']}/step", headers=MEMBER).json()
    raise AssertionError("ZIP did not finish")


def test_zip_job_contains_every_fixed_file_and_is_verified(api):
    a = upload(api, "a.pdf", content=pdf("A")).json()["file"]
    upload(api, "b.pdf", content=pdf("B"), piece="Ov")
    job = api.post("/api/sheets/zip-jobs", headers=MEMBER, json={"performance_id": "1"}).json()
    assert job["file_count"] == 2
    # Deleted while building: the fixed content is kept (lease + grace).
    api.request("DELETE", "/api/sheets", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
                json={"items": [{"id": a["id"], "expected_revision": a["revision"]}]})
    done = _drive(api, job)
    assert done["state"] == "ready", done
    assert done["changed_since"] is True
    data = api.get(f"/api/sheets/zip-jobs/{job['job_id']}/download", headers=MEMBER)
    assert data.status_code == 200
    with zipfile.ZipFile(io.BytesIO(data.content)) as archive:
        assert archive.testzip() is None
        assert sorted(archive.namelist()) == ["Ov/b.pdf", "Sym/a.pdf"]
        assert archive.read("Sym/a.pdf") == pdf("A")
    # Another member cannot fetch it.
    assert api.get(f"/api/sheets/zip-jobs/{job['job_id']}/download", headers=ADMIN).status_code == 404


def test_zip_job_with_a_missing_file_is_incomplete_unless_partial_is_chosen(api):
    a = upload(api, "a.pdf").json()["file"]
    upload(api, "b.pdf")
    (api.uploads / a["path"]).unlink()
    job = _drive(api, api.post("/api/sheets/zip-jobs", headers=MEMBER, json={"performance_id": "1"}).json())
    assert job["state"] == "incomplete"
    assert [m["sheet_id"] for m in job["missing"]] == [a["id"]]
    assert api.get(f"/api/sheets/zip-jobs/{job['job_id']}/download", headers=MEMBER).status_code == 410
    partial = api.post("/api/sheets/zip-jobs", headers=MEMBER, json={
        "performance_id": "1", "allow_partial": True, "exclude_sheet_ids": [a["id"]], "missing": job["missing"]}).json()
    partial = _drive(api, partial)
    assert partial["state"] == "ready"
    data = api.get(f"/api/sheets/zip-jobs/{partial['job_id']}/download", headers=MEMBER)
    assert "_%E4%B8%80%E9%83%A8.zip" in data.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(data.content)) as archive:
        assert "Sym/b.pdf" in archive.namelist()
        assert zips.MISSING_LIST_NAME in archive.namelist()


def test_zip_limits_and_cancel(api, monkeypatch):
    upload(api, "a.pdf")
    upload(api, "b.pdf")
    monkeypatch.setattr(zips, "MAX_ZIP_FILES", 1)
    too_many = api.post("/api/sheets/zip-jobs", headers=MEMBER, json={"performance_id": "1"})
    assert too_many.status_code == 413
    monkeypatch.setattr(zips, "MAX_ZIP_FILES", 1000)
    job = api.post("/api/sheets/zip-jobs", headers=MEMBER, json={"performance_id": "1"}).json()
    cancelled = api.post(f"/api/sheets/zip-jobs/{job['job_id']}/cancel", headers=MEMBER).json()
    assert cancelled["state"] == "cancelled"
    assert api.post(f"/api/sheets/zip-jobs/{job['job_id']}/step", headers=MEMBER).json()["state"] == "cancelled"


def test_cleanup_respects_grace_leases_and_shared_legacy_objects(api, monkeypatch):
    a = upload(api, "a.pdf").json()["file"]
    path = api.uploads / a["path"]
    job = api.post("/api/sheets/zip-jobs", headers=MEMBER, json={"performance_id": "1"}).json()
    api.request("DELETE", "/api/sheets", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
                json={"items": [{"id": a["id"], "expected_revision": a["revision"]}]})
    monkeypatch.setattr(cleanup, "RETIRED_GRACE", timedelta(0))
    kept = cleanup.cleanup_files(execute=True)
    assert [k.get("kept") for k in kept] == ["leased"]
    assert path.exists()
    api.post(f"/api/sheets/zip-jobs/{job['job_id']}/cancel", headers=MEMBER)  # releases the leases
    with repo.transaction() as cur:
        cur.execute("UPDATE sheet_files SET next_attempt_at=NULL")
    deleted = cleanup.cleanup_files(execute=True)
    assert [d.get("delete") for d in deleted] == [a["path"]]
    assert not path.exists()
    assert cleanup.cleanup_files(execute=True) == []  # a rerun touches nothing more


def test_cleanup_keeps_an_object_still_referenced_by_another_row(api, backend_env, monkeypatch):
    shared = "sheets/legacy/shared.pdf"
    (api.uploads / "sheets" / "legacy").mkdir(parents=True)
    (api.uploads / shared).write_bytes(pdf("shared"))
    backend_env.save_json_data("sheet_library", [
        {"id": 10, "performance_id": 1, "piece": "Sym", "name": "shared.pdf", "source": "local", "path": shared},
        {"id": 11, "performance_id": 1, "piece": "Sym", "name": "shared.pdf", "source": "local", "path": shared},
    ])
    first = next(f for f in listing(api)["files"] if f["id"] == 10)
    api.request("DELETE", "/api/sheets", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
                json={"items": [{"id": 10, "expected_revision": first["revision"]}]})
    monkeypatch.setattr(cleanup, "RETIRED_GRACE", timedelta(0))
    report = cleanup.cleanup_files(execute=True)
    assert [r.get("kept") for r in report] == ["referenced"]
    assert (api.uploads / shared).exists()
    viewed = api.get(next(f for f in listing(api)["files"] if f["id"] == 11)["view_url"], headers=MEMBER)
    assert viewed.status_code == 200


def test_an_unpublished_upload_is_cleaned_only_after_its_operation_expired(api, monkeypatch):
    def broken_bump(cur):
        raise RuntimeError("process ended before publishing")

    original = repo.bump_version
    monkeypatch.setattr(repo, "bump_version", broken_bump)
    failed = upload(api, "a.pdf")
    assert failed.status_code == 503
    assert failed.json()["detail"]["code"] == "sheet_retry_same_operation"
    monkeypatch.setattr(repo, "bump_version", original)
    with repo.transaction() as cur:
        cur.execute("SELECT object_name, state FROM sheet_files")
        staged = cur.fetchone()
    assert staged["state"] == "staged"
    assert (api.uploads / staged["object_name"]).exists()
    assert listing(api)["files"] == []
    monkeypatch.setattr(cleanup, "STAGED_GRACE", timedelta(0))
    with repo.transaction() as cur:
        cur.execute("UPDATE sheet_operations SET lease_until='2000-01-01T00:00:00+00:00'")
    cleanup.cleanup_files(execute=True)
    assert not (api.uploads / staged["object_name"]).exists()


def test_operation_status_reports_unknown_processing_and_done(api):
    key = str(uuid4())
    assert api.get(f"/api/sheets/operations/{key}", headers=ADMIN).status_code == 404
    upload(api, "a.pdf", key=key)
    status = api.get(f"/api/sheets/operations/{key}", headers=ADMIN).json()
    assert status["state"] == "succeeded"
    assert status["result_body"]["file"]["name"] == "a.pdf"


def test_service_public_record_keeps_the_existing_urls():
    item = {"id": 3, "source": "google_cloud_storage", "object_name": "sheets/1_C/Sym/a.pdf", "name": "a.pdf", "revision": 2}
    out = library.public(item)
    assert out["view_url"] == "/api/sheets/cloud/view/sheets/1_C/Sym/a.pdf"
    assert out["download_url"] == "/api/sheets/cloud/download/sheets/1_C/Sym/a.pdf"
    assert out["revision"] == 2
