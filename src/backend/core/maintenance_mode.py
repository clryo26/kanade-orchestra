from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass


_FALSE_VALUES = {"", "0", "false", "no", "off"}
_TRUE_VALUES = {"1", "true", "yes", "on"}
_TEST_APP_ENV = "test"
_TEST_CLOUD_RUN_SERVICE = "kanade-orchestra-test"


class MaintenanceModeConfigurationError(RuntimeError):
    """Raised when maintenance mode cannot be enabled safely."""


@dataclass(frozen=True)
class MaintenanceModeConfig:
    """Startup-only maintenance mode decision."""

    enabled: bool

    @property
    def status(self) -> str:
        return "enabled" if self.enabled else "disabled"


def resolve_maintenance_mode(environ: Mapping[str, str | None]) -> MaintenanceModeConfig:
    """Parse and validate maintenance mode without reading global state.

    Enabling the guard is intentionally limited to the dedicated test Cloud Run
    service. Invalid or ambiguous configuration fails closed during app creation.
    """

    raw_mode = str(environ.get("MAINTENANCE_MODE") or "").strip().lower()
    if raw_mode in _FALSE_VALUES:
        return MaintenanceModeConfig(enabled=False)
    if raw_mode not in _TRUE_VALUES:
        raise MaintenanceModeConfigurationError("MAINTENANCE_MODE has an invalid boolean value")

    app_env = str(environ.get("APP_ENV") or "").strip().lower()
    cloud_run_service = str(environ.get("K_SERVICE") or "").strip()
    if app_env != _TEST_APP_ENV or cloud_run_service != _TEST_CLOUD_RUN_SERVICE:
        raise MaintenanceModeConfigurationError(
            "Maintenance mode is only allowed for the dedicated test service"
        )

    return MaintenanceModeConfig(enabled=True)
