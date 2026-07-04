from __future__ import annotations

import re
from pathlib import Path

from src.backend.core.db_schema import DB_COLLECTION_COLUMNS, DB_WRITABLE_COLLECTIONS, JSON_COLLECTION_TABLES


PHASE9_TARGET_COLLECTIONS = {
    "performance_day_infos",
    "piece_infos",
    "practice_instructions",
    "part_settings",
    "venue_settings",
    "org_settings",
    "sns_settings",
    "connection_settings",
    "desired_pieces",
    "promotions",
    "albums",
}


def test_phase9_target_collections_are_db_writable() -> None:
    for collection in PHASE9_TARGET_COLLECTIONS:
        assert collection in JSON_COLLECTION_TABLES
        table_name = JSON_COLLECTION_TABLES[collection]
        assert table_name in DB_WRITABLE_COLLECTIONS
        assert table_name in DB_COLLECTION_COLUMNS


def test_multi_tenant_migration_covers_phase9_target_tables() -> None:
    migration_path = Path("db/migrations/004_multi_tenant_organization_id.sql")
    text = migration_path.read_text(encoding="utf-8")
    migrated_tables = set(re.findall(r"'([a-z_]+)'", text))

    missing = sorted(PHASE9_TARGET_COLLECTIONS - migrated_tables)
    assert missing == []
