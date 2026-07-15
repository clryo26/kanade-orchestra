#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from collections.abc import Mapping
from typing import Any

_DISABLED_VALUES = {"", "0", "false", "no", "off"}
_ENABLED_VALUES = {"1", "true", "yes", "on"}


class MaintenanceDeployGuardError(RuntimeError):
    """Raised when a normal test deploy cannot be allowed safely."""


def _maintenance_entries(service: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    try:
        containers = service["spec"]["template"]["spec"]["containers"]
    except (KeyError, TypeError) as exc:
        raise MaintenanceDeployGuardError("Cloud Run service container configuration is missing") from exc
    if not isinstance(containers, list) or len(containers) != 1:
        raise MaintenanceDeployGuardError("Cloud Run service must contain exactly one container")
    container = containers[0]
    if not isinstance(container, Mapping):
        raise MaintenanceDeployGuardError("Cloud Run service container configuration is invalid")
    env = container.get("env", [])
    if not isinstance(env, list):
        raise MaintenanceDeployGuardError("Cloud Run service environment configuration is invalid")
    return [item for item in env if isinstance(item, Mapping) and item.get("name") == "MAINTENANCE_MODE"]


def ensure_normal_deploy_allowed(service: Mapping[str, Any]) -> None:
    """Allow a normal deploy only when maintenance is absent or explicitly disabled."""

    entries = _maintenance_entries(service)
    if len(entries) > 1:
        raise MaintenanceDeployGuardError("MAINTENANCE_MODE is duplicated")
    if not entries:
        return

    entry = entries[0]
    if "valueFrom" in entry or "value" not in entry:
        raise MaintenanceDeployGuardError("MAINTENANCE_MODE must be a plain environment value")
    value = str(entry["value"]).strip().lower()
    if value in _ENABLED_VALUES:
        raise MaintenanceDeployGuardError("test maintenance is enabled")
    if value not in _DISABLED_VALUES:
        raise MaintenanceDeployGuardError("MAINTENANCE_MODE has an invalid boolean value")


def main() -> int:
    try:
        service = json.load(sys.stdin)
        if not isinstance(service, Mapping):
            raise MaintenanceDeployGuardError("Cloud Run service response is invalid")
        ensure_normal_deploy_allowed(service)
    except (json.JSONDecodeError, MaintenanceDeployGuardError) as exc:
        print(f"::error::Deploy Test is blocked: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
