from __future__ import annotations

import asyncio

from fastapi import HTTPException
import pytest

from src.backend.core import db_runtime

pytestmark = pytest.mark.db_profile


def test_part_settings_db_rows_keep_frontend_display_order(backend_env):
    row = backend_env.db_row_to_json({"id": 1, "name": "Violin", "sort_order": 20, "is_active": True})

    assert row["display_order"] == 20


def test_part_settings_save_uses_db_when_database_is_enabled(backend_env, monkeypatch):
    saved: dict[str, list[dict]] = {}
    data = [{"id": 1, "name": "Violin", "display_order": 20, "is_active": True}]

    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_replace_collection", lambda name, rows: saved.setdefault(name, rows))

    backend_env.save_json_data("part_settings", data)

    assert saved == {"part_settings": data}
    assert backend_env.load_json_data("part_settings") == data


def test_db_write_values_accept_month_and_display_order_alias(backend_env):
    part_row = backend_env.db_row_tuple(
        "part_settings",
        backend_env.DB_COLLECTION_COLUMNS["part_settings"],
        {"id": "1", "name": "Violin", "display_order": "20", "is_active": "true"},
    )
    payment_row = backend_env.db_row_tuple(
        "payments",
        backend_env.DB_COLLECTION_COLUMNS["payments"],
        {"id": "1", "member_id": "2", "paid_until_month": "2022-09", "latest_payment_date": "2022-09"},
    )

    assert part_row[2] == 20
    assert part_row[3] is True
    assert payment_row[3] == ""
    assert payment_row[4] == "2022-09"
    assert payment_row[5] == "2022-09-01"


def test_db_time_values_are_returned_as_hour_minute(backend_env):
    assert backend_env.parse_db_time("18:30:00") == "18:30"
    assert backend_env.parse_db_time(backend_env.time(9, 5, 30)) == "09:05"


def test_performance_db_row_keeps_performance_fee_amount(backend_env):
    row = backend_env.db_row_tuple(
        "performances",
        backend_env.DB_COLLECTION_COLUMNS["performances"],
        {
            "id": "1",
            "title": "Concert",
            "date": "2026-07-01",
            "open_time": "17:00",
            "start_time": "18:00",
            "venue": "Hall",
            "conductor": "Cond",
            "performance_fee_amount": "5000",
        },
    )

    assert row[8] == backend_env.Decimal("5000")


def test_drive_files_db_save_uses_object_name_instead_of_string_id(backend_env):
    rows = backend_env.db_collection_rows_for_save(
        "drive_files",
        [
            {
                "id": "2026-06-14/Concert/take1.mp3",
                "name": "take1.mp3",
                "source": "google_cloud_storage",
            }
        ],
    )

    assert "id" not in rows[0]
    assert rows[0]["object_name"] == "2026-06-14/Concert/take1.mp3"
    assert rows[0]["created_at"]
    assert rows[0]["updated_at"]


def test_drive_files_db_row_has_required_timestamps(backend_env):
    rows = backend_env.db_collection_rows_for_save(
        "drive_files",
        [
            {
                "source": "google_cloud_storage",
                "object_name": "2026-06-14/Concert/take1.mp3",
                "name": "take1.mp3",
                "mime_type": "audio/mpeg",
            }
        ],
    )
    row_tuple = backend_env.db_row_tuple(
        "drive_files",
        backend_env.DB_COLLECTION_COLUMNS["drive_files"],
        rows[0],
    )

    assert row_tuple[8] is not None
    assert row_tuple[9] is not None


def test_access_logs_are_db_backed_collection(backend_env):
    assert "access_logs" in backend_env.PORTAL_DB_TABLES
    assert backend_env.JSON_COLLECTION_TABLES["access_logs"] == "access_logs"
    assert "accessed_at" in backend_env.DB_TIMESTAMP_COLUMNS["access_logs"]
    assert "member_id" in backend_env.DB_INT_COLUMNS["access_logs"]


def test_schema_compatibility_creates_admin_save_tables():
    executed: list[str] = []

    class Cursor:
        def execute(self, sql, params=None):
            executed.append(str(sql))

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    class Conn:
        def cursor(self):
            return Cursor()

    db_runtime.ensure_db_schema_compatibility(Conn())
    sql_text = "\n".join(executed)

    for table_name in (
        "performances",
        "schedules",
        "events",
        "members",
        "payments",
        "castings",
        "piece_infos",
        "practice_instructions",
        "performance_day_infos",
        "part_settings",
        "venue_settings",
        "org_settings",
        "sns_settings",
        "connection_settings",
        "desired_pieces",
        "promotions",
        "albums",
    ):
        assert f'CREATE TABLE IF NOT EXISTS "{table_name}"' in sql_text
        assert f'ALTER TABLE "{table_name}" ADD COLUMN IF NOT EXISTS organization_id' in sql_text

    assert '"timeline_rows" JSONB NOT NULL DEFAULT' in sql_text
    assert '"costume_detail" JSONB NOT NULL DEFAULT' in sql_text


def test_performance_day_infos_are_db_writable_collection(backend_env):
    assert "performance_day_infos" in backend_env.PORTAL_DB_TABLES
    assert backend_env.JSON_COLLECTION_TABLES["performance_day_infos"] == "performance_day_infos"
    assert "performance_day_infos" in backend_env.DB_WRITABLE_COLLECTIONS
    assert {"timeline_rows", "costume_detail", "assignments_rows"} <= backend_env.DB_JSON_COLUMNS["performance_day_infos"]
    assert {"id", "performance_id"} <= backend_env.DB_INT_COLUMNS["performance_day_infos"]

    row = backend_env.db_row_tuple(
        "performance_day_infos",
        backend_env.DB_COLLECTION_COLUMNS["performance_day_infos"],
        {
            "id": "1",
            "performance_id": "2",
            "timeline": "09:00 集合",
            "timeline_rows": [{"start_time": "09:00", "content": "集合"}],
            "costume_detail": {"male": {"upper": "黒"}},
            "costume": "黒衣装",
            "assignments_rows": [{"role": "受付", "members": "田中"}],
            "assignments": "受付: 田中",
            "timetable": "09:00 集合",
            "duties": "受付: 田中",
        },
    )

    assert row[0] == 1
    assert row[1] == 2
    assert row[2] == "09:00 集合"
    assert row[5] == "黒衣装"
    assert row[7] == "受付: 田中"


def test_remember_drive_file_deduplicates_by_object_name(backend_env):
    backend_env.save_json_data(
        "drive_files",
        [
            {
                "id": 1,
                "object_name": "2026-06-14/Concert/take1.mp3",
                "name": "old.mp3",
                "source": "google_cloud_storage",
            }
        ],
    )

    backend_env.remember_drive_file(
        {
            "id": "2026-06-14/Concert/take1.mp3",
            "object_name": "2026-06-14/Concert/take1.mp3",
            "name": "take1.mp3",
            "source": "google_cloud_storage",
        }
    )

    rows = backend_env.load_json_data("drive_files")
    assert len(rows) == 1
    assert rows[0]["name"] == "take1.mp3"
    assert rows[0]["created_at"]
    assert rows[0]["updated_at"]


def test_payment_child_rows_are_built_for_db_foreign_keys(backend_env):
    rows = backend_env.db_child_rows_for_collection(
        "payments",
        [
            {
                "id": 1,
                "performance_fees": {"10": True},
                "performance_fee_amounts": {"10": "1500"},
            }
        ],
    )
    db_row = backend_env.db_row_tuple(
        "payment_performance_fees",
        backend_env.DB_CHILD_COLUMNS["payment_performance_fees"],
        rows["payment_performance_fees"][0],
    )

    assert db_row[:4] == (1, 10, True, backend_env.Decimal("1500"))


def test_org_settings_accept_frontend_payload_without_membership_fee(backend_env):
    row = backend_env.db_row_tuple(
        "org_settings",
        backend_env.DB_COLLECTION_COLUMNS["org_settings"],
        {"id": "1", "name": "Kanade Orchestra", "short_name": "Kanade", "icon_url": "data:image/png;base64,x"},
    )

    assert row[1] == "Kanade Orchestra"
    assert row[2] == "Kanade"
    assert row[3] == "Kanade"
    assert row[4] == "data:image/png;base64,x"
    assert row[5] == backend_env.Decimal("0")


def test_db_rows_fill_json_compatibility_keys(backend_env):
    row = backend_env.db_row_to_json(
        {
            "id": 1,
            "organization_name": "Kanade Orchestra",
            "organization_abbreviation": "Kanade",
            "membership_fee_amount": backend_env.Decimal("1000"),
        }
    )

    assert row["name"] == "Kanade Orchestra"
    assert row["short_name"] == "Kanade"
    assert row["membership_fee_amount"] == "1000"

    response_row = backend_env.db_row_to_json({"id": 2, "candidate_key": "cand-1"})

    assert response_row["candidate_id"] == "cand-1"


def test_load_json_data_raises_when_db_is_expected_but_not_fully_configured(backend_env, monkeypatch):
    monkeypatch.setenv("DB_HOST", "/cloudsql/project:region:instance")
    monkeypatch.delenv("DB_NAME", raising=False)
    monkeypatch.delenv("DB_USER", raising=False)
    monkeypatch.delenv("DB_PASSWORD", raising=False)
    backend_env._memory_cache.clear()

    try:
        backend_env.load_json_data("members")
        assert False, "Expected HTTPException"
    except HTTPException as exc:
        assert exc.status_code == 500
        assert "DB is expected" in str(exc.detail)


def test_seed_cloud_data_preloads_only_startup_collections(backend_env, monkeypatch):
    loaded_names: list[str] = []

    monkeypatch.setattr(backend_env, "seed_connection_settings_from_legacy_env", lambda: None)
    monkeypatch.setattr(backend_env, "storage_enabled", lambda: False)

    def fake_load_json_data(name):
        loaded_names.append(name)
        return []

    monkeypatch.setattr(backend_env, "load_json_data", fake_load_json_data)

    asyncio.run(backend_env.seed_cloud_data_from_local())

    assert tuple(loaded_names) == backend_env.STARTUP_PRELOAD_COLLECTIONS


def test_save_json_data_raises_when_db_is_expected_but_not_fully_configured(backend_env, monkeypatch):
    monkeypatch.setenv("DB_REQUIRED", "true")
    monkeypatch.delenv("DB_URL", raising=False)
    monkeypatch.delenv("DB_HOST", raising=False)
    monkeypatch.delenv("DB_NAME", raising=False)
    monkeypatch.delenv("DB_USER", raising=False)
    monkeypatch.delenv("DB_PASSWORD", raising=False)
    backend_env._memory_cache.clear()

    try:
        backend_env.save_json_data("members", [{"id": 1, "name": "A"}])
        assert False, "Expected HTTPException"
    except HTTPException as exc:
        assert exc.status_code == 500
        assert "DB is expected" in str(exc.detail)


def test_bootstrap_reads_from_db_mode_for_members_and_extras(client, backend_env, monkeypatch):
    db_store = {
        "performances": [{"id": 1, "title": "Concert"}],
        "schedules": [{"id": 1, "date": "2026-06-29"}],
        "announcements": [{"id": 1, "content": "Notice"}],
        "members": [{"id": 10, "name": "Db Member", "part": "Vn"}],
        "payments": [{"id": 1, "member_id": 10, "paid_until_month": "2026-06"}],
        "part_settings": [{"id": 1, "name": "Vn", "sort_order": 1, "display_order": 1, "is_active": True}],
        "org_settings": [{"id": 1, "name": "Kanade"}],
        "sns_settings": [],
        "connection_settings": [],
    }

    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_load_json_data", lambda name: [dict(item) for item in db_store.get(name, [])])
    monkeypatch.setattr(backend_env, "storage_enabled", lambda: False)
    backend_env._memory_cache.clear()

    response = client.get("/api/bootstrap-lite")

    assert response.status_code == 200
    payload = response.json()
    assert payload["members"][0]["name"] == "Db Member"
    assert payload["extras"]["payments"][0]["member_id"] == 10


def test_bootstrap_lite_etag_changes_when_non_performance_data_changes(client, backend_env):
    backend_env._memory_cache.clear()
    backend_env.save_json_data("performances", [{"id": 1, "title": "Concert"}])
    backend_env.save_json_data("schedules", [{"id": 1, "date": "2026-06-29", "venue": "A"}])

    first = client.get("/api/bootstrap-lite")
    assert first.status_code == 200
    etag = first.headers.get("etag") or first.headers.get("ETag")
    assert etag

    backend_env.save_json_data("schedules", [{"id": 1, "date": "2026-06-29", "venue": "B"}])
    second = client.get("/api/bootstrap-lite", headers={"If-None-Match": etag})

    assert second.status_code == 200
    assert second.json()["schedules"][0]["venue"] == "B"
    assert (second.headers.get("etag") or second.headers.get("ETag")) != etag


def test_run_db_startup_self_check_skips_when_db_not_expected(backend_env, monkeypatch):
    monkeypatch.setattr(backend_env, "db_expected", lambda: False)

    backend_env.run_db_startup_self_check()


def test_run_db_startup_self_check_raises_when_connection_fails(backend_env, monkeypatch):
    monkeypatch.setattr(backend_env, "db_expected", lambda: True)
    monkeypatch.setattr(backend_env, "ensure_db_expected_is_ready", lambda: None)
    monkeypatch.setattr(backend_env, "assert_db_ready", lambda: None)
    monkeypatch.setattr(backend_env, "db_connection_string", lambda: "host=example")

    class _BrokenPsycopg:
        @staticmethod
        def connect(*args, **kwargs):
            raise RuntimeError("connection refused")

    monkeypatch.setattr(backend_env, "psycopg", _BrokenPsycopg)

    with pytest.raises(RuntimeError, match="DB startup self-check failed"):
        backend_env.run_db_startup_self_check()
