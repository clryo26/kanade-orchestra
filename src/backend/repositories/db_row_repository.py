from __future__ import annotations

import json
import re
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

from fastapi import HTTPException

try:
    from psycopg import sql as psql
    from psycopg.types.json import Jsonb
except Exception:  # pragma: no cover - optional dependency guard
    psql = None
    Jsonb = None

from ..core.db_schema import (
    DB_BOOL_COLUMNS,
    DB_CHILD_COLUMNS,
    DB_CHILD_TABLES,
    DB_COLLECTION_COLUMNS,
    DB_DATE_COLUMNS,
    DB_INT_COLUMNS,
    DB_JSON_COLUMNS,
    DB_MONTH_COLUMNS,
    DB_NUMERIC_COLUMNS,
    DB_TIME_COLUMNS,
    DB_TIMESTAMP_COLUMNS,
    PORTAL_DB_TABLES,
)
from ..core.tenant_context import get_current_tenant_id


_ORG_COLUMN_CACHE: dict[str, bool] = {}


def _list_or_empty(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _dict_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _core() -> None:
    # Backward-compat hook for tests that monkeypatch repository internals.
    return None


def table_has_organization_id(conn: Any, table_name: str) -> bool:
    if table_name in _ORG_COLUMN_CACHE:
        return _ORG_COLUMN_CACHE[table_name]
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = %s
              AND column_name = 'organization_id'
            """,
            (table_name,),
        )
        has_column = cur.fetchone() is not None
    _ORG_COLUMN_CACHE[table_name] = has_column
    return has_column


def db_json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return value


def db_row_to_json(row: dict[str, Any]) -> dict[str, Any]:
    data = {key: db_json_value(value) for key, value in row.items()}
    if "sort_order" in data and "display_order" not in data:
        data["display_order"] = data["sort_order"]
    if "organization_name" in data and not data.get("name"):
        data["name"] = data["organization_name"]
    if "organization_abbreviation" in data and not data.get("short_name"):
        data["short_name"] = data["organization_abbreviation"]
    if "candidate_key" in data and not data.get("candidate_id"):
        data["candidate_id"] = data["candidate_key"]
    return data


def parse_db_date(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    value_text = str(value).strip().replace("/", "-").replace(".", "-")
    if "T" in value_text:
        value_text = value_text.split("T", 1)[0]
    elif " " in value_text:
        value_text = value_text.split(" ", 1)[0]
    if re.fullmatch(r"\d{4}-\d{2}", value_text):
        value_text = f"{value_text}-01"
    try:
        return date.fromisoformat(value_text).isoformat()
    except ValueError:
        return None


def parse_db_time(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.time().replace(microsecond=0).isoformat(timespec="minutes")
    if isinstance(value, time):
        return value.replace(microsecond=0).isoformat(timespec="minutes")
    value_text = str(value).strip()
    if "T" in value_text:
        value_text = value_text.split("T", 1)[1]
    value_text = value_text.split("+", 1)[0].split("Z", 1)[0]
    match = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", value_text)
    if not match:
        return None
    hour, minute, second = match.groups()
    try:
        return time(int(hour), int(minute), int(second or "0")).isoformat(timespec="minutes")
    except ValueError:
        return None


def parse_db_timestamp(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return datetime.combine(value, time.min).isoformat()
    value_text = str(value).strip().replace("/", "-").replace("Z", "+00:00")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value_text):
        value_text = f"{value_text}T00:00:00+00:00"
    try:
        return datetime.fromisoformat(value_text).isoformat()
    except ValueError:
        return None


def parse_db_month(value: Any) -> str:
    value_text = str(value or "").strip().replace("/", "-").replace(".", "-")
    if re.fullmatch(r"\d{4}-\d{2}", value_text):
        return value_text
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value_text):
        return value_text[:7]
    return ""


def db_write_value(table_name: str, column: str, value: Any) -> Any:
    if column in DB_INT_COLUMNS.get(table_name, set()):
        if value in (None, ""):
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    if column in DB_BOOL_COLUMNS.get(table_name, set()):
        if isinstance(value, bool):
            return value
        value_text = str(value or "").strip().lower()
        if value_text in {"1", "true", "yes", "on"}:
            return True
        if value_text in {"0", "false", "no", "off"}:
            return False
        return None
    if column in DB_NUMERIC_COLUMNS.get(table_name, set()):
        if value in (None, ""):
            return Decimal("0")
        try:
            return Decimal(str(value))
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid numeric value for {table_name}.{column}",
            ) from exc
    if column in DB_DATE_COLUMNS.get(table_name, set()):
        return parse_db_date(value)
    if column in DB_TIME_COLUMNS.get(table_name, set()):
        return parse_db_time(value)
    if column in DB_TIMESTAMP_COLUMNS.get(table_name, set()):
        return parse_db_timestamp(value)
    if column in DB_MONTH_COLUMNS.get(table_name, set()):
        return parse_db_month(value)
    if column in DB_JSON_COLUMNS.get(table_name, set()):
        json_value: Any
        if table_name == "performance_day_infos" and column == "costume_detail":
            json_value = value if isinstance(value, dict) else {}
        else:
            json_value = value if isinstance(value, (list, dict)) else []
        return Jsonb(json_value) if Jsonb is not None else json.dumps(json_value, ensure_ascii=False)
    return value


def db_fetch_all(conn: Any, table_name: str, *, order_by: str = "id") -> list[dict[str, Any]]:
    if table_name not in PORTAL_DB_TABLES:
        raise HTTPException(status_code=400, detail=f"Unsupported DB table: {table_name}")
    order_sql = psql.SQL(" ORDER BY {}").format(psql.Identifier(order_by)) if order_by else psql.SQL("")
    tenant_id = get_current_tenant_id()
    has_org_column = table_has_organization_id(conn, table_name)
    if has_org_column:
        query = psql.SQL("SELECT * FROM {} WHERE organization_id = %s{}").format(psql.Identifier(table_name), order_sql)
        params: tuple[Any, ...] = (tenant_id,)
    else:
        query = psql.SQL("SELECT * FROM {}{}").format(psql.Identifier(table_name), order_sql)
        params = ()
    with conn.cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
        columns = [desc[0] for desc in cur.description]
    return [db_row_to_json(dict(zip(columns, row))) for row in rows]


def db_item_value(table_name: str, item: dict[str, Any], column: str) -> Any:
    if column == "organization_id":
        return str(item.get("organization_id") or get_current_tenant_id())
    if column == "sort_order":
        return item.get("sort_order", item.get("display_order"))
    if column == "candidate_key":
        return item.get("candidate_key", item.get("candidate_id", item.get("id")))
    if column == "summary":
        return item.get("summary", item.get("description"))
    if column == "icon_url":
        return item.get("icon_url", item.get("logo_url"))
    if column == "organization_name":
        return item.get("organization_name", item.get("organization_name_full", item.get("name")))
    if column == "organization_abbreviation":
        return item.get("organization_abbreviation", item.get("short_name", item.get("shortName")))
    if table_name == "org_settings" and column == "membership_fee_amount":
        return item.get("membership_fee_amount", 0)
    if column == "paid_until_month":
        return item.get("paid_until_month", item.get("membership_fee", item.get("dues")))
    return item.get(column)


def db_row_tuple(table_name: str, columns: tuple[str, ...], item: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(db_write_value(table_name, column, db_item_value(table_name, item, column)) for column in columns)


def db_prepare_timestamp_columns_for_upsert(table_name: str, rows: list[dict[str, Any]]) -> None:
    columns = DB_COLLECTION_COLUMNS.get(table_name) or DB_CHILD_COLUMNS.get(table_name, ())
    if "created_at" not in columns and "updated_at" not in columns:
        return
    now = datetime.now().isoformat()
    for row in rows:
        # Inserts need a non-null created_at, while ON CONFLICT keeps the
        # existing created_at because db_upsert_rows excludes it from updates.
        if "created_at" in columns and not row.get("created_at"):
            row["created_at"] = now
        if "updated_at" in columns and not row.get("updated_at"):
            row["updated_at"] = now


def db_collection_rows_for_save(name: str, data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if name != "drive_files":
        return data

    now = datetime.now().isoformat()
    rows: list[dict[str, Any]] = []
    for item in data:
        row = dict(item)
        object_name = str(row.get("object_name") or row.get("id") or row.get("path") or "").strip()
        if object_name:
            row["object_name"] = object_name
        if db_write_value("drive_files", "id", row.get("id")) is None:
            row.pop("id", None)
        row["created_at"] = row.get("created_at") or now
        row["updated_at"] = row.get("updated_at") or row["created_at"]
        rows.append(row)
    return rows


def db_upsert_rows(cur: Any, table_name: str, columns: tuple[str, ...], rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    assignments = psql.SQL(", ").join(
        psql.SQL("{} = EXCLUDED.{}").format(psql.Identifier(column), psql.Identifier(column))
        for column in columns
        if column not in {"id", "created_at"}
    )
    insert_query = psql.SQL("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT (id) DO UPDATE SET {}").format(
        psql.Identifier(table_name),
        psql.SQL(", ").join(psql.Identifier(column) for column in columns),
        psql.SQL(", ").join(psql.Placeholder() for _ in columns),
        assignments,
    )
    cur.executemany(insert_query, [db_row_tuple(table_name, columns, row) for row in rows])


def db_insert_rows(cur: Any, table_name: str, columns: tuple[str, ...], rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    insert_query = psql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        psql.Identifier(table_name),
        psql.SQL(", ").join(psql.Identifier(column) for column in columns),
        psql.SQL(", ").join(psql.Placeholder() for _ in columns),
    )
    cur.executemany(insert_query, [db_row_tuple(table_name, columns, row) for row in rows])


def db_next_id(cur: Any, table_name: str) -> int:
    cur.execute("SELECT pg_get_serial_sequence(%s, 'id')", (table_name,))
    sequence_row = cur.fetchone()
    sequence_name = sequence_row[0] if sequence_row else None
    if sequence_name:
        cur.execute("SELECT nextval(%s)", (sequence_name,))
        return int(cur.fetchone()[0])

    # Fallback for legacy tables without a sequence on id.
    # Advisory lock prevents MAX(id)+1 races under concurrent writes.
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"{table_name}:id",))
    cur.execute(psql.SQL("SELECT COALESCE(MAX(id), 0) FROM {}").format(psql.Identifier(table_name)))
    return int(cur.fetchone()[0]) + 1


def db_fill_missing_ids(cur: Any, table_name: str, rows: list[dict[str, Any]]) -> None:
    columns = DB_COLLECTION_COLUMNS.get(table_name) or DB_CHILD_COLUMNS.get(table_name, ())
    if "id" not in columns:
        return
    missing_rows = [row for row in rows if row.get("id") in (None, "")]
    if not missing_rows:
        return

    cur.execute("SELECT pg_get_serial_sequence(%s, 'id')", (table_name,))
    sequence_row = cur.fetchone()
    sequence_name = sequence_row[0] if sequence_row else None

    if sequence_name:
        for row in missing_rows:
            cur.execute("SELECT nextval(%s)", (sequence_name,))
            row["id"] = int(cur.fetchone()[0])
        return

    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"{table_name}:id",))
    cur.execute(psql.SQL("SELECT COALESCE(MAX(id), 0) FROM {}").format(psql.Identifier(table_name)))
    next_value = int(cur.fetchone()[0]) + 1
    for row in missing_rows:
        row["id"] = next_value
        next_value += 1


def db_delete_collection_children(cur: Any, name: str) -> None:
    conn = cur.connection
    tenant_id = get_current_tenant_id()
    for child_table in DB_CHILD_TABLES.get(name, ()):
        if table_has_organization_id(conn, child_table):
            cur.execute(psql.SQL("DELETE FROM {} WHERE organization_id = %s").format(psql.Identifier(child_table)), (tenant_id,))
            continue
        cur.execute(psql.SQL("DELETE FROM {}").format(psql.Identifier(child_table)))


def db_child_rows_for_collection(name: str, data: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    now = datetime.now().isoformat()
    tenant_id = get_current_tenant_id()
    children: dict[str, list[dict[str, Any]]] = {table: [] for table in DB_CHILD_TABLES.get(name, ())}
    if name == "performances":
        for parent in data:
            parent_id = parent.get("id")
            pieces = _list_or_empty(parent.get("pieces"))
            for index, piece in enumerate(pieces):
                if isinstance(piece, dict):
                    title = str(piece.get("title") or "").strip()
                    if not title:
                        continue
                    children["performance_pieces"].append(
                        {
                            "organization_id": piece.get("organization_id") or parent.get("organization_id") or tenant_id,
                            # Child rows are fully replaced on save. Let the DB layer allocate
                            # fresh IDs so updates cannot collide with another organization's rows.
                            "id": None,
                            "performance_id": parent_id,
                            "sort_order": piece.get("sort_order", index + 1),
                            "title": title,
                            "alias": piece.get("alias") or piece.get("short_name") or "",
                            "part": piece.get("part") or piece.get("section") or "",
                            "composer": piece.get("composer") or "",
                            "duration": piece.get("duration") or "",
                            "is_encore": piece.get("is_encore", piece.get("encore", False)),
                            "created_at": piece.get("created_at") or parent.get("created_at") or now,
                            "updated_at": piece.get("updated_at") or parent.get("updated_at") or now,
                        }
                    )
                else:
                    title = str(piece or "").strip()
                    if title:
                        children["performance_pieces"].append(
                            {
                                "organization_id": parent.get("organization_id") or tenant_id,
                                "performance_id": parent_id,
                                "sort_order": index + 1,
                                "title": title,
                                "alias": "",
                                "part": "",
                                "composer": "",
                                "duration": "",
                                "is_encore": False,
                                "created_at": parent.get("created_at") or now,
                                "updated_at": parent.get("updated_at") or now,
                            }
                        )
    elif name == "date_adjustments":
        for parent in data:
            parent_id = parent.get("id")
            candidates = _list_or_empty(parent.get("candidates"))
            for index, candidate in enumerate(candidates):
                if not isinstance(candidate, dict):
                    continue
                children["date_adjustment_candidates"].append(
                    {
                        "organization_id": candidate.get("organization_id") or parent.get("organization_id") or tenant_id,
                        "id": candidate.get("db_id") if candidate.get("db_id") else None,
                        "adjustment_id": parent_id,
                        "candidate_key": candidate.get("candidate_key") or candidate.get("id") or f"cand-{index + 1}",
                        "date": candidate.get("date"),
                        "start_time": candidate.get("start_time"),
                        "end_time": candidate.get("end_time"),
                        "note": candidate.get("note") or "",
                        "sort_order": index,
                        "created_at": candidate.get("created_at") or parent.get("created_at") or now,
                        "updated_at": candidate.get("updated_at") or parent.get("updated_at") or now,
                    }
                )
    elif name == "payments":
        for parent in data:
            parent_id = parent.get("id")
            fee_map = _dict_or_empty(parent.get("performance_fees"))
            amount_map = _dict_or_empty(parent.get("performance_fee_amounts"))
            for performance_id in set(fee_map.keys()) | set(amount_map.keys()):
                children["payment_performance_fees"].append(
                    {
                        "organization_id": parent.get("organization_id") or tenant_id,
                        "payment_id": parent_id,
                        "performance_id": performance_id,
                        "is_paid": fee_map.get(performance_id, False),
                        "fee_amount": amount_map.get(performance_id, 0),
                        "created_at": parent.get("created_at") or now,
                        "updated_at": parent.get("updated_at") or now,
                    }
                )
    elif name == "castings":
        for parent in data:
            parent_id = parent.get("id")
            members = _list_or_empty(parent.get("members"))
            for index, member in enumerate(members):
                if isinstance(member, dict):
                    children["casting_members"].append(
                        {
                            "organization_id": member.get("organization_id") or parent.get("organization_id") or tenant_id,
                            "id": None,
                            "casting_id": parent_id,
                            "member_id": member.get("member_id"),
                            "part": member.get("part") or "",
                            "sort_order": index,
                            "created_at": member.get("created_at") or parent.get("created_at") or now,
                            "updated_at": member.get("updated_at") or parent.get("updated_at") or now,
                        }
                    )
            extras = _list_or_empty(parent.get("extras"))
            for index, extra in enumerate(extras):
                if isinstance(extra, dict):
                    children["casting_extras"].append(
                        {
                            "organization_id": extra.get("organization_id") or parent.get("organization_id") or tenant_id,
                            "id": None,
                            "casting_id": parent_id,
                            "name": extra.get("name") or "",
                            "furigana": extra.get("furigana") or "",
                            "part": extra.get("part") or "",
                            "sort_order": index,
                            "created_at": extra.get("created_at") or parent.get("created_at") or now,
                            "updated_at": extra.get("updated_at") or parent.get("updated_at") or now,
                        }
                    )
    elif name == "desired_pieces":
        for parent in data:
            parent_id = parent.get("id")
            votes = _list_or_empty(parent.get("votes"))
            for vote in votes:
                if isinstance(vote, dict):
                    row = {
                        "organization_id": vote.get("organization_id") or parent.get("organization_id") or tenant_id,
                        "id": None,
                        "desired_piece_id": parent_id,
                        "member_id": vote.get("member_id"),
                        "name": vote.get("name") or "",
                        "voted_at": vote.get("voted_at") or now,
                        "created_at": vote.get("created_at") or parent.get("created_at") or now,
                        "updated_at": vote.get("updated_at") or parent.get("updated_at") or now,
                    }
                else:
                    row = {
                        "organization_id": parent.get("organization_id") or tenant_id,
                        "desired_piece_id": parent_id,
                        "member_id": None,
                        "name": str(vote or ""),
                        "voted_at": now,
                        "created_at": parent.get("created_at") or now,
                        "updated_at": parent.get("updated_at") or now,
                    }
                children["desired_piece_votes"].append(row)
    elif name == "albums":
        for parent in data:
            parent_id = parent.get("id")
            photos = _list_or_empty(parent.get("photos"))
            for photo in photos:
                if isinstance(photo, dict):
                    children["album_photos"].append(
                        {
                            "organization_id": photo.get("organization_id") or parent.get("organization_id") or tenant_id,
                            "id": photo.get("id"),
                            "album_id": parent_id,
                            "filename": photo.get("filename") or "",
                            "url": photo.get("url") or "",
                            "object_name": photo.get("object_name") or "",
                            "path": photo.get("path") or "",
                            "uploaded_by_member_id": photo.get("uploaded_by_member_id"),
                            "uploaded_by_member_name": photo.get("uploaded_by_member_name") or "",
                            "uploaded_at": photo.get("uploaded_at"),
                            "created_at": photo.get("created_at") or parent.get("created_at") or now,
                            "updated_at": photo.get("updated_at") or parent.get("updated_at") or now,
                        }
                    )
    return children
