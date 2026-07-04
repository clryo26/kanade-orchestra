from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv


def load_environment() -> None:
    load_dotenv()


def configure_logging() -> logging.Logger:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    return logging.getLogger("src.backend.app")


def app_cors_origins() -> list[str]:
    cors_env = os.getenv("CORS_ORIGINS", "").strip()
    return [origin.strip() for origin in cors_env.split(",") if origin.strip()] if cors_env else ["*"]


def ensure_runtime_directories(*directories: Path) -> None:
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)
