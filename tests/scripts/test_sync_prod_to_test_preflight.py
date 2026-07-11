from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


def _load_preflight_module():
    script_path = Path("scripts/sync_prod_to_test_preflight.py")
    spec = importlib.util.spec_from_file_location("sync_prod_to_test_preflight_for_test", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _valid_config(module):
    return module.SyncPreflightConfig(
        operation_id="sync-20260712-001",
        gcp_project_id="kanade-project",
        gcp_region="asia-northeast1",
        cloud_sql_instance="kanade-sql",
        db_name_prod="kanade_prod",
        db_name_test="kanade_test",
        gcs_bucket_prod="kanade-prod",
        gcs_bucket_test="kanade-test",
    )


def _valid_env_values():
    return {
        "OPERATION_ID": "sync-cli-001",
        "GCP_PROJECT_ID": "kanade-project",
        "GCP_REGION": "asia-northeast1",
        "CLOUD_SQL_INSTANCE": "kanade-sql",
        "DB_NAME_PROD": "kanade_prod",
        "DB_NAME_TEST": "kanade_test",
        "GCS_BUCKET_PROD": "kanade-prod",
        "GCS_BUCKET_TEST": "kanade-test",
    }


def test_preflight_generates_fixed_backup_path_and_policy_lists():
    module = _load_preflight_module()

    result = module.run_preflight(_valid_config(module))

    assert result.backup_path == "gs://kanade-test/backups/prod-to-test/sync-20260712-001/"
    assert result.excluded_db_tables == (
        "auth_devices",
        "access_logs",
        "audit_logs",
        "production_operation_histories",
    )
    assert result.gcs_target_prefixes == ("recordings/", "sheets/", "albums/", "promotion/")
    assert result.gcs_excluded_prefixes == ("auth/", "audit/", "sync-history/", "backups/")


@pytest.mark.parametrize(
    ("field_name", "expected_message"),
    [
        ("operation_id", "OPERATION_ID is required"),
        ("gcp_project_id", "GCP_PROJECT_ID is required"),
        ("gcp_region", "GCP_REGION is required"),
        ("cloud_sql_instance", "CLOUD_SQL_INSTANCE is required"),
        ("db_name_prod", "DB_NAME_PROD is required"),
        ("db_name_test", "DB_NAME_TEST is required"),
        ("gcs_bucket_prod", "GCS_BUCKET_PROD is required"),
        ("gcs_bucket_test", "GCS_BUCKET_TEST is required"),
    ],
)
def test_preflight_rejects_empty_required_fields(field_name, expected_message):
    module = _load_preflight_module()
    config = _valid_config(module)
    config = module.SyncPreflightConfig(**{**config.__dict__, field_name: ""})

    with pytest.raises(ValueError) as exc_info:
        module.run_preflight(config)

    assert expected_message in str(exc_info.value)


@pytest.mark.parametrize("operation_id", ["sync/20260712", "sync 20260712"])
def test_preflight_rejects_unsupported_operation_id_characters(operation_id):
    module = _load_preflight_module()
    config = _valid_config(module)
    config = module.SyncPreflightConfig(**{**config.__dict__, "operation_id": operation_id})

    with pytest.raises(ValueError) as exc_info:
        module.run_preflight(config)

    assert "OPERATION_ID contains unsupported characters" in str(exc_info.value)


def test_preflight_rejects_same_prod_and_test_database():
    module = _load_preflight_module()
    config = _valid_config(module)
    config = module.SyncPreflightConfig(
        **{**config.__dict__, "db_name_test": config.db_name_prod}
    )

    try:
        module.run_preflight(config)
    except ValueError as exc:
        assert "DB_NAME_PROD and DB_NAME_TEST must be different" in str(exc)
    else:  # pragma: no cover - assertion clarity
        raise AssertionError("same prod/test database should be rejected")


def test_preflight_rejects_same_prod_and_test_bucket():
    module = _load_preflight_module()
    config = _valid_config(module)
    config = module.SyncPreflightConfig(
        **{**config.__dict__, "gcs_bucket_test": f"gs://{config.gcs_bucket_prod}/"}
    )

    try:
        module.run_preflight(config)
    except ValueError as exc:
        assert "GCS_BUCKET_PROD and GCS_BUCKET_TEST must be different" in str(exc)
    else:  # pragma: no cover - assertion clarity
        raise AssertionError("same prod/test bucket should be rejected")


def test_preflight_cli_accepts_environment_values(monkeypatch, capsys):
    module = _load_preflight_module()
    for key, value in _valid_env_values().items():
        monkeypatch.setenv(key, value)

    assert module.main([]) == 0
    output = capsys.readouterr().out
    assert "[PASS] prod-to-test preflight checks passed" in output
    assert "gs://kanade-test/backups/prod-to-test/sync-cli-001/" in output


def test_preflight_cli_returns_failure_for_empty_required_env(monkeypatch, capsys):
    module = _load_preflight_module()
    env_values = _valid_env_values()
    env_values["GCP_PROJECT_ID"] = ""
    for key, value in env_values.items():
        monkeypatch.setenv(key, value)

    assert module.main([]) == 1
    captured = capsys.readouterr()
    assert "[FAIL] prod-to-test preflight failed:" in captured.err
