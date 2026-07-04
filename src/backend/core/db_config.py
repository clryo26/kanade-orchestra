from __future__ import annotations

import os
from typing import Any

from fastapi import HTTPException


def db_connection_string() -> str:
    db_url = os.getenv("DB_URL", "").strip()
    if db_url:
        return db_url

    db_host = os.getenv("DB_HOST", "").strip()
    db_port = os.getenv("DB_PORT", "5432").strip()
    db_name = os.getenv("DB_NAME", "").strip()
    db_user = os.getenv("DB_USER", "").strip()
    db_password = os.getenv("DB_PASSWORD", "").strip()
    if not all([db_host, db_name, db_user, db_password]):
        raise HTTPException(
            status_code=500,
            detail="DB connection env vars are incomplete (DB_HOST/DB_NAME/DB_USER/DB_PASSWORD or DB_URL)",
        )
    return (
        f"host={db_host} "
        f"port={db_port} "
        f"dbname={db_name} "
        f"user={db_user} "
        f"password={db_password} "
        "sslmode=disable"
    )


def mask_db_value(column_name: str, value: Any) -> Any:
    lowered = column_name.lower()
    if value is None:
        return None
    if lowered in {"password", "google_service_account_json", "google_service_account_file"}:
        text_value = str(value)
        if len(text_value) <= 8:
            return "********"
        return f"{text_value[:4]}...{text_value[-4:]}"
    return value


def assert_db_ready(psycopg: Any, psql: Any) -> None:
    if psycopg is None or psql is None:
        raise HTTPException(status_code=500, detail="psycopg is not installed")
