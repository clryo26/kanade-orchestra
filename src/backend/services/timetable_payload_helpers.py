from __future__ import annotations

import io
import re
from datetime import datetime, time
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException


def normalize_bool_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return "true"
    if text in {"0", "false", "no", "off"}:
        return "false"
    return ""


def candidate_sort_key(candidate: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(candidate.get("date") or ""),
        str(candidate.get("start_time") or ""),
        str(candidate.get("end_time") or ""),
    )


def validate_date_adjustment_payload(payload: dict[str, Any]) -> dict[str, Any]:
    title = str(payload.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")

    raw_candidates = payload.get("candidates")
    if not isinstance(raw_candidates, list) or not raw_candidates:
        raise HTTPException(status_code=400, detail="candidates is required")

    normalized_candidates: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str, str]] = set()
    for index, item in enumerate(raw_candidates):
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail=f"candidates[{index}] must be object")
        date = str(item.get("date") or "").strip()
        start_time = str(item.get("start_time") or "").strip()
        end_time = str(item.get("end_time") or "").strip()
        note = str(item.get("note") or "").strip()
        if not date:
            raise HTTPException(status_code=400, detail=f"candidates[{index}].date is required")
        candidate_id = str(item.get("id") or f"cand-{index + 1}").strip()
        normalized = {
            "id": candidate_id,
            "date": date,
            "start_time": start_time,
            "end_time": end_time,
            "note": note,
        }
        key = candidate_sort_key(normalized)
        if key in seen_keys:
            raise HTTPException(status_code=400, detail="duplicate candidates are not allowed")
        seen_keys.add(key)
        normalized_candidates.append(normalized)

    data = dict(payload)
    data["title"] = title
    data["deadline"] = str(payload.get("deadline") or "").strip()
    data["notes"] = str(payload.get("notes") or "").strip()
    data["delete_phrase"] = str(payload.get("delete_phrase") or "").strip()
    data["created_by"] = str(payload.get("created_by") or "").strip()
    data["member_id"] = payload.get("member_id")
    data["candidates"] = normalized_candidates
    return data


def validate_date_adjustment_response_payload(payload: dict[str, Any]) -> dict[str, Any]:
    adjustment_id = payload.get("adjustment_id")
    candidate_id = str(payload.get("candidate_id") or "").strip()
    name = str(payload.get("name") or "").strip()
    status = str(payload.get("status") or "").strip().lower()
    if adjustment_id in {None, ""}:
        raise HTTPException(status_code=400, detail="adjustment_id is required")
    if not candidate_id:
        raise HTTPException(status_code=400, detail="candidate_id is required")
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if status not in {"ok", "maybe", "ng"}:
        raise HTTPException(status_code=400, detail="status must be one of ok/maybe/ng")

    data = dict(payload)
    data["candidate_id"] = candidate_id
    data["name"] = name
    data["status"] = status
    data["note"] = str(payload.get("note") or "").strip()
    return data


def validate_connection_settings_payload(payload: dict[str, Any]) -> dict[str, Any]:
    data = dict(payload)
    data["google_project_id"] = str(payload.get("google_project_id") or "").strip()
    data["google_cloud_storage_bucket"] = str(payload.get("google_cloud_storage_bucket") or "").strip()
    data["google_cloud_storage_data_prefix"] = str(payload.get("google_cloud_storage_data_prefix") or "").strip()
    data["google_cloud_storage_public"] = normalize_bool_text(payload.get("google_cloud_storage_public"))
    data["google_service_account_file"] = str(payload.get("google_service_account_file") or "").strip()
    data["google_service_account_json"] = str(payload.get("google_service_account_json") or "").strip()
    return data


def normalize_extra_for_collection(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    if name == "date_adjustments":
        return validate_date_adjustment_payload(payload)
    if name == "date_adjustment_responses":
        return validate_date_adjustment_response_payload(payload)
    if name == "connection_settings":
        return validate_connection_settings_payload(payload)
    return payload


def normalize_clock_text(value: Any) -> str:
    match = re.match(r"^(\d{1,2}):(\d{2})$", str(value or "").strip())
    if not match:
        return ""
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return ""
    return f"{hour:02d}:{minute:02d}"


def add_minutes_to_clock_text(start: str, minutes: Any) -> str:
    normalized_start = normalize_clock_text(start)
    if not normalized_start:
        return ""
    try:
        add = int(str(minutes or "").strip())
    except ValueError:
        return ""
    hour, minute = [int(part) for part in normalized_start.split(":")]
    total = hour * 60 + minute + add
    normalized_total = total % (24 * 60)
    return f"{normalized_total // 60:02d}:{normalized_total % 60:02d}"


def performance_piece_labels(piece: Any) -> list[str]:
    if isinstance(piece, str):
        text = piece.strip()
        return [text] if text else []
    if not isinstance(piece, dict):
        return []
    composer = str(piece.get("composer") or "").strip()
    title = str(piece.get("title") or piece.get("name") or "").strip()
    alias = str(piece.get("alias") or piece.get("short_name") or "").strip()
    labels = [title, alias]
    if composer and title:
        labels.append(f"{composer}: {title}")
    return [label for label in labels if label]


def infer_duration_from_content(content: str, performance: dict[str, Any]) -> str:
    normalized_content = str(content or "").strip()
    if not normalized_content:
        return ""
    raw_pieces = performance.get("pieces")
    pieces: list[Any] = raw_pieces if isinstance(raw_pieces, list) else []
    for piece in pieces:
        if not isinstance(piece, dict):
            continue
        duration = str(piece.get("duration") or piece.get("duration_minutes") or "").strip()
        if not duration:
            continue
        labels = performance_piece_labels(piece)
        if any(label and label in normalized_content for label in labels):
            return duration
    return ""


def parse_timeline_text_rows(text: str, performance: dict[str, Any]) -> list[dict[str, Any]]:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        start_time = ""
        end_time = ""
        duration_minutes = ""
        content = line

        match = re.match(r"^(\d{1,2}:\d{2})\s*[-~～]\s*(\d{1,2}:\d{2})\s+(.+)$", line)
        if match:
            start_time = normalize_clock_text(match.group(1))
            end_time = normalize_clock_text(match.group(2))
            content = match.group(3).strip()
            if start_time and end_time:
                sh, sm = [int(part) for part in start_time.split(":")]
                eh, em = [int(part) for part in end_time.split(":")]
                diff = (eh * 60 + em) - (sh * 60 + sm)
                if diff < 0:
                    diff += 24 * 60
                duration_minutes = str(diff)
        else:
            match = re.match(r"^(\d{1,2}:\d{2})\s+(\d{1,3})\s*(?:分|蛻・)\s+(.+)$", line)
            if match:
                start_time = normalize_clock_text(match.group(1))
                duration_minutes = match.group(2).strip()
                content = match.group(3).strip()
                end_time = add_minutes_to_clock_text(start_time, duration_minutes)
            else:
                match = re.match(r"^(\d{1,2}:\d{2})\s+(.+)$", line)
                if match:
                    start_time = normalize_clock_text(match.group(1))
                    content = match.group(2).strip()
                    duration_minutes = infer_duration_from_content(content, performance)
                    end_time = add_minutes_to_clock_text(start_time, duration_minutes) if duration_minutes else ""

        rows.append(
            {
                "sort_order": index + 1,
                "start_time": start_time,
                "end_time": end_time,
                "duration_minutes": duration_minutes,
                "section": "",
                "content": content,
                "mc": "",
                "reception": "",
                "setting": "",
                "note": "",
                "source_line": line,
            }
        )
    return [row for row in rows if row.get("content") or row.get("start_time")]


def normalized_timeline_rows(info: dict[str, Any], performance: dict[str, Any]) -> list[dict[str, Any]]:
    timeline_rows = info.get("timeline_rows") if isinstance(info.get("timeline_rows"), list) else []
    if timeline_rows:
        rows: list[dict[str, Any]] = []
        for index, row in enumerate(timeline_rows):
            if not isinstance(row, dict):
                continue
            rows.append(
                {
                    "sort_order": int(row.get("sort_order") or index + 1),
                    "start_time": normalize_clock_text(row.get("start_time") or row.get("start") or ""),
                    "end_time": normalize_clock_text(row.get("end_time") or row.get("end") or ""),
                    "duration_minutes": str(row.get("duration_minutes") or row.get("duration") or "").strip(),
                    "section": str(row.get("section") or row.get("category") or "").strip(),
                    "content": str(row.get("content") or row.get("title") or "").strip(),
                    "mc": str(row.get("mc") or "").strip(),
                    "reception": str(row.get("reception") or row.get("desk") or "").strip(),
                    "setting": str(row.get("setting") or "").strip(),
                    "note": str(row.get("note") or "").strip(),
                }
            )
        return [row for row in rows if row.get("content") or row.get("start_time") or row.get("section")]
    return parse_timeline_text_rows(str(info.get("timeline") or info.get("timetable") or ""), performance)


def parse_assignment_rows(info: dict[str, Any]) -> list[dict[str, str]]:
    rows = info.get("assignments_rows") if isinstance(info.get("assignments_rows"), list) else []
    if rows:
        normalized: list[dict[str, str]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            role = str(row.get("role") or row.get("duty") or "").strip()
            members = str(row.get("members") or row.get("name") or "").strip()
            if role or members:
                normalized.append({"role": role, "members": members})
        return normalized

    text = str(info.get("assignments") or info.get("duties") or "")
    parsed: list[dict[str, str]] = []
    for line in [line.strip() for line in text.splitlines() if line.strip()]:
        parts = re.split(r"[:・咯", line, maxsplit=1)
        if len(parts) == 2:
            parsed.append({"role": parts[0].strip(), "members": parts[1].strip()})
        else:
            parsed.append({"role": "", "members": line})
    return parsed


def choose_assignment_value(rows: list[dict[str, str]], keywords: list[str]) -> str:
    for row in rows:
        role = str(row.get("role") or "").strip().lower()
        if role and any(keyword in role for keyword in keywords):
            return str(row.get("members") or "").strip()
    return ""


def compact_assignment_text(rows: list[dict[str, str]], excluded_keywords: list[str]) -> str:
    results: list[str] = []
    for row in rows:
        role = str(row.get("role") or "").strip()
        members = str(row.get("members") or "").strip()
        if role and any(keyword in role.lower() for keyword in excluded_keywords):
            continue
        if role and members:
            results.append(f"{role}: {members}")
        elif role:
            results.append(role)
        elif members:
            results.append(members)
    return " / ".join(results)


def clock_to_time(value: str) -> time | None:
    normalized = normalize_clock_text(value)
    if not normalized:
        return None
    hour, minute = [int(part) for part in normalized.split(":")]
    return time(hour=hour, minute=minute)


def excel_safe_filename(text: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|]", "_", str(text or "").strip())
    return cleaned or "performance_timetable"


def excel_row_count_from_template(ws: Any) -> int:
    if ws.merged_cells and ws.merged_cells.ranges:
        for merged in ws.merged_cells.ranges:
            if merged.min_col == 2 and merged.max_col == 2 and merged.min_row <= 4 and merged.max_row >= 4:
                return int(max(1, merged.max_row - 4 + 1))
    return 20


def set_sheet_value_if_writable(sheet: Any, cell_ref: str, value: Any) -> None:
    cell = sheet[cell_ref]
    if cell.__class__.__name__ == "MergedCell":
        return
    cell.value = value


def performance_day_info_for_performance(
    performance_id: int,
    load_json_data_func: Callable[[str], list[dict[str, Any]]],
) -> dict[str, Any] | None:
    rows = load_json_data_func("performance_day_infos")
    return next((item for item in rows if str(item.get("performance_id") or "") == str(performance_id)), None)


def build_timetable_workbook_bytes(
    performance: dict[str, Any],
    info: dict[str, Any],
    *,
    load_workbook_func: Any,
    template_path: Path,
) -> bytes:
    if load_workbook_func is None:
        raise HTTPException(status_code=500, detail="openpyxl is required for Excel export")
    if not template_path.exists():
        raise HTTPException(status_code=500, detail="Timetable template not found")

    workbook = load_workbook_func(template_path)
    sheet = workbook.active

    raw_date = str(performance.get("date") or "").strip()
    try:
        sheet["B4"] = datetime.fromisoformat(raw_date).date() if raw_date else ""
    except ValueError:
        sheet["B4"] = raw_date

    timeline_rows = sorted(
        normalized_timeline_rows(info, performance),
        key=lambda row: int(row.get("sort_order") or 0),
    )
    assignment_rows = parse_assignment_rows(info)
    default_mc = choose_assignment_value(assignment_rows, ["mc", "蜿ｸ莨・"])
    default_reception = choose_assignment_value(assignment_rows, ["蜿嶺ｻ・", "繝√こ繝・ヨ"])
    default_setting = choose_assignment_value(assignment_rows, ["セッティング", "設営", "舞台"])
    assignment_note = compact_assignment_text(
        assignment_rows,
        ["mc", "司会", "司会者", "チケット", "セッティング", "設営", "舞台"],
    )

    row_count = excel_row_count_from_template(sheet)
    base_row = 4
    for offset in range(row_count):
        row_no = base_row + offset
        row = timeline_rows[offset] if offset < len(timeline_rows) else {}

        start_time = clock_to_time(str(row.get("start_time") or ""))
        end_time = clock_to_time(str(row.get("end_time") or ""))
        duration_text = str(row.get("duration_minutes") or "").strip()

        set_sheet_value_if_writable(sheet, f"C{row_no}", start_time if start_time else "")
        set_sheet_value_if_writable(sheet, f"D{row_no}", end_time if end_time else "")
        set_sheet_value_if_writable(sheet, f"E{row_no}", int(duration_text) if duration_text.isdigit() else "")
        set_sheet_value_if_writable(sheet, f"F{row_no}", str(row.get("section") or "").strip())
        set_sheet_value_if_writable(sheet, f"G{row_no}", str(row.get("content") or "").strip())
        set_sheet_value_if_writable(sheet, f"H{row_no}", str(row.get("mc") or "").strip() or (default_mc if row_no == base_row else ""))
        set_sheet_value_if_writable(sheet, f"I{row_no}", str(row.get("reception") or "").strip() or (default_reception if row_no == base_row else ""))
        set_sheet_value_if_writable(sheet, f"J{row_no}", str(row.get("setting") or "").strip() or (default_setting if row_no == base_row else ""))
        note = str(row.get("note") or "").strip()
        set_sheet_value_if_writable(sheet, f"K{row_no}", note or (assignment_note if row_no == base_row else ""))

    buffer = io.BytesIO()
    workbook.save(buffer)
    buffer.seek(0)
    return buffer.getvalue()
