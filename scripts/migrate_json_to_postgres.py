#!/usr/bin/env python3
"""Migrate JSON collections under src/data to PostgreSQL tables.

Usage example:
    uv run python scripts/migrate_json_to_postgres.py \
      --db-host /cloudsql/kanade-orchestra:asia-northeast2:kanade-portal-pg \
      --db-port 5432 \
      --db-name kanade_portal \
      --db-user kanade_app \
      --db-password "${DB_PASSWORD}" \
      --truncate
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb


JSON_COLLECTIONS = (
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
    "castings",
    "piece_infos",
    "practice_instructions",
    "albums",
    "part_settings",
    "venue_settings",
    "org_settings",
    "sns_settings",
    "connection_settings",
    "auth_devices",
    "recording_metadata",
    "desired_pieces",
    "promotions",
)

ALL_TABLES = (
    "performance_pieces",
    "schedules",
    "announcements",
    "events",
    "auth_devices",
    "absences",
    "event_responses",
    "date_adjustment_candidates",
    "date_adjustment_responses",
    "piece_infos",
    "practice_instructions",
    "casting_members",
    "casting_extras",
    "payment_performance_fees",
    "desired_piece_votes",
    "album_photos",
    "drive_files",
    "recording_metadata",
    "sheet_library",
    "payments",
    "castings",
    "desired_pieces",
    "promotions",
    "albums",
    "part_settings",
    "venue_settings",
    "org_settings",
    "sns_settings",
    "connection_settings",
    "performances",
    "members",
    "date_adjustments",
)


@dataclass
class InsertPlan:
    table: str
    columns: list[str]
    rows: list[tuple[Any, ...]]
    has_identity_id: bool = True


AUDIT_COLUMNS = {"created_at", "updated_at"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Migrate JSON collections to PostgreSQL")
    parser.add_argument("--data-dir", default="src/data", help="Directory that contains JSON collections")
    parser.add_argument("--db-url", default="", help="Full PostgreSQL DSN (optional)")
    parser.add_argument("--db-host", default="", help="PostgreSQL host")
    parser.add_argument("--db-port", default="5432", help="PostgreSQL port")
    parser.add_argument("--db-name", default="", help="PostgreSQL database name")
    parser.add_argument("--db-user", default="", help="PostgreSQL user")
    parser.add_argument("--db-password", default="", help="PostgreSQL password")
    parser.add_argument("--truncate", action="store_true", help="Truncate target tables before insert")
    parser.add_argument("--dry-run", action="store_true", help="Show converted row counts only")
    return parser.parse_args()


def load_collection(data_dir: Path, name: str) -> list[dict[str, Any]]:
    path = data_dir / f"{name}.json"
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, str):
        return value
    return str(value)


def nullable_text(value: Any) -> str | None:
    value_text = text(value).strip()
    return value_text if value_text else None


def as_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    value_text = text(value).strip().lower()
    if value_text in {"1", "true", "yes", "on"}:
        return True
    if value_text in {"0", "false", "no", "off"}:
        return False
    return default


def as_decimal(value: Any, default: str = "0") -> Decimal:
    normalized = text(value).strip() or default
    try:
        return Decimal(normalized)
    except (InvalidOperation, ValueError):
        return Decimal(default)


def ensure_ids(rows: list[dict[str, Any]]) -> None:
    max_id = 0
    for row in rows:
        row_id = as_int(row.get("id"))
        if row_id and row_id > max_id:
            max_id = row_id
    for row in rows:
        if as_int(row.get("id")) is None:
            max_id += 1
            row["id"] = max_id


def build_plans(collections: dict[str, list[dict[str, Any]]]) -> list[InsertPlan]:
    plans: list[InsertPlan] = []

    performances = [dict(item) for item in collections.get("performances", [])]
    ensure_ids(performances)
    plans.append(
        InsertPlan(
            table="performances",
            columns=[
                "id",
                "title",
                "date",
                "open_time",
                "start_time",
                "venue",
                "conductor",
                "flyer_image",
                "created_at",
                "updated_at",
            ],
            rows=[
                (
                    as_int(item.get("id")),
                    text(item.get("title"), ""),
                    nullable_text(item.get("date")),
                    nullable_text(item.get("open_time")),
                    nullable_text(item.get("start_time")),
                    text(item.get("venue"), ""),
                    text(item.get("conductor"), ""),
                    text(item.get("flyer_image"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in performances
            ],
        )
    )

    performance_piece_rows: list[dict[str, Any]] = []
    for perf in performances:
        perf_id = as_int(perf.get("id"))
        if perf_id is None:
            continue
        pieces = perf.get("pieces")
        if not isinstance(pieces, list):
            continue
        for idx, piece in enumerate(pieces):
            if isinstance(piece, dict):
                title = text(piece.get("title"), "")
                alias = text(piece.get("alias") or piece.get("short_name"), "")
                composer = text(piece.get("composer"), "")
                is_encore = as_bool(piece.get("is_encore") or piece.get("encore"), False)
                created_at = nullable_text(piece.get("created_at"))
                updated_at = nullable_text(piece.get("updated_at"))
            else:
                title = text(piece, "")
                alias = ""
                composer = ""
                is_encore = False
                created_at = None
                updated_at = None
            if not title:
                continue
            performance_piece_rows.append(
                {
                    "performance_id": perf_id,
                    "sort_order": idx + 1,
                    "title": title,
                    "alias": alias,
                    "composer": composer,
                    "is_encore": is_encore,
                    "created_at": created_at,
                    "updated_at": updated_at,
                }
            )
    ensure_ids(performance_piece_rows)
    plans.append(
        InsertPlan(
            table="performance_pieces",
            columns=[
                "id",
                "performance_id",
                "sort_order",
                "title",
                "alias",
                "composer",
                "is_encore",
                "created_at",
                "updated_at",
            ],
            rows=[
                (
                    as_int(item.get("id")),
                    as_int(item.get("performance_id")),
                    as_int(item.get("sort_order")) or 0,
                    text(item.get("title"), ""),
                    text(item.get("alias"), ""),
                    text(item.get("composer"), ""),
                    as_bool(item.get("is_encore"), False),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in performance_piece_rows
            ],
        )
    )

    simple_mappings: list[tuple[str, list[str], list[tuple[Any, ...]]]] = []

    schedules = [dict(item) for item in collections.get("schedules", [])]
    ensure_ids(schedules)
    simple_mappings.append(
        (
            "schedules",
            [
                "id",
                "date",
                "time",
                "start_time",
                "end_time",
                "venue",
                "available_hours",
                "available_start_time",
                "available_end_time",
                "performance_id",
                "performance_title",
                "pieces",
                "is_conductor_training",
                "is_main_performance",
                "notes",
                "created_at",
                "updated_at",
            ],
            [
                (
                    as_int(item.get("id")),
                    nullable_text(item.get("date")),
                    text(item.get("time"), ""),
                    nullable_text(item.get("start_time")),
                    nullable_text(item.get("end_time")),
                    text(item.get("venue"), ""),
                    text(item.get("available_hours"), ""),
                    nullable_text(item.get("available_start_time")),
                    nullable_text(item.get("available_end_time")),
                    as_int(item.get("performance_id")),
                    text(item.get("performance_title"), ""),
                    text(item.get("pieces"), ""),
                    as_bool(item.get("is_conductor_training"), False),
                    as_bool(item.get("is_main_performance"), False),
                    text(item.get("notes"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in schedules
            ],
        )
    )

    announcements = [dict(item) for item in collections.get("announcements", [])]
    ensure_ids(announcements)
    simple_mappings.append(
        (
            "announcements",
            ["id", "date", "title", "content", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    nullable_text(item.get("date")),
                    text(item.get("title"), ""),
                    text(item.get("content"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in announcements
            ],
        )
    )

    events = [dict(item) for item in collections.get("events", [])]
    ensure_ids(events)
    simple_mappings.append(
        (
            "events",
            ["id", "title", "date", "start_time", "deadline", "url", "notes", "delete_phrase", "fee", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("title"), ""),
                    nullable_text(item.get("date")),
                    nullable_text(item.get("start_time")),
                    nullable_text(item.get("deadline")),
                    text(item.get("url"), ""),
                    text(item.get("notes"), ""),
                    text(item.get("delete_phrase"), ""),
                    text(item.get("fee"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in events
            ],
        )
    )

    members = [dict(item) for item in collections.get("members", [])]
    ensure_ids(members)
    simple_mappings.append(
        (
            "members",
            [
                "id",
                "name",
                "last_name",
                "first_name",
                "maiden_name",
                "last_name_kana",
                "first_name_kana",
                "maiden_name_kana",
                "part",
                "photo_url",
                "is_founder",
                "is_recording_manager",
                "is_sheet_manager",
                "password",
                "permission",
                "joined_at",
                "system_access_until",
                "introducer",
                "role",
                "instrument_history",
                "past_orchestras",
                "comment",
                "created_at",
                "updated_at",
            ],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("name"), ""),
                    text(item.get("last_name"), ""),
                    text(item.get("first_name"), ""),
                    text(item.get("maiden_name"), ""),
                    text(item.get("last_name_kana"), ""),
                    text(item.get("first_name_kana"), ""),
                    text(item.get("maiden_name_kana"), ""),
                    text(item.get("part"), ""),
                    text(item.get("photo_url"), ""),
                    as_bool(item.get("is_founder"), False),
                    as_bool(item.get("is_recording_manager"), False),
                    as_bool(item.get("is_sheet_manager"), False),
                    text(item.get("password"), ""),
                    text(item.get("permission"), "一般"),
                    nullable_text(item.get("joined_at")),
                    nullable_text(item.get("system_access_until")),
                    text(item.get("introducer"), ""),
                    text(item.get("role"), ""),
                    text(item.get("instrument_history"), ""),
                    text(item.get("past_orchestras"), ""),
                    text(item.get("comment"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in members
            ],
        )
    )

    auth_devices = [dict(item) for item in collections.get("auth_devices", [])]
    ensure_ids(auth_devices)
    simple_mappings.append(
        (
            "auth_devices",
            [
                "id",
                "device_id",
                "device_name",
                "member_id",
                "member_name",
                "member_part",
                "permission",
                "system_access_until",
                "is_recording_manager",
                "is_sheet_manager",
                "hidden_user",
                "user_agent",
                "authenticated_at",
                "last_seen_at",
                "created_at",
                "updated_at",
            ],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("device_id"), ""),
                    text(item.get("device_name"), ""),
                    as_int(item.get("member_id")),
                    text(item.get("member_name"), ""),
                    text(item.get("member_part"), ""),
                    text(item.get("permission"), "一般"),
                    nullable_text(item.get("system_access_until")),
                    as_bool(item.get("is_recording_manager"), False),
                    as_bool(item.get("is_sheet_manager"), False),
                    as_bool(item.get("hidden_user"), False),
                    text(item.get("user_agent"), ""),
                    nullable_text(item.get("authenticated_at")),
                    nullable_text(item.get("last_seen_at")),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in auth_devices
            ],
        )
    )

    for collection_name, table_name, key1, key2 in (
        ("absences", "absences", "schedule_id", "member_id"),
        ("event_responses", "event_responses", "event_id", "member_id"),
    ):
        items = [dict(item) for item in collections.get(collection_name, [])]
        ensure_ids(items)
        simple_mappings.append(
            (
                table_name,
                ["id", key1, key2, "name", "status", "note", "created_at", "updated_at"],
                [
                    (
                        as_int(item.get("id")),
                        as_int(item.get(key1)),
                        as_int(item.get(key2)),
                        text(item.get("name"), ""),
                        text(item.get("status"), ""),
                        text(item.get("note"), ""),
                        nullable_text(item.get("created_at")),
                        nullable_text(item.get("updated_at")),
                    )
                    for item in items
                ],
            )
        )

    date_adjustments = [dict(item) for item in collections.get("date_adjustments", [])]
    ensure_ids(date_adjustments)
    simple_mappings.append(
        (
            "date_adjustments",
            ["id", "title", "deadline", "notes", "delete_phrase", "created_by", "member_id", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("title"), ""),
                    nullable_text(item.get("deadline")),
                    text(item.get("notes"), ""),
                    text(item.get("delete_phrase"), ""),
                    text(item.get("created_by"), ""),
                    as_int(item.get("member_id")),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in date_adjustments
            ],
        )
    )

    candidate_rows: list[dict[str, Any]] = []
    for adjustment in date_adjustments:
        adjustment_id = as_int(adjustment.get("id"))
        if adjustment_id is None:
            continue
        candidates = adjustment.get("candidates")
        if not isinstance(candidates, list):
            continue
        for idx, candidate in enumerate(candidates):
            if not isinstance(candidate, dict):
                continue
            candidate_rows.append(
                {
                    "adjustment_id": adjustment_id,
                    "candidate_key": text(candidate.get("id"), f"cand-{idx + 1}"),
                    "date": nullable_text(candidate.get("date")),
                    "start_time": nullable_text(candidate.get("start_time")),
                    "end_time": nullable_text(candidate.get("end_time")),
                    "note": text(candidate.get("note"), ""),
                    "sort_order": idx,
                    "created_at": nullable_text(candidate.get("created_at")),
                    "updated_at": nullable_text(candidate.get("updated_at")),
                }
            )
    ensure_ids(candidate_rows)
    simple_mappings.append(
        (
            "date_adjustment_candidates",
            ["id", "adjustment_id", "candidate_key", "date", "start_time", "end_time", "note", "sort_order", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    as_int(item.get("adjustment_id")),
                    text(item.get("candidate_key"), ""),
                    nullable_text(item.get("date")),
                    nullable_text(item.get("start_time")),
                    nullable_text(item.get("end_time")),
                    text(item.get("note"), ""),
                    as_int(item.get("sort_order")) or 0,
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in candidate_rows
            ],
        )
    )

    responses = [dict(item) for item in collections.get("date_adjustment_responses", [])]
    ensure_ids(responses)
    simple_mappings.append(
        (
            "date_adjustment_responses",
            ["id", "adjustment_id", "candidate_key", "member_id", "name", "status", "note", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    as_int(item.get("adjustment_id")),
                    text(item.get("candidate_id") or item.get("candidate_key"), ""),
                    as_int(item.get("member_id")),
                    text(item.get("name"), ""),
                    text(item.get("status"), ""),
                    text(item.get("note"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in responses
            ],
        )
    )

    for collection_name in ("piece_infos", "practice_instructions", "promotions"):
        items = [dict(item) for item in collections.get(collection_name, [])]
        ensure_ids(items)
        if collection_name == "piece_infos":
            cols = ["id", "performance_id", "piece", "description", "created_at", "updated_at"]
            rows = [
                (
                    as_int(item.get("id")),
                    as_int(item.get("performance_id")),
                    text(item.get("piece"), ""),
                    text(item.get("description"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in items
            ]
        elif collection_name == "practice_instructions":
            cols = ["id", "performance_id", "piece", "practice_notes", "performance_instruction", "created_at", "updated_at"]
            rows = [
                (
                    as_int(item.get("id")),
                    as_int(item.get("performance_id")),
                    text(item.get("piece"), ""),
                    text(item.get("practice_notes"), ""),
                    text(item.get("performance_instruction"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in items
            ]
        else:
            cols = ["id", "title", "summary", "image_url", "member_id", "registered_by", "created_at", "updated_at"]
            rows = [
                (
                    as_int(item.get("id")),
                    text(item.get("title"), ""),
                    text(item.get("summary") or item.get("description"), ""),
                    text(item.get("image_url"), ""),
                    as_int(item.get("member_id")),
                    text(item.get("registered_by"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in items
            ]
        simple_mappings.append((collection_name, cols, rows))

    payments = [dict(item) for item in collections.get("payments", [])]
    ensure_ids(payments)
    simple_mappings.append(
        (
            "payments",
            [
                "id",
                "member_id",
                "name",
                "paid_from_month",
                "paid_until_month",
                "latest_payment_date",
                "membership_fee_amount",
                "created_at",
                "updated_at",
            ],
            [
                (
                    as_int(item.get("id")),
                    as_int(item.get("member_id")),
                    text(item.get("name"), ""),
                    text(item.get("paid_from_month"), ""),
                    text(item.get("paid_until_month") or item.get("membership_fee") or item.get("dues"), ""),
                    nullable_text(item.get("latest_payment_date")),
                    as_decimal(item.get("membership_fee_amount"), "0"),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in payments
            ],
        )
    )

    performance_fee_rows: list[dict[str, Any]] = []
    for payment in payments:
        payment_id = as_int(payment.get("id"))
        if payment_id is None:
            continue
        fee_map = payment.get("performance_fees") if isinstance(payment.get("performance_fees"), dict) else {}
        amount_map = payment.get("performance_fee_amounts") if isinstance(payment.get("performance_fee_amounts"), dict) else {}
        perf_ids = set(fee_map.keys()) | set(amount_map.keys())
        for perf_id in perf_ids:
            parsed_perf_id = as_int(perf_id)
            if parsed_perf_id is None:
                continue
            performance_fee_rows.append(
                {
                    "payment_id": payment_id,
                    "performance_id": parsed_perf_id,
                    "is_paid": as_bool(fee_map.get(perf_id), False),
                    "fee_amount": as_decimal(amount_map.get(perf_id), "0"),
                    "created_at": nullable_text(payment.get("created_at")),
                    "updated_at": nullable_text(payment.get("updated_at")),
                }
            )
    plans.append(
        InsertPlan(
            table="payment_performance_fees",
            columns=["payment_id", "performance_id", "is_paid", "fee_amount", "created_at", "updated_at"],
            rows=[
                (
                    as_int(item.get("payment_id")),
                    as_int(item.get("performance_id")),
                    as_bool(item.get("is_paid"), False),
                    as_decimal(item.get("fee_amount"), "0"),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in performance_fee_rows
            ],
            has_identity_id=False,
        )
    )

    castings = [dict(item) for item in collections.get("castings", [])]
    ensure_ids(castings)
    simple_mappings.append(
        (
            "castings",
            ["id", "performance_id", "piece", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    as_int(item.get("performance_id")),
                    text(item.get("piece"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in castings
            ],
        )
    )

    casting_member_rows: list[dict[str, Any]] = []
    casting_extra_rows: list[dict[str, Any]] = []
    for casting in castings:
        casting_id = as_int(casting.get("id"))
        if casting_id is None:
            continue
        members_data = casting.get("members") if isinstance(casting.get("members"), list) else []
        extras_data = casting.get("extras") if isinstance(casting.get("extras"), list) else []
        for idx, member_item in enumerate(members_data):
            if not isinstance(member_item, dict):
                continue
            casting_member_rows.append(
                {
                    "casting_id": casting_id,
                    "member_id": as_int(member_item.get("member_id")),
                    "part": text(member_item.get("part"), ""),
                    "sort_order": idx,
                    "created_at": nullable_text(member_item.get("created_at")) or nullable_text(casting.get("created_at")),
                    "updated_at": nullable_text(member_item.get("updated_at")) or nullable_text(casting.get("updated_at")),
                }
            )
        for idx, extra_item in enumerate(extras_data):
            if not isinstance(extra_item, dict):
                continue
            casting_extra_rows.append(
                {
                    "casting_id": casting_id,
                    "name": text(extra_item.get("name"), ""),
                    "furigana": text(extra_item.get("furigana"), ""),
                    "part": text(extra_item.get("part"), ""),
                    "sort_order": idx,
                    "created_at": nullable_text(extra_item.get("created_at")) or nullable_text(casting.get("created_at")),
                    "updated_at": nullable_text(extra_item.get("updated_at")) or nullable_text(casting.get("updated_at")),
                }
            )
    ensure_ids(casting_member_rows)
    ensure_ids(casting_extra_rows)
    simple_mappings.append(
        (
            "casting_members",
            ["id", "casting_id", "member_id", "part", "sort_order", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    as_int(item.get("casting_id")),
                    as_int(item.get("member_id")),
                    text(item.get("part"), ""),
                    as_int(item.get("sort_order")) or 0,
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in casting_member_rows
            ],
        )
    )
    simple_mappings.append(
        (
            "casting_extras",
            ["id", "casting_id", "name", "furigana", "part", "sort_order", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    as_int(item.get("casting_id")),
                    text(item.get("name"), ""),
                    text(item.get("furigana"), ""),
                    text(item.get("part"), ""),
                    as_int(item.get("sort_order")) or 0,
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in casting_extra_rows
            ],
        )
    )

    desired_pieces = [dict(item) for item in collections.get("desired_pieces", [])]
    ensure_ids(desired_pieces)
    simple_mappings.append(
        (
            "desired_pieces",
            ["id", "title", "piece", "composer", "duration", "genre", "formation", "notes", "member_id", "registered_by", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("title"), ""),
                    text(item.get("piece"), ""),
                    text(item.get("composer"), ""),
                    text(item.get("duration"), ""),
                    text(item.get("genre"), ""),
                    text(item.get("formation"), ""),
                    text(item.get("notes"), ""),
                    as_int(item.get("member_id")),
                    text(item.get("registered_by"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in desired_pieces
            ],
        )
    )

    desired_vote_rows: list[dict[str, Any]] = []
    for piece in desired_pieces:
        piece_id = as_int(piece.get("id"))
        if piece_id is None:
            continue
        votes = piece.get("votes") if isinstance(piece.get("votes"), list) else []
        for vote in votes:
            if isinstance(vote, dict):
                member_id = as_int(vote.get("member_id"))
                name = text(vote.get("name"), "")
                voted_at = nullable_text(vote.get("voted_at"))
            else:
                member_id = None
                name = text(vote, "")
                voted_at = None
            desired_vote_rows.append(
                {
                    "desired_piece_id": piece_id,
                    "member_id": member_id,
                    "name": name,
                    "voted_at": voted_at,
                    "created_at": nullable_text(piece.get("created_at")),
                    "updated_at": nullable_text(piece.get("updated_at")),
                }
            )
    ensure_ids(desired_vote_rows)
    simple_mappings.append(
        (
            "desired_piece_votes",
            ["id", "desired_piece_id", "member_id", "name", "voted_at", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    as_int(item.get("desired_piece_id")),
                    as_int(item.get("member_id")),
                    text(item.get("name"), ""),
                    nullable_text(item.get("voted_at")),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in desired_vote_rows
            ],
        )
    )

    albums = [dict(item) for item in collections.get("albums", [])]
    ensure_ids(albums)
    simple_mappings.append(
        (
            "albums",
            ["id", "event_name", "created_by_member_id", "created_by_member_name", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("event_name"), ""),
                    as_int(item.get("created_by_member_id")),
                    text(item.get("created_by_member_name"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in albums
            ],
        )
    )

    album_photo_rows: list[dict[str, Any]] = []
    for album in albums:
        album_id = as_int(album.get("id"))
        if album_id is None:
            continue
        photos = album.get("photos") if isinstance(album.get("photos"), list) else []
        for photo in photos:
            if not isinstance(photo, dict):
                continue
            album_photo_rows.append(
                {
                    "id": as_int(photo.get("id")),
                    "album_id": album_id,
                    "filename": text(photo.get("filename"), ""),
                    "url": text(photo.get("url"), ""),
                    "object_name": text(photo.get("object_name"), ""),
                    "path": text(photo.get("path"), ""),
                    "uploaded_by_member_id": as_int(photo.get("uploaded_by_member_id")),
                    "uploaded_by_member_name": text(photo.get("uploaded_by_member_name"), ""),
                    "uploaded_at": nullable_text(photo.get("uploaded_at")),
                    "created_at": nullable_text(photo.get("created_at")),
                    "updated_at": nullable_text(photo.get("updated_at")),
                }
            )
    ensure_ids(album_photo_rows)
    simple_mappings.append(
        (
            "album_photos",
            [
                "id",
                "album_id",
                "filename",
                "url",
                "object_name",
                "path",
                "uploaded_by_member_id",
                "uploaded_by_member_name",
                "uploaded_at",
                "created_at",
                "updated_at",
            ],
            [
                (
                    as_int(item.get("id")),
                    as_int(item.get("album_id")),
                    text(item.get("filename"), ""),
                    text(item.get("url"), ""),
                    text(item.get("object_name"), ""),
                    text(item.get("path"), ""),
                    as_int(item.get("uploaded_by_member_id")),
                    text(item.get("uploaded_by_member_name"), ""),
                    nullable_text(item.get("uploaded_at")),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in album_photo_rows
            ],
        )
    )

    part_settings = [dict(item) for item in collections.get("part_settings", [])]
    ensure_ids(part_settings)
    simple_mappings.append(
        (
            "part_settings",
            ["id", "name", "sort_order", "is_active", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("name"), ""),
                    as_int(item.get("sort_order") or item.get("display_order")) or 0,
                    as_bool(item.get("is_active"), True),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in part_settings
            ],
        )
    )

    venue_settings = [dict(item) for item in collections.get("venue_settings", [])]
    ensure_ids(venue_settings)
    simple_mappings.append(
        (
            "venue_settings",
            ["id", "name", "address", "for_practice", "for_performance", "notes", "sort_order", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("name"), ""),
                    text(item.get("address"), ""),
                    as_bool(item.get("for_practice"), True),
                    as_bool(item.get("for_performance"), True),
                    text(item.get("notes"), ""),
                    as_int(item.get("sort_order")) or 0,
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in venue_settings
            ],
        )
    )

    org_settings = [dict(item) for item in collections.get("org_settings", [])]
    ensure_ids(org_settings)
    simple_mappings.append(
        (
            "org_settings",
            ["id", "organization_name", "organization_abbreviation", "short_name", "icon_url", "membership_fee_amount", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("organization_name") or item.get("organization_name_full"), ""),
                    text(item.get("organization_abbreviation"), ""),
                    text(item.get("short_name"), ""),
                    text(item.get("icon_url") or item.get("logo_url"), ""),
                    as_decimal(item.get("membership_fee_amount"), "0"),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in org_settings
            ],
        )
    )

    sns_settings = [dict(item) for item in collections.get("sns_settings", [])]
    ensure_ids(sns_settings)
    simple_mappings.append(
        (
            "sns_settings",
            ["id", "line_url", "x_url", "instagram_url", "youtube_url", "facebook_url", "website_url", "extra_links", "created_at", "updated_at"],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("line_url"), ""),
                    text(item.get("x_url"), ""),
                    text(item.get("instagram_url"), ""),
                    text(item.get("youtube_url"), ""),
                    text(item.get("facebook_url"), ""),
                    text(item.get("website_url"), ""),
                    Jsonb(item.get("extra_links") if isinstance(item.get("extra_links"), list) else []),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in sns_settings
            ],
        )
    )

    connection_settings = [dict(item) for item in collections.get("connection_settings", [])]
    ensure_ids(connection_settings)
    simple_mappings.append(
        (
            "connection_settings",
            [
                "id",
                "google_project_id",
                "google_cloud_storage_bucket",
                "google_cloud_storage_data_prefix",
                "google_cloud_storage_public",
                "google_service_account_file",
                "google_service_account_json",
                "created_at",
                "updated_at",
            ],
            [
                (
                    as_int(item.get("id")),
                    text(item.get("google_project_id"), ""),
                    text(item.get("google_cloud_storage_bucket"), ""),
                    text(item.get("google_cloud_storage_data_prefix"), ""),
                    as_bool(item.get("google_cloud_storage_public"), False),
                    text(item.get("google_service_account_file"), ""),
                    text(item.get("google_service_account_json"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
                for item in connection_settings
            ],
        )
    )

    for collection_name, columns in (
        ("drive_files", ["id", "source", "object_name", "path", "name", "url", "size_bytes", "mime_type", "created_at", "updated_at"]),
        ("recording_metadata", ["id", "source", "object_name", "path", "name", "date", "piece", "duration_seconds", "duration", "mime_type", "size_bytes", "created_at", "updated_at"]),
        ("sheet_library", ["id", "performance_id", "performance_title", "piece", "part", "source", "name", "path", "object_name", "url", "view_url", "download_url", "size_bytes", "mime_type", "created_at", "updated_at"]),
    ):
        items = [dict(item) for item in collections.get(collection_name, [])]
        ensure_ids(items)
        rows: list[tuple[Any, ...]] = []
        for item in items:
            if collection_name == "drive_files":
                row = (
                    as_int(item.get("id")),
                    text(item.get("source"), ""),
                    text(item.get("object_name"), ""),
                    text(item.get("path"), ""),
                    text(item.get("name"), ""),
                    text(item.get("url"), ""),
                    as_int(item.get("size_bytes")),
                    text(item.get("mime_type"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
            elif collection_name == "recording_metadata":
                row = (
                    as_int(item.get("id")),
                    text(item.get("source"), ""),
                    text(item.get("object_name"), ""),
                    text(item.get("path"), ""),
                    text(item.get("name"), ""),
                    nullable_text(item.get("date")),
                    text(item.get("piece"), ""),
                    as_decimal(item.get("duration_seconds"), "0"),
                    text(item.get("duration"), ""),
                    text(item.get("mime_type"), ""),
                    as_int(item.get("size_bytes")),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
            else:
                row = (
                    as_int(item.get("id")),
                    as_int(item.get("performance_id")),
                    text(item.get("performance_title"), ""),
                    text(item.get("piece"), ""),
                    text(item.get("part"), ""),
                    text(item.get("source"), ""),
                    text(item.get("name"), ""),
                    text(item.get("path"), ""),
                    text(item.get("object_name"), ""),
                    text(item.get("url"), ""),
                    text(item.get("view_url"), ""),
                    text(item.get("download_url"), ""),
                    as_int(item.get("size_bytes")),
                    text(item.get("mime_type"), ""),
                    nullable_text(item.get("created_at")),
                    nullable_text(item.get("updated_at")),
                )
            rows.append(row)
        simple_mappings.append((collection_name, columns, rows))

    for table_name, columns, rows in simple_mappings:
        plans.append(InsertPlan(table=table_name, columns=columns, rows=rows))

    return plans


def print_plan_summary(plans: list[InsertPlan]) -> None:
    print("Migration row counts:")
    for plan in plans:
        print(f"  - {plan.table}: {len(plan.rows)}")


def fetch_table_count(conn: psycopg.Connection[Any], table_name: str) -> int:
    query = sql.SQL("SELECT COUNT(*) FROM {};").format(sql.Identifier(table_name))
    with conn.cursor() as cur:
        cur.execute(query)
        result = cur.fetchone()
    return int(result[0]) if result else 0


def print_reconciliation_summary(conn: psycopg.Connection[Any], plans: list[InsertPlan]) -> bool:
    print("Reconciliation (JSON rows vs DB table rows):")
    all_matched = True
    for plan in plans:
        expected = len(plan.rows)
        actual = fetch_table_count(conn, plan.table)
        matched = expected == actual
        all_matched = all_matched and matched
        status = "OK" if matched else "NG"
        print(f"  - {plan.table}: expected={expected}, actual={actual} [{status}]")

    result_label = "MATCHED" if all_matched else "MISMATCH"
    print(f"RECONCILIATION_RESULT: {result_label}")
    return all_matched


def truncate_tables(conn: psycopg.Connection[Any]) -> None:
    table_identifiers = sql.SQL(", ").join(sql.Identifier(name) for name in ALL_TABLES)
    query = sql.SQL("TRUNCATE TABLE {} RESTART IDENTITY CASCADE").format(table_identifiers)
    with conn.cursor() as cur:
        cur.execute(query)


def insert_plan(conn: psycopg.Connection[Any], plan: InsertPlan) -> None:
    if not plan.rows:
        return
    rows = rows_with_audit_defaults(plan)
    placeholders = sql.SQL(", ").join(sql.Placeholder() for _ in plan.columns)
    query = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        sql.Identifier(plan.table),
        sql.SQL(", ").join(sql.Identifier(col) for col in plan.columns),
        placeholders,
    )
    with conn.cursor() as cur:
        cur.executemany(query, rows)


def rows_with_audit_defaults(plan: InsertPlan, default_timestamp: str | None = None) -> list[tuple[Any, ...]]:
    audit_indexes = [idx for idx, column in enumerate(plan.columns) if column in AUDIT_COLUMNS]
    if not audit_indexes:
        return plan.rows

    fallback = default_timestamp or datetime.now(timezone.utc).isoformat()
    created_index = plan.columns.index("created_at") if "created_at" in plan.columns else None
    updated_index = plan.columns.index("updated_at") if "updated_at" in plan.columns else None
    normalized_rows: list[tuple[Any, ...]] = []
    for row in plan.rows:
        values = list(row)
        if created_index is not None and values[created_index] is None:
            values[created_index] = fallback
        if updated_index is not None and values[updated_index] is None:
            values[updated_index] = values[created_index] if created_index is not None else fallback
        normalized_rows.append(tuple(values))
    return normalized_rows


def sync_identity_sequence(conn: psycopg.Connection[Any], table_name: str) -> None:
    query = sql.SQL(
        "SELECT setval(pg_get_serial_sequence(%s, 'id'), COALESCE((SELECT MAX(id) FROM {}), 0) + 1, false)"
    ).format(sql.Identifier(table_name))
    with conn.cursor() as cur:
        cur.execute(query, (table_name,))


def get_connection_string(args: argparse.Namespace) -> str:
    if args.db_url:
        return args.db_url
    required = [args.db_host, args.db_name, args.db_user, args.db_password]
    if not all(required):
        raise ValueError("DB connection parameters are incomplete. Set --db-url or all of --db-host/--db-name/--db-user/--db-password")
    return (
        f"host={args.db_host} "
        f"port={args.db_port} "
        f"dbname={args.db_name} "
        f"user={args.db_user} "
        f"password={args.db_password} "
        "sslmode=disable"
    )


def main() -> int:
    args = parse_args()
    data_dir = Path(args.data_dir)
    if not data_dir.exists():
        raise FileNotFoundError(f"Data directory not found: {data_dir}")

    collections = {name: load_collection(data_dir, name) for name in JSON_COLLECTIONS}
    plans = build_plans(collections)
    print_plan_summary(plans)

    if args.dry_run:
        print("Dry-run mode: no DB changes applied.")
        return 0

    conn_str = get_connection_string(args)
    with psycopg.connect(conn_str, autocommit=False) as conn:
        if args.truncate:
            print("Truncating target tables...")
            truncate_tables(conn)
        for plan in plans:
            insert_plan(conn, plan)
            if plan.has_identity_id:
                sync_identity_sequence(conn, plan.table)
        conn.commit()
        print_reconciliation_summary(conn, plans)

    print("Migration completed successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
