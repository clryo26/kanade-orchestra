from __future__ import annotations

import pytest
from fastapi import HTTPException

from src.backend.repositories import db_json_repository, db_row_repository
from src.backend.services import json_collection_service


def test_db_row_repository_db_row_to_json_keeps_compat_aliases(backend_env, monkeypatch):
    monkeypatch.setattr(db_row_repository, "_core", lambda: backend_env)

    row = db_row_repository.db_row_to_json(
        {
            "id": 1,
            "sort_order": 10,
            "organization_name": "Kanade Orchestra",
            "organization_abbreviation": "Kanade",
            "candidate_key": "cand-1",
        }
    )

    assert row["display_order"] == 10
    assert row["name"] == "Kanade Orchestra"
    assert row["short_name"] == "Kanade"
    assert row["candidate_id"] == "cand-1"


def test_db_row_repository_db_item_value_uses_current_tenant_for_organization_id(monkeypatch):
    monkeypatch.setattr(db_row_repository, "get_current_tenant_id", lambda: "tenant-a")

    assert db_row_repository.db_item_value("members", {}, "organization_id") == "tenant-a"


def test_db_row_repository_collection_rows_for_save_normalizes_drive_files(backend_env, monkeypatch):
    monkeypatch.setattr(db_row_repository, "_core", lambda: backend_env)

    rows = db_row_repository.db_collection_rows_for_save(
        "drive_files",
        [{"id": "folder/sample.mp3", "name": "sample.mp3", "source": "google_cloud_storage"}],
    )

    assert rows[0]["object_name"] == "folder/sample.mp3"
    assert "id" not in rows[0]
    assert rows[0]["created_at"]
    assert rows[0]["updated_at"]


def test_db_row_repository_prepares_non_null_timestamps_for_upsert():
    rows = [{"id": 1, "title": "Concert", "created_at": None, "updated_at": None}]

    db_row_repository.db_prepare_timestamp_columns_for_upsert("performances", rows)

    assert rows[0]["created_at"]
    assert rows[0]["updated_at"]


def test_db_row_repository_child_rows_for_collection_builds_payment_children(backend_env, monkeypatch):
    monkeypatch.setattr(db_row_repository, "_core", lambda: backend_env)

    children = db_row_repository.db_child_rows_for_collection(
        "payments",
        [{"id": 1, "performance_fees": {"10": True}, "performance_fee_amounts": {"10": "1500"}}],
    )

    row = children["payment_performance_fees"][0]
    assert row["payment_id"] == 1
    assert row["performance_id"] == "10"
    assert row["is_paid"] is True
    assert row["fee_amount"] == "1500"


def test_db_row_repository_db_fetch_all_rejects_unknown_table(backend_env, monkeypatch):
    monkeypatch.setattr(db_row_repository, "_core", lambda: backend_env)

    with pytest.raises(HTTPException) as exc_info:
        db_row_repository.db_fetch_all(conn=None, table_name="unknown_table")

    assert "Unsupported DB table" in str(exc_info.value.detail)


def test_db_json_repository_load_json_data_returns_empty_for_unknown_collection(backend_env, monkeypatch):
    monkeypatch.setattr(db_json_repository, "_core", lambda: backend_env)

    assert db_json_repository.load_json_data("unknown_collection") == []


def test_db_json_repository_replace_collection_rejects_non_writable_collection(backend_env, monkeypatch):
    monkeypatch.setattr(db_json_repository, "_core", lambda: backend_env)

    with pytest.raises(HTTPException) as exc_info:
        db_json_repository.replace_collection("unknown_collection", [{"id": 1}])

    assert "DB write is not implemented" in str(exc_info.value.detail)


def test_json_collection_service_uses_generic_db_store_for_non_table_extra():
    stored: dict[str, list[dict]] = {"custom_extra": [{"id": 1, "name": "legacy"}]}
    cache: dict[str, list[dict]] = {}

    class Cache:
        def get(self, name):
            return cache.get(name)

        def set(self, name, value):
            cache[name] = value

    loaded = json_collection_service.load_json_data(
        "custom_extra",
        cache=Cache(),
        local_json_fallback_enabled=lambda: False,
        ensure_db_expected_is_ready=lambda: None,
        db_load_json_data=lambda name: [],
        db_load_generic_json_collection=lambda name: stored.get(name, []),
        json_collection_tables={},
        json_data_names=(),
        extra_collections={"custom_extra"},
        data_dir=None,
        logger=None,
    )
    assert loaded == [{"id": 1, "name": "legacy"}]

    json_collection_service.save_json_data(
        "custom_extra",
        [{"id": 2, "name": "saved"}],
        cache=Cache(),
        local_json_fallback_enabled=lambda: False,
        ensure_db_expected_is_ready=lambda: None,
        db_replace_collection=lambda name, data: (_ for _ in ()).throw(AssertionError("structured DB should not be used")),
        db_save_generic_json_collection=lambda name, data: stored.__setitem__(name, data),
        db_writable_collections=set(),
        json_data_names=(),
        extra_collections={"custom_extra"},
        data_dir=None,
    )
    assert stored["custom_extra"] == [{"id": 2, "name": "saved"}]
