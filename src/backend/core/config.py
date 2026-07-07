from __future__ import annotations

import os
from dataclasses import dataclass


PRODUCTION_OPERATION_ALLOWED_ENV = "test"


@dataclass(frozen=True)
class AppConfig:
    env: str = os.getenv("APP_ENV", "dev")
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    cors_origins: str = os.getenv("CORS_ORIGINS", "*")


def get_config() -> AppConfig:
    return AppConfig()


def normalized_app_env(value: str | None = None) -> str:
    raw = os.getenv("APP_ENV", "") if value is None else value
    return str(raw or "").strip().lower()


def app_env_for_production_operations() -> str:
    env = normalized_app_env()
    return env if env else "unset"


def production_operations_allowed_env() -> str:
    return PRODUCTION_OPERATION_ALLOWED_ENV


def is_production_operation_env() -> bool:
    return app_env_for_production_operations() == production_operations_allowed_env()
