#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db" / "migrations" / "004_multi_tenant_organization_id.sql"

REQUIRED_TABLES = {
    "members",
    "auth_devices",
    "performances",
    "schedules",
    "events",
    "payments",
    "org_settings",
    "access_logs",
}


def fail(message: str) -> None:
    print(f"[FAIL] {message}")
    raise SystemExit(1)


def main() -> int:
    if not MIGRATION.exists():
        fail("tenant migration file not found")

    sql = MIGRATION.read_text(encoding="utf-8")

    if "organization_id" not in sql:
        fail("organization_id column definition is missing")

    if "DEFAULT 'default'" not in sql and "DEFAULT ''default''" not in sql:
        fail("default organization_id value is missing")

    for table in REQUIRED_TABLES:
        if f"'{table}'" not in sql:
            fail(f"required table is missing from migration target list: {table}")

    if "CREATE INDEX IF NOT EXISTS" not in sql:
        fail("expected organization_id index creation is missing")

    print("[PASS] Tenant migration includes required organization_id targets and indexes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
