"""Read-only S00 checks for the JST remediation (plan 10.2, Q01-Q06, Q09-Q16).

Runs inside a READ ONLY transaction and prints counts / settings only - no
row values, member data or secrets (the DSN is read from DB_URL and never
printed). Run by the operator against TEST (and production read-only role);
paste the JSON summary into the plan's appendix.

  DB_URL=... python scripts/audit_datetime_values.py [--organization default]

Q07 (app/DB clock difference) needs the deployed app: pass --health-url to
compare /api/health ``timestamp`` with the DB clock. Q08 (Cloud Run TZ
variable / revision history) is a gcloud check documented in the plan.
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request
from datetime import datetime
from typing import Any

PORTAL_TABLES = (
    "performances", "schedules", "announcements", "events", "members", "auth_devices", "access_logs", "absences",
    "event_responses", "date_adjustments", "date_adjustment_responses", "piece_infos", "practice_instructions",
    "performance_day_infos", "payments", "castings", "desired_pieces", "albums", "album_photos",
    "concert_record_videos", "part_settings", "venue_settings", "flyer_distributions",
    "flyer_distribution_assignments", "org_settings", "sns_settings", "connection_settings", "drive_files",
    "recording_metadata", "desired_piece_votes",
)


def _scalar(conn: Any, sql: str, params: tuple[Any, ...] = ()) -> Any:
    return conn.execute(sql, params).fetchone()[0]


def _exists(conn: Any, table: str) -> bool:
    return bool(_scalar(conn, "SELECT to_regclass(%s) IS NOT NULL", (f"public.{table}",)))


def audit(conn: Any, organization: str | None, health_url: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    out["Q01_session_timezone"] = _scalar(conn, "SHOW TimeZone")
    rows = conn.execute(
        "SELECT COALESCE(d.datname, '*'), COALESCE(r.rolname, '*'), s.setconfig FROM pg_db_role_setting s "
        "LEFT JOIN pg_database d ON d.oid = s.setdatabase LEFT JOIN pg_roles r ON r.oid = s.setrole"
    ).fetchall()
    # Only TimeZone entries are reported (other settings may be sensitive).
    out["Q02_db_role_timezone_settings"] = [
        {"database": db, "role": role, "timezone": setting.split("=", 1)[1]}
        for db, role, config in rows for setting in (config or []) if setting.lower().startswith("timezone=")
    ]
    out["Q03_timestamp_columns"] = [
        {"table": t, "column": c, "type": d, "precision": p}
        for t, c, d, p in conn.execute(
            "SELECT table_name, column_name, data_type, datetime_precision FROM information_schema.columns "
            "WHERE table_schema='public' AND data_type LIKE 'timestamp%' ORDER BY 1, 2"
        ).fetchall()
    ]
    org_filter = " WHERE organization_id = %s" if organization else ""
    org_params: tuple[Any, ...] = (organization,) if organization else ()
    if _exists(conn, "events"):
        row = conn.execute(
            "SELECT count(*), count(*) FILTER (WHERE deadline IS NULL), "
            "count(*) FILTER (WHERE deadline = (date_trunc('day', deadline AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')), "
            "count(*) FILTER (WHERE deadline = (date_trunc('day', deadline AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo')) "
            f"FROM events{org_filter}", org_params
        ).fetchone()
        # UTC 00:00 and JST 00:00 are disjoint sets; "other" is neither (unknown encoding).
        out["Q04_events_deadline"] = {"total": row[0], "null": row[1], "utc_midnight": row[2], "jst_midnight": row[3],
                                      "other": row[0] - row[1] - row[2] - row[3]}
    q05 = {}
    for table in PORTAL_TABLES:
        if not _exists(conn, table):
            continue
        row = conn.execute(
            "SELECT count(*) FILTER (WHERE updated_at > clock_timestamp() + interval '5 seconds'), "
            "count(*) FILTER (WHERE updated_at > clock_timestamp() + interval '8 hours'), "
            f"count(*) FILTER (WHERE created_at > updated_at) FROM {table}{org_filter}", org_params
        ).fetchone()
        if any(row):
            q05[table] = {"future_over_5s": row[0], "future_over_8h": row[1], "created_after_updated": row[2]}
    out["Q05_future_or_reversed"] = q05
    if _exists(conn, "access_logs"):
        out["Q06_access_logs_jst_hour_histogram"] = {
            int(hour): count for hour, count in conn.execute(
                "SELECT extract(hour from accessed_at AT TIME ZONE 'Asia/Tokyo')::int, count(*) "
                f"FROM access_logs{org_filter} GROUP BY 1 ORDER BY 1", org_params
            ).fetchall()
        }
    if health_url:
        with urllib.request.urlopen(health_url.rstrip("/") + "/api/health", timeout=15) as response:
            app_time = json.load(response).get("timestamp")
        db_time = _scalar(conn, "SELECT clock_timestamp()")
        out["Q07_app_minus_db_seconds"] = (datetime.fromisoformat(str(app_time)).timestamp() - db_time.timestamp()) if app_time else None
    if _exists(conn, "album_photos"):
        out["Q09_album_photo_prefix_mismatch"] = _scalar(
            conn, "SELECT count(*) FROM album_photos WHERE COALESCE(object_name,'') <> '' "
            "AND object_name NOT LIKE 'albums/' || album_id || '/%%'"
            + (" AND organization_id = %s" if organization else ""), org_params
        )
    if _exists(conn, "desired_pieces"):
        out["Q10_desired_pieces_with_reference_url"] = _scalar(
            conn, f"SELECT count(*) FROM desired_pieces{org_filter}" + (" AND" if organization else " WHERE") + " COALESCE(reference_score_url,'') <> ''", org_params
        )
    q11 = {}
    for table, column in (("members", "photo_url"), ("performances", "flyer_image"), ("org_settings", "icon_url")):
        if _exists(conn, table):
            row = conn.execute(
                f"SELECT count(*) FILTER (WHERE {column} LIKE 'data:%%'), count(*) FILTER (WHERE {column} LIKE '%%?ext=%%' AND {column} NOT LIKE '%%asset=%%'), "
                f"count(*) FILTER (WHERE {column} LIKE '%%asset=%%'), count(*) FILTER (WHERE COALESCE({column},'') = '') FROM {table}{org_filter}",
                org_params,
            ).fetchone()
            q11[table] = {"data_url": row[0], "legacy_fixed_name": row[1], "asset_url": row[2], "empty": row[3]}
    out["Q11_image_reference_patterns"] = q11
    q12 = {}
    for table in PORTAL_TABLES:
        if _exists(conn, table):
            q12[table] = {org: count for org, count in conn.execute(f"SELECT organization_id, count(*) FROM {table} GROUP BY 1").fetchall()}
    out["Q12_tenant_distribution"] = q12
    q13 = {}
    for owners in ("tuner_owners", "metronome_owners"):
        if _exists(conn, owners) and _exists(conn, "members"):
            q13[owners] = _scalar(
                conn, f"SELECT count(*) FROM {owners} o JOIN members m ON m.organization_id = o.organization_id AND m.id = o.member_id "
                "WHERE o.revoked_at IS NULL AND o.member_birth <> m.created_at"
            )
    out["Q13_owner_birth_mismatch"] = q13
    if _exists(conn, "auth_devices"):
        out["Q14_authenticated_after_last_seen"] = _scalar(conn, f"SELECT count(*) FROM auth_devices{org_filter}" + (" AND" if organization else " WHERE") + " authenticated_at > last_seen_at", org_params)
    if _exists(conn, "members"):
        out["Q15_members_created_at_null"] = _scalar(conn, "SELECT count(*) FROM members WHERE created_at IS NULL")
    q16 = {}
    for table in PORTAL_TABLES:
        if not _exists(conn, table):
            continue
        max_id = _scalar(conn, f"SELECT COALESCE(MAX(id), 0) FROM {table}") if _scalar(conn, "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name=%s AND column_name='id'", (table,)) else None
        sequence = _scalar(conn, "SELECT pg_get_serial_sequence(%s, 'id')", (table,)) if max_id is not None else None
        last_value = _scalar(conn, f"SELECT last_value FROM {sequence}") if sequence else None
        q16[table] = {"max_id": max_id, "sequence_last_value": last_value}
    out["Q16_id_vs_sequence"] = q16
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--organization", help="limit row counts to one tenant")
    parser.add_argument("--health-url", help="deployed app URL for Q07")
    args = parser.parse_args(argv)
    dsn = os.environ.get("DB_URL", "").strip()
    if not dsn:
        raise SystemExit("Set DB_URL (read-only role recommended)")
    import psycopg

    started = time.time()
    with psycopg.connect(dsn, autocommit=False, connect_timeout=10) as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        conn.execute("SET LOCAL statement_timeout = '30s'")
        result = audit(conn, args.organization, args.health_url)
        conn.rollback()
    result["elapsed_seconds"] = round(time.time() - started, 2)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
