from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1].parent
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR = BASE_DIR / "uploads"
DATA_DIR = BASE_DIR / "data"
SAMPLE_DIR = BASE_DIR.parent / "sample"
TIMETABLE_TEMPLATE_PATH = SAMPLE_DIR / "本番タイムテーブル.xlsx"
CONVERTED_DIR = UPLOAD_DIR / "converted"
DRIVE_STAGING_DIR = UPLOAD_DIR / "drive-staging"
SHEET_DIR = UPLOAD_DIR / "sheets"

JSON_DATA_NAMES = (
    "performances",
    "schedules",
    "announcements",
    "drive_files",
    "events",
    "members",
    "absences",
    "event_responses",
    "date_adjustments",
    "date_adjustment_responses",
    "sheet_library",
    "payments",
    "flyer_places",
    "flyer_distributions",
    "castings",
    "piece_infos",
    "practice_instructions",
    "performance_day_infos",
    "albums",
    "part_settings",
    "venue_settings",
    "org_settings",
    "sns_settings",
    "connection_settings",
    "auth_devices",
    "access_logs",
    "recording_metadata",
    "desired_pieces",
    "promotions",
)

DEFAULT_STARTUP_PRELOAD_COLLECTIONS = (
    "performances",
    "schedules",
    "announcements",
    "events",
    "members",
    "payments",
    "flyer_places",
    "part_settings",
    "venue_settings",
    "org_settings",
    "sns_settings",
    "connection_settings",
)

_startup_preload_env = os.getenv("STARTUP_PRELOAD_COLLECTIONS", "").strip()
STARTUP_PRELOAD_COLLECTIONS = tuple(
    name.strip() for name in _startup_preload_env.split(",") if name.strip()
) or DEFAULT_STARTUP_PRELOAD_COLLECTIONS
