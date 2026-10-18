"""ZIP job steps: bounded time per step, resume inside a file, and the step
claim (review findings 2 and 3; docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md section 7).

Local mode (SQLite adapter, local files) with a controlled clock and small
read chunks; real GCS is not used here.
"""
from __future__ import annotations

import io
import re
import sqlite3
import zipfile
import zlib
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from src.backend.repositories import sheet_repository as repo
from src.backend.services import sheet_storage_service as storage
from src.backend.services import sheet_zip_service as zips

ADMIN = {"X-Device-Id": "dev-admin"}


class Clock:
    """Advances only when the code under test reads it; `per_call` seconds each."""

    def __init__(self, per_call: float = 0.0) -> None:
        self.now = 1000.0
        self.per_call = per_call

    def __call__(self) -> float:
        self.now += self.per_call
        return self.now


@pytest.fixture
def api(backend_env, monkeypatch):
    backend_env.save_json_data("performances", [{"id": 1, "title": "Concert", "pieces": ["Sym"]}])
    backend_env.save_json_data("auth_devices", [
        {"id": 1, "device_id": "dev-admin", "permission": "システム管理者", "hidden_user": True, "member_id": None},
    ])
    client = TestClient(backend_env.app)
    client.uploads = backend_env.UPLOAD_DIR
    return client


def upload(client, name: str, content: bytes):
    response = client.post("/api/sheets/upload", headers={**ADMIN, "Idempotency-Key": str(uuid4())},
                           data={"performance_id": "1", "performance_title": "Concert", "piece": "Sym"},
                           files={"file": (name, content, "application/pdf")})
    assert response.status_code == 200, response.text
    return response.json()["file"]


def pdf(tag: str, size: int) -> bytes:
    head = b"%PDF-1.4\n% " + tag.encode() + b"\n"
    return head + bytes((i * 7 + len(tag)) % 251 for i in range(size - len(head)))


def create(client):
    response = client.post("/api/sheets/zip-jobs", headers=ADMIN, json={"performance_id": "1", "piece": "Sym", "scope": "piece"})
    assert response.status_code == 200, response.text
    return response.json()


def step(client, job):
    response = client.post(f"/api/sheets/zip-jobs/{job['job_id']}/step", headers=ADMIN)
    assert response.status_code == 200, response.text
    return response.json()


def download(client, job) -> zipfile.ZipFile:
    response = client.get(f"/api/sheets/zip-jobs/{job['job_id']}/download", headers=ADMIN)
    assert response.status_code == 200, response.text
    return zipfile.ZipFile(io.BytesIO(response.content))


def lease_row(job_id: str):
    with repo.transaction() as cur:
        cur.execute("SELECT attempt_id, lease_until, state, done_count FROM sheet_zip_jobs WHERE job_id=%s", (job_id,))
        return cur.fetchone()


def test_an_intermediate_step_gives_its_claim_back_so_the_next_request_continues_at_once(api, monkeypatch):
    # Finding 3: the second request used to see "another step is running"
    # for the 90 s lease although the first step had finished.
    upload(api, "a.pdf", pdf("a", 300))
    upload(api, "b.pdf", pdf("b", 300))
    monkeypatch.setattr(zips, "clock", Clock(per_call=zips.STEP_BUDGET_SECONDS), raising=False)
    job = create(api)
    first = step(api, job)
    assert (first["state"], first["done_count"]) == ("building", 1)
    row = lease_row(job["job_id"])
    assert row["attempt_id"] is None and row["lease_until"] is None
    second = step(api, job)
    assert second["done_count"] == 2 and not second.get("busy")
    third = step(api, job)  # finishing is a step of its own
    assert third["state"] == "ready", third
    with download(api, third) as archive:
        assert sorted(archive.namelist()) == ["Sym/a.pdf", "Sym/b.pdf"]


def test_one_slow_file_is_split_across_steps_and_resumes_exactly(api, monkeypatch):
    # Finding 2: the time limit was only checked between files.
    content = pdf("slow", 5000)
    upload(api, "slow.pdf", content)
    monkeypatch.setattr(storage, "READ_CHUNK", 512)
    # Every chunk read takes the whole step budget.
    monkeypatch.setattr(zips, "clock", Clock(per_call=zips.STEP_BUDGET_SECONDS), raising=False)
    job = create(api)
    steps = []
    while job["state"] == "building":
        job = step(api, job)
        steps.append((job["done_count"], job["written_bytes"]))
        assert len(steps) < 40
    assert job["state"] == "ready", job
    assert len(steps) > 5  # the file was cut into several steps
    assert all(done == 0 for done, _ in steps[:-2])  # no entry before the file ended
    with download(api, job) as archive:
        assert archive.testzip() is None
        info = archive.getinfo("Sym/slow.pdf")
        assert info.CRC == zlib.crc32(content) & 0xFFFFFFFF
        assert archive.read("Sym/slow.pdf") == content


def test_the_step_time_check_runs_inside_a_file(api, monkeypatch):
    upload(api, "big.pdf", pdf("big", 4096))
    monkeypatch.setattr(storage, "READ_CHUNK", 256)
    monkeypatch.setattr(zips, "clock", Clock(per_call=zips.STEP_BUDGET_SECONDS / 3), raising=False)
    job = create(api)
    first = step(api, job)
    assert first["state"] == "building" and first["done_count"] == 0
    # Only a few chunks were copied in that step, not the whole file.
    assert 0 < first["written_bytes"] < 4096


def test_a_stale_attempt_cannot_commit_or_replace_the_published_zip(api, monkeypatch):
    upload(api, "a.pdf", pdf("a", 2000))
    monkeypatch.setattr(storage, "READ_CHUNK", 256)
    job = create(api)
    actor = "system:hidden-admin:v1"
    stale, _ = zips._claim(job["job_id"], actor)
    assert stale is not None
    # The stale attempt hangs; its claim expires and a new request takes over.
    with repo.transaction() as cur:
        cur.execute("UPDATE sheet_zip_jobs SET lease_until='2000-01-01T00:00:00+00:00' WHERE job_id=%s", (job["job_id"],))
    done = job
    while done["state"] == "building":
        done = step(api, done)
    assert done["state"] == "ready"
    published = (api.uploads / zips.ready_job(job["job_id"])["object_name"]).read_bytes()
    # The stale attempt now runs to its end: nothing it writes is accepted.
    result = zips._work(stale, actor)
    assert result["state"] == "ready"
    assert (api.uploads / zips.ready_job(job["job_id"])["object_name"]).read_bytes() == published
    with download(api, done) as archive:
        assert archive.read("Sym/a.pdf") == pdf("a", 2000)
    # Its own part was removed (unique names: no other attempt's part was touched).
    job_dir = api.uploads / storage.ZIP_PREFIX / storage.org_hash() / job["job_id"]
    stale_tag = str(stale["attempt_id"]).replace("-", "")[:12]
    assert not [p for p in job_dir.iterdir() if stale_tag in p.name]


def test_cancel_racing_a_running_step_wins_and_the_step_result_is_dropped(api, monkeypatch):
    upload(api, "a.pdf", pdf("a", 1000))
    job = create(api)
    original = storage.read_range

    def read_then_cancel(*args, **kwargs):
        data = original(*args, **kwargs)
        api.post(f"/api/sheets/zip-jobs/{job['job_id']}/cancel", headers=ADMIN)
        return data

    monkeypatch.setattr(storage, "read_range", read_then_cancel, raising=False)
    result = step(api, job)
    assert result["state"] == "cancelled"
    assert lease_row(job["job_id"])["done_count"] == 0


def test_reads_are_retried_within_their_deadline_and_then_fail(monkeypatch):
    calls = {"n": 0}

    class Flaky(Exception):
        pass

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError("transient")
        return b"ok"

    clock = Clock(per_call=0.0)
    monkeypatch.setattr(storage, "_sleep", lambda s: setattr(clock, "now", clock.now + s), raising=False)
    monkeypatch.setattr(storage, "_clock", clock, raising=False)
    assert storage.with_retry(flaky, deadline=10.0) == b"ok"
    assert calls["n"] == 3
    calls["n"] = -100  # always failing now
    with pytest.raises(ConnectionError):
        storage.with_retry(flaky, deadline=3.0)


def test_the_timing_values_are_consistent():
    # A step stops starting new I/O after STEP_BUDGET_SECONDS; one more read
    # and the part upload/compose can still run. The claim must outlast the
    # worst case, and the client must wait longer than the claim.
    assert zips.MAX_STEP_SECONDS < zips.STEP_LEASE.total_seconds()
    source = Path("src/static/js/modules/scores/save_dialog.js").read_text(encoding="utf-8")
    client_timeout_ms = int(re.search(r"ZIP_STEP_TIMEOUT_MS = (\d+)", source).group(1))
    assert client_timeout_ms / 1000 > zips.STEP_LEASE.total_seconds()


def test_existing_local_zip_database_gets_the_checkpoint_column():
    with sqlite3.connect(":memory:") as conn:
        conn.execute("CREATE TABLE sheet_zip_jobs (job_id TEXT PRIMARY KEY, state TEXT)")
        conn.execute("INSERT INTO sheet_zip_jobs VALUES ('kept', 'building')")
        repo._local_schema(conn)
        repo._local_schema(conn)  # repeat startup is safe
        assert conn.execute("SELECT job_id, state, progress FROM sheet_zip_jobs").fetchone() == ('kept', 'building', '{}')


def test_many_checkpoints_compose_the_chain_without_losing_bytes(api, monkeypatch):
    content = pdf("many", 3000)
    upload(api, "many.pdf", content)
    monkeypatch.setattr(storage, "READ_CHUNK", 64)
    monkeypatch.setattr(zips, "clock", Clock(per_call=zips.STEP_BUDGET_SECONDS))
    compose = storage.compose_into
    compositions = []

    def record(sources, target):
        compositions.append(len(sources))
        assert len(sources) <= storage.COMPOSE_LIMIT
        return compose(sources, target)

    monkeypatch.setattr(storage, "compose_into", record)
    job = create(api)
    for _ in range(60):
        job = step(api, job)
        if job["state"] != "building":
            break
    assert job["state"] == "ready"
    assert storage.COMPOSE_LIMIT in compositions
    with download(api, job) as archive:
        assert archive.testzip() is None
        assert archive.read("Sym/many.pdf") == content


def test_a_stale_finisher_cannot_replace_the_ready_zip(api):
    content = pdf("finish", 200)
    upload(api, "finish.pdf", content)
    job = step(api, create(api))
    assert job["done_count"] == 1 and job["state"] == "building"
    stale, _ = zips._claim(job["job_id"], "system:hidden-admin:v1")
    with repo.transaction() as cur:
        cur.execute("UPDATE sheet_zip_jobs SET lease_until='2000-01-01T00:00:00+00:00' WHERE job_id=%s", (job["job_id"],))
    done = step(api, job)
    published = zips.ready_job(job["job_id"])["object_name"]
    assert zips._work(stale, "system:hidden-admin:v1")["state"] == "ready"
    assert zips.ready_job(job["job_id"])["object_name"] == published
    with download(api, done) as archive:
        assert archive.read("Sym/finish.pdf") == content


def test_a_slow_part_upload_still_commits_and_the_next_step_continues(api, monkeypatch):
    upload(api, "a.pdf", pdf("a", 3000))
    monkeypatch.setattr(storage, "READ_CHUNK", 1000)
    clock = Clock(per_call=1.0)
    monkeypatch.setattr(zips, "clock", clock, raising=False)
    original = storage.write_part

    def slow_write(name, data):
        clock.now += 60  # far beyond the step budget, well within the claim
        return original(name, data)

    monkeypatch.setattr(storage, "write_part", slow_write)
    job = create(api)
    seen = []
    while job["state"] == "building":
        job = step(api, job)
        seen.append(job.get("busy", False))
    assert job["state"] == "ready"
    assert not any(seen)
    with download(api, job) as archive:
        assert archive.read("Sym/a.pdf") == pdf("a", 3000)


class _FakeBlob:
    def __init__(self, store, name, generation=None):
        self.store, self.name, self.pinned = store, name, generation
        self.size = self.generation = self.md5_hash = None

    def download_as_bytes(self, start, end, timeout, retry):
        assert retry is None and timeout == storage.IO_TIMEOUT_SECONDS
        self.store.calls.append(("read", self.name, self.pinned, start, end))
        if self.store.fail_reads:
            self.store.fail_reads -= 1
            from google.api_core.exceptions import ServiceUnavailable
            raise ServiceUnavailable("try again")
        return self.store.objects[self.name][start:end + 1]

    def upload_from_string(self, data, content_type, if_generation_match, timeout, retry):
        assert if_generation_match == 0 and retry is None
        import base64
        import hashlib
        if self.name in self.store.objects:
            from google.api_core.exceptions import PreconditionFailed
            raise PreconditionFailed("exists")
        self.store.objects[self.name] = data
        self.store.md5[self.name] = base64.b64encode(hashlib.md5(data).digest()).decode()
        if self.store.lose_answer:
            self.store.lose_answer = False
            raise ConnectionError("answer lost after the write")
        self.generation = 7

    def reload(self, timeout, retry):
        self.size = len(self.store.objects[self.name])
        self.md5_hash = self.store.md5[self.name]
        self.generation = 7


class _FakeBucket:
    def __init__(self):
        self.objects, self.md5, self.calls = {}, {}, []
        self.fail_reads = 0
        self.lose_answer = False

    def blob(self, name, generation=None):
        return _FakeBlob(self, name, generation)


def test_gcs_reads_are_pinned_to_the_generation_and_retried(monkeypatch):
    bucket = _FakeBucket()
    bucket.objects["sheets/v2/x.pdf"] = b"0123456789"
    bucket.fail_reads = 2
    monkeypatch.setattr(storage, "_storage_on", lambda: True)
    monkeypatch.setattr(storage, "get_storage_bucket", lambda: bucket)
    monkeypatch.setattr(storage, "_sleep", lambda s: None)
    assert storage.read_range("google_cloud_storage", "sheets/v2/x.pdf", 42, 3, 4) == b"3456"
    assert [c[2] for c in bucket.calls] == [42, 42, 42]  # pinned generation every time
    assert bucket.calls[-1][3:] == (3, 6)


def test_gcs_part_write_after_a_lost_answer_is_not_a_second_object(monkeypatch):
    bucket = _FakeBucket()
    bucket.lose_answer = True
    monkeypatch.setattr(storage, "_storage_on", lambda: True)
    monkeypatch.setattr(storage, "get_storage_bucket", lambda: bucket)
    monkeypatch.setattr(storage, "_sleep", lambda s: None)
    monkeypatch.setattr(storage, "source_kind", lambda: "google_cloud_storage")
    assert storage.write_part("sheet-zips/v1/o/j/p00000-abc", b"data") == 7
    assert list(bucket.objects) == ["sheet-zips/v1/o/j/p00000-abc"]
    # A different content under the same (unique) name is never accepted.
    with pytest.raises(Exception):
        storage.write_part("sheet-zips/v1/o/j/p00000-abc", b"other")
