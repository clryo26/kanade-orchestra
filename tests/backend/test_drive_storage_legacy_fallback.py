from __future__ import annotations

from src.backend import drive_storage


class _DummyBlob:
    def __init__(self, exists: bool, text: str = "[]"):
        self._exists = exists
        self._text = text

    def exists(self) -> bool:
        return self._exists

    def download_as_text(self, encoding: str = "utf-8") -> str:
        return self._text


class _DummyBucket:
    def __init__(self, mapping: dict[str, _DummyBlob]):
        self._mapping = mapping

    def blob(self, name: str):
        return self._mapping.get(name, _DummyBlob(False))


def test_setting_value_falls_back_to_env_for_empty_bucket(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_STORAGE_BUCKET", "kanade-storage")
    monkeypatch.setattr(
        drive_storage,
        "_connection_setting_record",
        lambda: {
            "google_cloud_storage_bucket": "",
            "google_service_account_file": "",
        },
    )

    assert drive_storage.storage_bucket_name() == "kanade-storage"


def test_load_json_from_storage_uses_legacy_root_object_when_prefixed_missing(monkeypatch):
    monkeypatch.setattr(
        drive_storage,
        "_setting_value",
        lambda json_key, env_key, default="": "app-data" if json_key == "google_cloud_storage_data_prefix" else default,
    )

    bucket = _DummyBucket(
        {
            "app-data/members.json": _DummyBlob(False),
            "members.json": _DummyBlob(True, '[{"id": 1, "name": "A"}]'),
        }
    )
    monkeypatch.setattr(drive_storage, "get_storage_bucket", lambda: bucket)

    loaded = drive_storage.load_json_from_storage("members")
    assert loaded == [{"id": 1, "name": "A"}]
