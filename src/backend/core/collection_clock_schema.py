"""PERF-R04: one dependency definition for SQL, readers and verification."""
from __future__ import annotations

import os

from .db_schema import DB_CHILD_PARENT_KEYS, DB_CHILD_TABLES, JSON_COLLECTION_TABLES

CLOCK_SCHEMA_VERSION = "clock-v1"
LITE_COLLECTIONS = ("performances", "schedules", "announcements", "members", "payments",
                    "part_settings", "org_settings", "sns_settings", "menu_visibility")
READ_DEPENDENCIES = {
    "/api/bootstrap-lite": LITE_COLLECTIONS,
    "/api/bootstrap-core": ("menu_visibility",),
    **{f"/api/{name}": (name,) for name in ("performances", "schedules", "announcements", "events", "members")},
    "/api/member-introductions": ("members",),
}
CLOCK_PATHS = frozenset(READ_DEPENDENCIES) - {"/api/member-introductions"}
CLOCK_COLLECTIONS = tuple(sorted({name for deps in READ_DEPENDENCIES.values() for name in deps}))
MAINTENANCE_ROLE = "portal_clock_maintainers"  # provisioned separately; never granted to app automatically


def table_dependencies() -> dict[str, str]:
    result = {"menu_visibility_settings": "menu_visibility"}
    for name in CLOCK_COLLECTIONS:
        if name == "menu_visibility":
            continue
        result[JSON_COLLECTION_TABLES[name]] = name
        for child in DB_CHILD_TABLES.get(name, ()):
            if child not in DB_CHILD_PARENT_KEYS:
                raise ValueError("Missing child-parent definition")
            result[child] = name
    return dict(sorted(result.items()))


def configured_paths() -> tuple[frozenset[str], frozenset[str]]:
    """Use ordinary env configuration; defaults never change runtime behaviour."""
    def parse(key: str, allowed) -> frozenset[str]:
        values = frozenset(v.strip() for v in os.getenv(key, "").split(",") if v.strip())
        if not values <= allowed:
            raise ValueError(f"Unsupported path in {key}")
        return values
    reads = parse("PORTAL_READ_CONTEXT_PATHS", frozenset(READ_DEPENDENCIES))
    clocks = parse("PORTAL_VERSION_ETAG_PATHS", CLOCK_PATHS)
    if not clocks <= reads:
        raise ValueError("Version ETags require the corresponding read context")
    return reads, clocks
