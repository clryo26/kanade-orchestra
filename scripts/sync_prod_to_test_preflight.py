#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass

EXCLUDED_DB_TABLES = (
    "auth_devices",
    "access_logs",
    "audit_logs",
    "portal_json_collections",
)

EXCLUDED_DB_COLLECTIONS = (
    "production_operation_histories",
)

TARGET_DB_TABLES = (
    "performances",
    "performance_pieces",
    "schedules",
    "announcements",
    "events",
    "members",
    "absences",
    "event_responses",
    "date_adjustments",
    "date_adjustment_candidates",
    "date_adjustment_responses",
    "piece_infos",
    "practice_instructions",
    "performance_day_infos",
    "payments",
    "payment_performance_fees",
    "castings",
    "casting_members",
    "casting_extras",
    "desired_pieces",
    "desired_piece_votes",
    "promotions",
    "albums",
    "album_photos",
    "part_settings",
    "venue_settings",
    "flyer_distributions",
    "flyer_distribution_assignments",
    "org_settings",
    "sns_settings",
    "connection_settings",
    "drive_files",
    "recording_metadata",
    "sheet_library",
)

GCS_TARGET_PREFIXES = (
    "sheets/",
    "albums/",
)

# 録音は固定ディレクトリを持たず、バケット直下の日付から始まる。
GCS_DYNAMIC_PREFIX_POLICIES = (
    {
        "asset_type": "recordings",
        "prefix_pattern": "<YYYY-MM-DD>/",
        "object_path_pattern": "<YYYY-MM-DD>/<曲名>/<ファイル名>",
        "match_regex": r"^\d{4}-\d{2}-\d{2}/",
    },
)

GCS_EXCLUDED_PREFIXES = (
    "auth/",
    "audit/",
    "sync-history/",
    "backups/",
)

REQUIRED_FIELDS = (
    "operation_id",
    "gcp_project_id",
    "gcp_region",
    "prod_db_direct_url",
    "test_db_direct_url",
    "db_name_prod",
    "db_name_test",
    "gcs_bucket_prod",
    "gcs_bucket_test",
)

_OPERATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")


@dataclass(frozen=True)
class SyncPreflightConfig:
    operation_id: str
    gcp_project_id: str
    gcp_region: str
    prod_db_direct_url: str
    test_db_direct_url: str
    db_name_prod: str
    db_name_test: str
    gcs_bucket_prod: str
    gcs_bucket_test: str


@dataclass(frozen=True)
class SyncPreflightResult:
    operation_id: str
    backup_path: str
    target_db_tables: tuple[str, ...]
    excluded_db_tables: tuple[str, ...]
    excluded_db_collections: tuple[str, ...]
    gcs_target_prefixes: tuple[str, ...]
    gcs_dynamic_prefix_policies: tuple[dict[str, str], ...]
    gcs_excluded_prefixes: tuple[str, ...]


def _env_name(field_name: str) -> str:
    return field_name.upper()


def _normalize_bucket_name(value: str) -> str:
    return value.removeprefix("gs://").strip().strip("/")


def _validate_non_empty(config: SyncPreflightConfig) -> list[str]:
    errors: list[str] = []
    values = asdict(config)
    for field_name in REQUIRED_FIELDS:
        if not str(values[field_name]).strip():
            errors.append(f"{_env_name(field_name)} is required")
    return errors


def build_backup_path(gcs_bucket_test: str, operation_id: str) -> str:
    bucket = _normalize_bucket_name(gcs_bucket_test)
    return f"gs://{bucket}/backups/prod-to-test/{operation_id}/"


def run_preflight(config: SyncPreflightConfig) -> SyncPreflightResult:
    errors = _validate_non_empty(config)
    prod_bucket = _normalize_bucket_name(config.gcs_bucket_prod)
    test_bucket = _normalize_bucket_name(config.gcs_bucket_test)

    if config.operation_id and not _OPERATION_ID_RE.fullmatch(config.operation_id):
        errors.append("OPERATION_ID contains unsupported characters")
    if config.db_name_prod.strip() == config.db_name_test.strip():
        errors.append("DB_NAME_PROD and DB_NAME_TEST must be different")
    if prod_bucket and prod_bucket == test_bucket:
        errors.append("GCS_BUCKET_PROD and GCS_BUCKET_TEST must be different")
    if not EXCLUDED_DB_TABLES:
        errors.append("EXCLUDED_DB_TABLES must not be empty")
    if not GCS_TARGET_PREFIXES:
        errors.append("GCS_TARGET_PREFIXES must not be empty")
    if not GCS_DYNAMIC_PREFIX_POLICIES:
        errors.append("GCS_DYNAMIC_PREFIX_POLICIES must not be empty")
    if not GCS_EXCLUDED_PREFIXES:
        errors.append("GCS_EXCLUDED_PREFIXES must not be empty")
    if errors:
        raise ValueError("; ".join(errors))

    return SyncPreflightResult(
        operation_id=config.operation_id,
        backup_path=build_backup_path(test_bucket, config.operation_id),
        target_db_tables=TARGET_DB_TABLES,
        excluded_db_tables=EXCLUDED_DB_TABLES,
        excluded_db_collections=EXCLUDED_DB_COLLECTIONS,
        gcs_target_prefixes=GCS_TARGET_PREFIXES,
        gcs_dynamic_prefix_policies=GCS_DYNAMIC_PREFIX_POLICIES,
        gcs_excluded_prefixes=GCS_EXCLUDED_PREFIXES,
    )


def _read_config_from_args(argv: list[str] | None = None) -> SyncPreflightConfig:
    parser = argparse.ArgumentParser(
        description="Validate prod-to-test sync settings without DB/GCS writes."
    )
    for field_name in REQUIRED_FIELDS:
        parser.add_argument(
            f"--{field_name.replace('_', '-')}",
            default=os.getenv(_env_name(field_name), ""),
        )
    args = parser.parse_args(argv)
    return SyncPreflightConfig(
        operation_id=args.operation_id.strip(),
        gcp_project_id=args.gcp_project_id.strip(),
        gcp_region=args.gcp_region.strip(),
        prod_db_direct_url=args.prod_db_direct_url.strip(),
        test_db_direct_url=args.test_db_direct_url.strip(),
        db_name_prod=args.db_name_prod.strip(),
        db_name_test=args.db_name_test.strip(),
        gcs_bucket_prod=args.gcs_bucket_prod.strip(),
        gcs_bucket_test=args.gcs_bucket_test.strip(),
    )


def main(argv: list[str] | None = None) -> int:
    config = _read_config_from_args(argv)
    try:
        result = run_preflight(config)
    except ValueError as exc:
        print(f"[FAIL] prod-to-test preflight failed: {exc}", file=sys.stderr)
        return 1

    print("[PASS] prod-to-test preflight checks passed")
    print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
