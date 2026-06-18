from __future__ import annotations


def test_storage_enabled_falls_back_to_env_when_connection_settings_has_template_bucket(
    client,
    backend_env,
    monkeypatch,
):
    monkeypatch.setenv("GOOGLE_CLOUD_STORAGE_BUCKET", "kanade-storage")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "kanade-orchestra")

    from src.backend import drive_storage

    monkeypatch.setattr(
        drive_storage,
        "_connection_setting_record",
        lambda: {
            "google_project_id": "",
            "google_cloud_storage_bucket": "あなたのGCSバケット名",
            "google_cloud_storage_data_prefix": "app-data",
            "google_cloud_storage_public": "false",
            "google_service_account_file": "",
            "google_service_account_json": "",
        },
    )

    assert drive_storage.storage_bucket_name() == "kanade-storage"
    assert drive_storage.storage_enabled() is True


def test_seed_connection_settings_from_env_when_existing_record_is_placeholder(client, backend_env, monkeypatch):
    settings = backend_env.load_json_data("connection_settings")
    settings.append(
        {
            "id": 1,
            "google_project_id": "",
            "google_cloud_storage_bucket": "あなたのGCSバケット名",
            "google_cloud_storage_data_prefix": "app-data",
            "google_cloud_storage_public": "false",
            "google_service_account_file": "",
            "google_service_account_json": "",
        }
    )
    backend_env.save_json_data("connection_settings", settings)

    monkeypatch.setenv("GOOGLE_CLOUD_STORAGE_BUCKET", "kanade-storage")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "kanade-orchestra")

    backend_env.seed_connection_settings_from_legacy_env()

    updated = backend_env.load_json_data("connection_settings")
    assert any(item.get("google_cloud_storage_bucket") == "kanade-storage" for item in updated)
