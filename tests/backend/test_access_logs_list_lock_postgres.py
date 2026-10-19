"""Opt-in PostgreSQL: JST search boundaries (T06) and the shared collection lock (C04, T09)."""
from __future__ import annotations

import os
import threading
import time
from urllib.parse import quote

import pytest

psycopg = pytest.importorskip("psycopg")

from src.backend.core import db_runtime  # noqa: E402
from src.backend.core.tenant_context import reset_current_tenant_id, set_current_tenant_id  # noqa: E402
from src.backend.repositories import access_log_repository  # noqa: E402
from src.backend.repositories import db_item_repository as items  # noqa: E402
from src.backend.repositories import db_json_repository  # noqa: E402
from src.backend.repositories.db_row_repository import _ORG_COLUMN_CACHE  # noqa: E402
from src.backend.routers.access_logs import _search_range  # noqa: E402

DSN = os.environ.get("PORTAL_TEST_DB_URL", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Set PORTAL_TEST_DB_URL to an isolated PostgreSQL test instance")


@pytest.fixture
def db(monkeypatch):
    monkeypatch.setenv("DB_URL", DSN)
    _ORG_COLUMN_CACHE.clear()
    with psycopg.connect(DSN, autocommit=True) as conn:
        for table in ("access_logs", "connection_settings"):
            conn.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
        db_runtime.ensure_db_schema_compatibility(conn)
    token = set_current_tenant_id("tenant-a")
    try:
        yield
    finally:
        reset_current_tenant_id(token)


def _log_at(instant: str) -> None:
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO access_logs (organization_id, menu_key, menu_label, accessed_at) VALUES ('tenant-a', %s, 'm', %s)",
            (instant, instant),
        )


@pytest.mark.parametrize("session_tz", ["UTC", "Asia/Tokyo", "America/New_York"])
def test_end_day_is_included_and_next_day_excluded(db, monkeypatch, session_tz):
    separator = "&" if "?" in DSN else "?"
    monkeypatch.setenv("DB_URL", f"{DSN}{separator}options={quote('-c TimeZone=' + session_tz)}")
    for instant in (
        "2026-10-18T23:59:59.999999+09:00",  # day before: excluded
        "2026-10-19T00:00:00+09:00",
        "2026-10-19T23:59:59+09:00",
        "2026-10-19T23:59:59.5+09:00",
        "2026-10-19T23:59:59.999999+09:00",
        "2026-10-20T00:00:00+09:00",  # next day: excluded
    ):
        _log_at(instant)
    start, end = _search_range(None, None, "2026-10-19", "2026-10-19")
    result = access_log_repository.query_access_logs(date_from=start, date_to=end)
    assert result["total"] == 4
    assert all(item["accessed_at"].startswith("2026-10-19T") for item in result["items"])


def test_insert_uses_db_clock_and_returns_jst(db):
    stored = access_log_repository.insert_access_log(
        {"member_id": None, "menu_key": "k", "menu_label": "l", "accessed_at": "1999-01-01T00:00:00Z"}
    )
    assert stored["accessed_at"].endswith("+09:00") and not stored["accessed_at"].startswith("1999")


def _seed_row(bucket):
    # Same shape as startup.seed_connection_settings_from_legacy_env writes.
    now = "2026-10-19T12:00:00.000000+09:00"
    return {"id": 1, "google_project_id": "p", "google_cloud_storage_bucket": bucket, "google_cloud_storage_data_prefix": "app-data",
            "google_cloud_storage_public": "false", "google_service_account_file": "", "google_service_account_json": "",
            "created_at": now, "updated_at": now}


def test_startup_seed_and_row_update_share_the_collection_lock(db):
    store = items.PostgresRowStore()
    seeded_first = db_json_repository.mutate_collection_locked(
        "connection_settings", lambda rows: rows or [_seed_row("seed")]
    )
    assert seeded_first[0]["google_cloud_storage_bucket"] == "seed"
    results = {}

    def seed_again():
        set_current_tenant_id("tenant-a")
        # The seed only fills in a missing setting; it must see the update.
        results["seed"] = db_json_repository.mutate_collection_locked(
            "connection_settings", lambda rows: rows if rows else [_seed_row("stale-seed")]
        )

    with store.transaction() as ctx:
        store.update("connection_settings", 1, lambda cur: {**cur, "google_cloud_storage_bucket": "admin"}, ctx=ctx)
        thread = threading.Thread(target=seed_again)
        thread.start()
        time.sleep(0.5)
        assert "seed" not in results  # blocked on the same collection lock
    thread.join(10)
    [row] = store.list("connection_settings")
    assert row["google_cloud_storage_bucket"] == "admin"


def test_row_level_collections_refuse_whole_list_replace(db):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as refused:
        db_json_repository.replace_collection("events", [])
    assert refused.value.status_code == 409


def test_s00_audit_script_is_read_only_and_reports_counts(db):
    """The operator's S00 script works and never writes (READ ONLY transaction)."""
    from scripts import audit_datetime_values as audit

    _log_at("2026-10-19T12:00:00+09:00")
    with psycopg.connect(DSN, autocommit=False) as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        result = audit.audit(conn, "tenant-a")
        conn.rollback()
    assert result["Q01_session_timezone"]
    assert result["Q06_access_logs_jst_hour_histogram"] == {12: 1}
    assert "Q16_id_vs_sequence" in result
