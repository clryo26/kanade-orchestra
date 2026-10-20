"""Opt-in PostgreSQL tests for file operations (JST spec R05-A/B, R06; T08/T11/T19/T20/T24).

Set PORTAL_TEST_DB_URL to an isolated, disposable PostgreSQL instance. The
tests recreate the portal tables and apply db/migrations/022.
"""
from __future__ import annotations

import asyncio
import os
import threading
import uuid
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")

from src.backend import app_core  # noqa: E402
from src.backend.core import db_runtime  # noqa: E402
from src.backend.core.tenant_context import reset_current_tenant_id, set_current_tenant_id  # noqa: E402
from src.backend.repositories.db_row_repository import _ORG_COLUMN_CACHE  # noqa: E402
from src.backend.services import extra_service  # noqa: E402
from src.backend.services import portal_file_asset_service as file_assets  # noqa: E402

DSN = os.environ.get("PORTAL_TEST_DB_URL", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Set PORTAL_TEST_DB_URL to an isolated PostgreSQL test instance")
MIGRATION = Path(__file__).resolve().parents[2] / "db" / "migrations" / "022_portal_file_assets.sql"
OWNER = {"member_id": 1, "member_name": "owner", "permission": "一般"}


class Upload:
    def __init__(self, content: bytes, filename: str = "s.pdf"):
        self.filename = filename
        self.content_type = "application/pdf"
        self._content = content

    async def read(self, size: int = -1) -> bytes:
        data, self._content = self._content, b""
        return data


def _pdf(label: str) -> bytes:
    return f"%PDF-1.4\n%{label}\n%%EOF\n".encode("ascii")


@pytest.fixture
def pg(monkeypatch, tmp_path):
    monkeypatch.setenv("DB_URL", DSN)
    monkeypatch.setenv("DATA_BACKEND", "db")
    monkeypatch.delenv("LOCAL_JSON_FALLBACK_ENABLED", raising=False)
    monkeypatch.setattr(app_core, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(app_core, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr("src.backend.drive_storage.storage_enabled", lambda: False)
    _ORG_COLUMN_CACHE.clear()
    with psycopg.connect(DSN, autocommit=True) as conn:
        for table in ("portal_file_assets", "portal_file_operations", "desired_pieces", "desired_piece_votes", "members"):
            conn.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
        db_runtime.ensure_db_schema_compatibility(conn)
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
        for tenant in ("tenant-a", "tenant-b"):
            conn.execute(
                "INSERT INTO members (id, organization_id, name, created_at, updated_at) VALUES (%s, %s, 'owner', clock_timestamp(), clock_timestamp())",
                (1 if tenant == "tenant-a" else 2, tenant),
            )
    app_core._memory_cache.clear_all_tenants()
    token = set_current_tenant_id("tenant-a")
    try:
        yield tmp_path
    finally:
        reset_current_tenant_id(token)


def _create(key: str, label: str = "a", device=OWNER):
    raw = {"payload": '{"title": "Wish", "votes": []}', "reference_score_file": Upload(_pdf(label))}
    return asyncio.run(extra_service.create_item("desired_pieces", raw, device, idempotency_key=key))


def _query(sql: str, params=()):
    with psycopg.connect(DSN) as conn:
        cursor = conn.execute(sql, params)
        return cursor.fetchall() if cursor.description else []


def test_member_photo_migration_and_public_projection_are_tenant_and_field_limited(pg):
    import base64
    import io
    from PIL import Image
    from scripts import normalize_member_photos as migration
    from src.backend.repositories.member_introduction_repository import list_introductions

    stream = io.BytesIO()
    Image.new("RGB", (1600, 1200), "blue").save(stream, "JPEG")
    inline = "data:image/jpeg;base64," + base64.b64encode(stream.getvalue()).decode()
    _query("UPDATE members SET photo_url=%s,comment='public',password='private' WHERE id=1", (inline,))
    before = _query("SELECT name,permission,password,created_at FROM members WHERE id=1")
    public = list_introductions()
    assert [r["id"] for r in public] == [1]
    assert public[0]["photo_url"] == "/api/members/1/photo"
    assert "password" not in public[0]
    plan = migration.build_plan()
    assert [r["id"] for r in plan["entries"]] == [1]
    _query("UPDATE members SET comment='concurrent text' WHERE id=1")
    report = asyncio.run(migration.apply_plan(plan, "pg-member-normalization"))
    assert report["results"][0]["state"] == "converted"
    assert _query("SELECT name,permission,password,created_at FROM members WHERE id=1") == before
    assert _query("SELECT comment FROM members WHERE id=1")[0][0] == "concurrent text"
    assert _query("SELECT photo_url FROM members WHERE id=2")[0][0] == ""
    [(url,)] = _query("SELECT photo_url FROM members WHERE id=1")
    assert url.endswith("ext=webp")
    assert migration.build_plan()["entries"][0]["state"] == "normalized"


def test_member_photo_migration_rolls_back_when_photo_changes_during_conversion(pg, monkeypatch):
    import base64
    import io
    from PIL import Image
    from scripts import normalize_member_photos as migration
    from src.backend.services import member_photo_service as portraits

    stream = io.BytesIO()
    Image.new("RGB", (100, 80), "blue").save(stream, "PNG")
    _query("UPDATE members SET photo_url=%s WHERE id=1", ("data:image/png;base64," + base64.b64encode(stream.getvalue()).decode(),))
    plan = migration.build_plan()
    normalize = portraits.normalize

    def racing(file):
        _query("UPDATE members SET photo_url='/new-user-photo',comment='keep' WHERE id=1")
        return normalize(file)

    monkeypatch.setattr(portraits, "normalize", racing)
    report = asyncio.run(migration.apply_plan(plan, "pg-member-race"))
    assert report["results"][0]["status"] == 409
    assert _query("SELECT photo_url,comment FROM members WHERE id=1") == [("/new-user-photo", "keep")]
    assert _query("SELECT COUNT(*) FROM portal_file_assets WHERE state='active'")[0][0] == 0


def test_business_row_asset_and_result_commit_together(pg):
    key = str(uuid.uuid4())
    response = _create(key)
    assert response.status_code == 200
    [(piece_id, url)] = _query("SELECT id, reference_score_url FROM desired_pieces WHERE organization_id='tenant-a'")
    [(state, owner_id, asset_id)] = _query("SELECT state, owner_id, asset_id::text FROM portal_file_assets")
    [(op_state, status)] = _query("SELECT state, result_status FROM portal_file_operations")
    assert (state, owner_id, op_state, status) == ("active", piece_id, "succeeded", 200)
    assert url.endswith(f"?asset={asset_id}")
    served = file_assets.deliver("desired_piece_reference_score", piece_id, None)
    assert served.body == _pdf("a")


def test_cleanup_rechecks_read_protection_for_an_already_selected_candidate(pg, monkeypatch):
    _create(str(uuid.uuid4()), "a")
    [(piece_id,)] = _query("SELECT id FROM desired_pieces")
    [(old_id, old_name)] = _query("SELECT asset_id::text,object_name FROM portal_file_assets")
    raw = {"payload": '{"title":"Wish","votes":[]}', "reference_score_file": Upload(_pdf("b"))}
    changed = asyncio.run(extra_service.update_item("desired_pieces", piece_id, raw, OWNER, idempotency_key=str(uuid.uuid4())))
    assert changed.status_code == 200
    _query("UPDATE portal_file_assets SET retired_at=clock_timestamp()-interval '14 minutes 59 seconds',next_attempt_at=NULL WHERE asset_id=%s", (old_id,))
    selected, proceed, finished = threading.Event(), threading.Event(), threading.Event()
    errors, reports = [], []
    candidates = file_assets.repo.reconcile_candidates

    def select_then_wait(cur, now, limit):
        rows = candidates(cur, now, limit)
        assert any(row["asset_id"] == old_id for row in rows)
        selected.set()
        assert proceed.wait(10)
        return rows

    monkeypatch.setattr(file_assets.repo, "reconcile_candidates", select_then_wait)

    def reclaim():
        token = set_current_tenant_id("tenant-a")
        try:
            reports.append(file_assets.cleanup(execute=True))
        except BaseException as exc:
            errors.append(exc)
        finally:
            reset_current_tenant_id(token)
            finished.set()

    worker = threading.Thread(target=reclaim)
    worker.start()
    read = file_assets._read_bytes

    def cross_grace_boundary(stored):
        _query("UPDATE portal_file_assets SET retired_at=clock_timestamp()-interval '15 minutes 1 second' WHERE asset_id=%s", (old_id,))
        proceed.set()
        assert finished.wait(10)
        assert not errors
        assert (pg / "uploads" / old_name).exists()
        return read(stored)

    monkeypatch.setattr(file_assets, "_read_bytes", cross_grace_boundary)
    try:
        assert selected.wait(10)
        assert file_assets.deliver("desired_piece_reference_score", piece_id, old_id).body == _pdf("a")
    finally:
        proceed.set()
        worker.join(15)
    assert not worker.is_alive() and not errors
    assert any(row["asset_id"] == old_id and row["decision"] == "read-protected" for row in reports[0]["candidates"])
    # Retention is bounded even if the reader crashes without releasing it.
    monkeypatch.setattr(file_assets.repo, "reconcile_candidates", candidates)
    _query("UPDATE portal_file_assets SET read_protected_until=clock_timestamp()-interval '1 second',next_attempt_at=NULL WHERE asset_id=%s", (old_id,))
    file_assets.cleanup(execute=True)
    assert not (pg / "uploads" / old_name).exists()


def test_same_key_from_two_requests_runs_once(pg):
    key = str(uuid.uuid4())
    results = []

    def worker():
        set_current_tenant_id("tenant-a")
        results.append(_create(key).status_code)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert sorted(results) in ([200, 200], [200, 202])
    assert _query("SELECT count(*) FROM desired_pieces")[0][0] == 1
    assert _query("SELECT count(*) FROM portal_file_assets WHERE state='active'")[0][0] == 1


def test_different_operations_on_one_version_only_one_succeeds(pg):
    _create(str(uuid.uuid4()))
    [(piece_id, version)] = _query("SELECT id, updated_at FROM desired_pieces")
    from src.backend.utils.datetime_utils import format_instant

    expected = format_instant(version)
    statuses = []

    def worker(label):
        set_current_tenant_id("tenant-a")
        raw = {
            "payload": '{"title": "Wish", "votes": [], "notes": "%s"}' % label,
            "expected_updated_at": expected,
            "reference_score_file": Upload(_pdf(label)),
        }
        response = asyncio.run(extra_service.update_item("desired_pieces", piece_id, raw, OWNER, idempotency_key=str(uuid.uuid4())))
        statuses.append(response.status_code)

    threads = [threading.Thread(target=worker, args=(label,)) for label in ("x", "y")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert sorted(statuses) == [200, 409]
    assert _query("SELECT count(*) FROM portal_file_assets WHERE state='active'")[0][0] == 1
    # The losing upload (if it got as far as staging) is never published.
    assert _query("SELECT count(*) FROM portal_file_assets WHERE state='staged'")[0][0] == 0


def test_lost_commit_acknowledgement_is_resolved_from_the_operation_record(pg, monkeypatch):
    real = file_assets.transaction
    calls = {"n": 0}

    from contextlib import contextmanager

    @contextmanager
    def flaky():
        calls["n"] += 1
        with real() as tx:
            yield tx
        if calls["n"] == 4:  # reserve, validate, stage, *commit*
            raise ConnectionError("acknowledgement lost after COMMIT")

    monkeypatch.setattr(file_assets, "transaction", flaky)
    key = str(uuid.uuid4())
    response = _create(key)
    assert response.status_code == 200  # read back from the durable result
    assert _query("SELECT state FROM portal_file_assets")[0][0] == "active"  # not deleted on guesswork


def test_rejected_target_change_rolls_back_partial_business_writes(pg):
    _create(str(uuid.uuid4()))
    [(piece_id,)] = _query("SELECT id FROM desired_pieces")
    other_member = {"member_id": 1, "member_name": "intruder", "permission": "一般"}
    _query("UPDATE desired_pieces SET member_id = 5, registered_by = 'someone' WHERE id = %s", (piece_id,))
    raw = {"payload": '{"title": "Hijack", "votes": []}', "reference_score_file": Upload(_pdf("z"))}
    response = asyncio.run(extra_service.update_item("desired_pieces", piece_id, raw, other_member, idempotency_key=str(uuid.uuid4())))
    assert response.status_code == 403
    assert _query("SELECT title FROM desired_pieces")[0][0] == "Wish"
    assert _query("SELECT state FROM portal_file_operations ORDER BY created_at DESC LIMIT 1")[0][0] == "rejected"


def test_operations_and_assets_are_tenant_scoped(pg):
    key = str(uuid.uuid4())
    _create(key)
    token = set_current_tenant_id("tenant-b")
    try:
        status, body = file_assets.operation_status({"member_id": 2, "permission": "一般"}, key)
        assert status == 404
        [(piece_id,)] = _query("SELECT id FROM desired_pieces WHERE organization_id='tenant-a'")
        with pytest.raises(Exception) as missing:
            file_assets.deliver("desired_piece_reference_score", piece_id, None)
        assert getattr(missing.value, "status_code", None) == 404
    finally:
        reset_current_tenant_id(token)


def test_inline_image_migration_is_audited_idempotent_and_guarded(pg):
    import base64

    data_url = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nlegacy").decode()
    with psycopg.connect(DSN, autocommit=True) as conn:
        for table in ("org_settings",):
            conn.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
        db_runtime.ensure_db_schema_compatibility(conn)
        conn.execute(
            "INSERT INTO org_settings (id, organization_id, organization_name, icon_url, membership_fee_amount, created_at, updated_at) "
            "VALUES (1, 'tenant-a', 'O', %s, 0, clock_timestamp(), clock_timestamp())",
            (data_url,),
        )
    status, body = asyncio.run(file_assets.migrate_inline_image("org_icon", 1, data_url, run_id="run-1"))
    assert status == 200 and body["to"].startswith("/api/extra/org_settings/1/icon?asset=")
    # Re-run of the same run joins the stored result (no second asset).
    again = asyncio.run(file_assets.migrate_inline_image("org_icon", 1, data_url, run_id="run-1"))
    assert again == (status, body)
    assert _query("SELECT count(*) FROM portal_file_assets")[0][0] == 1
    assert _query("SELECT actor_key FROM portal_file_operations")[0][0] == "migration:run-1"
    # Stale value guard: a new run with an outdated expectation changes nothing.
    stale = asyncio.run(file_assets.migrate_inline_image("org_icon", 1, data_url, run_id="run-2"))
    assert stale[0] == 409
    assert _query("SELECT icon_url FROM org_settings")[0][0] == body["to"]
    assert file_assets.deliver("org_icon", 1, None).body == b"\x89PNG\r\n\x1a\nlegacy"
