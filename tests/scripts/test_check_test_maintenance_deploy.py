from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.check_test_maintenance_deploy import (
    MaintenanceDeployGuardError,
    ensure_normal_deploy_allowed,
    main,
)


def _service(*entries):
    return {"spec": {"template": {"spec": {"containers": [{"env": list(entries)}]}}}}


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off", " FALSE "])
def test_absent_or_disabled_maintenance_allows_normal_deploy(value):
    ensure_normal_deploy_allowed(_service({"name": "MAINTENANCE_MODE", "value": value}))


def test_absent_maintenance_allows_normal_deploy():
    ensure_normal_deploy_allowed(_service())


@pytest.mark.parametrize("value", ["1", "true", "yes", "on", " TRUE "])
def test_enabled_maintenance_blocks_normal_deploy(value):
    with pytest.raises(MaintenanceDeployGuardError, match="maintenance is enabled"):
        ensure_normal_deploy_allowed(_service({"name": "MAINTENANCE_MODE", "value": value}))


def test_invalid_maintenance_value_blocks_normal_deploy():
    with pytest.raises(MaintenanceDeployGuardError, match="invalid boolean"):
        ensure_normal_deploy_allowed(
            _service({"name": "MAINTENANCE_MODE", "value": "disabled"})
        )


def test_secret_backed_maintenance_value_blocks_normal_deploy():
    with pytest.raises(MaintenanceDeployGuardError, match="plain environment value"):
        ensure_normal_deploy_allowed(
            _service({"name": "MAINTENANCE_MODE", "valueFrom": {"secretKeyRef": {}}})
        )


def test_duplicate_maintenance_values_block_normal_deploy():
    with pytest.raises(MaintenanceDeployGuardError, match="duplicated"):
        ensure_normal_deploy_allowed(
            _service(
                {"name": "MAINTENANCE_MODE", "value": "false"},
                {"name": "MAINTENANCE_MODE", "value": "false"},
            )
        )


@pytest.mark.parametrize(
    "service",
    [
        {},
        {"spec": {"template": {"spec": {"containers": []}}}},
        {"spec": {"template": {"spec": {"containers": [{}, {}]}}}},
    ],
)
def test_missing_or_ambiguous_container_configuration_blocks_normal_deploy(service):
    with pytest.raises(MaintenanceDeployGuardError):
        ensure_normal_deploy_allowed(service)


def test_cli_returns_success_for_disabled_maintenance(monkeypatch, tmp_path: Path):
    payload = tmp_path / "service.json"
    payload.write_text(json.dumps(_service()), encoding="utf-8")
    with payload.open(encoding="utf-8") as stream:
        monkeypatch.setattr("sys.stdin", stream)
        assert main() == 0


def test_cli_fails_closed_for_invalid_json(monkeypatch, tmp_path: Path):
    payload = tmp_path / "service.json"
    payload.write_text("not-json", encoding="utf-8")
    with payload.open(encoding="utf-8") as stream:
        monkeypatch.setattr("sys.stdin", stream)
        assert main() == 1
