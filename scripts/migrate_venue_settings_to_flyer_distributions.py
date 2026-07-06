#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from dataclasses import dataclass

import psycopg


@dataclass
class MigrationStats:
    total_source: int
    eligible_source: int
    already_migrated: int
    insertable: int
    inserted: int = 0
    deleted_source: int = 0


def connection_string() -> str:
    if os.getenv("DB_URL", "").strip():
        return os.environ["DB_URL"]

    required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]
    missing = [name for name in required if not os.getenv(name, "").strip()]
    if missing:
        raise SystemExit(f"Missing DB env vars: {', '.join(missing)}")

    return (
        f"host={os.environ['DB_HOST']} "
        f"port={os.getenv('DB_PORT', '5432')} "
        f"dbname={os.environ['DB_NAME']} "
        f"user={os.environ['DB_USER']} "
        f"password={os.environ['DB_PASSWORD']} "
        f"sslmode={os.getenv('DB_SSLMODE', 'disable')}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Migrate legacy flyer distribution rows from venue_settings "
            "(for_practice=false and for_performance=false) "
            "to flyer_distributions."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Execute INSERT migration. If omitted, run as dry-run.",
    )
    parser.add_argument(
        "--delete-source",
        action="store_true",
        help="Delete migrated rows from venue_settings after successful insert (only with --apply).",
    )
    return parser.parse_args()


def ensure_tables_exist(cur: psycopg.Cursor) -> None:
    cur.execute("SELECT to_regclass('public.venue_settings'), to_regclass('public.flyer_distributions')")
    row = cur.fetchone()
    if not row:
        raise SystemExit("Failed to validate required tables")
    venue_table, flyer_table = row
    if venue_table is None:
        raise SystemExit("Table not found: public.venue_settings")
    if flyer_table is None:
        raise SystemExit(
            "Table not found: public.flyer_distributions. "
            "Apply DB migration 006_flyer_distributions.sql first."
        )


def collect_stats(cur: psycopg.Cursor) -> MigrationStats:
    cur.execute("SELECT COUNT(*) FROM venue_settings")
    total_source = int(cur.fetchone()[0])

    cur.execute(
        """
        SELECT COUNT(*)
        FROM venue_settings v
        WHERE COALESCE(v.for_practice, FALSE) = FALSE
          AND COALESCE(v.for_performance, FALSE) = FALSE
        """
    )
    eligible_source = int(cur.fetchone()[0])

    cur.execute(
        """
        SELECT COUNT(*)
        FROM venue_settings v
        WHERE COALESCE(v.for_practice, FALSE) = FALSE
          AND COALESCE(v.for_performance, FALSE) = FALSE
          AND EXISTS (
              SELECT 1
              FROM flyer_distributions f
              WHERE f.organization_id = COALESCE(v.organization_id, 'default')
                AND f.facility_name = COALESCE(v.name, '')
                AND f.area_address = COALESCE(v.address, '')
                AND f.note = COALESCE(v.notes, '')
          )
        """
    )
    already_migrated = int(cur.fetchone()[0])

    insertable = max(eligible_source - already_migrated, 0)
    return MigrationStats(
        total_source=total_source,
        eligible_source=eligible_source,
        already_migrated=already_migrated,
        insertable=insertable,
    )


def run_insert(cur: psycopg.Cursor) -> int:
    cur.execute(
        """
        INSERT INTO flyer_distributions (
            organization_id,
            facility_name,
            area_address,
            note,
            created_at,
            updated_at
        )
        SELECT
            COALESCE(v.organization_id, 'default') AS organization_id,
            COALESCE(v.name, '') AS facility_name,
            COALESCE(v.address, '') AS area_address,
            COALESCE(v.notes, '') AS note,
            COALESCE(v.created_at, NOW()) AS created_at,
            COALESCE(v.updated_at, NOW()) AS updated_at
        FROM venue_settings v
        WHERE COALESCE(v.for_practice, FALSE) = FALSE
          AND COALESCE(v.for_performance, FALSE) = FALSE
          AND NOT EXISTS (
              SELECT 1
              FROM flyer_distributions f
              WHERE f.organization_id = COALESCE(v.organization_id, 'default')
                AND f.facility_name = COALESCE(v.name, '')
                AND f.area_address = COALESCE(v.address, '')
                AND f.note = COALESCE(v.notes, '')
          )
        """
    )
    return cur.rowcount or 0


def run_delete_source(cur: psycopg.Cursor) -> int:
    cur.execute(
        """
        DELETE FROM venue_settings v
        WHERE COALESCE(v.for_practice, FALSE) = FALSE
          AND COALESCE(v.for_performance, FALSE) = FALSE
          AND EXISTS (
              SELECT 1
              FROM flyer_distributions f
              WHERE f.organization_id = COALESCE(v.organization_id, 'default')
                AND f.facility_name = COALESCE(v.name, '')
                AND f.area_address = COALESCE(v.address, '')
                AND f.note = COALESCE(v.notes, '')
          )
        """
    )
    return cur.rowcount or 0


def print_stats(stats: MigrationStats, *, mode: str) -> None:
    print(f"mode: {mode}")
    print(f"total venue_settings rows: {stats.total_source}")
    print(f"eligible legacy flyer rows: {stats.eligible_source}")
    print(f"already migrated rows: {stats.already_migrated}")
    print(f"insertable rows: {stats.insertable}")
    if mode == "apply":
        print(f"inserted rows: {stats.inserted}")
        print(f"deleted source rows: {stats.deleted_source}")


def main() -> None:
    args = parse_args()
    if args.delete_source and not args.apply:
        raise SystemExit("--delete-source requires --apply")

    with psycopg.connect(connection_string(), autocommit=False) as conn:
        with conn.cursor() as cur:
            ensure_tables_exist(cur)
            stats = collect_stats(cur)

            if not args.apply:
                conn.rollback()
                print_stats(stats, mode="dry-run")
                return

            stats.inserted = run_insert(cur)
            if args.delete_source:
                stats.deleted_source = run_delete_source(cur)
            conn.commit()
            print_stats(stats, mode="apply")


if __name__ == "__main__":
    main()
