from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass
class InsertPlan:
    table: str
    columns: list[str]
    rows: list[tuple[Any, ...]]
    has_identity_id: bool = True


def _coerce_year_month(value: Any) -> str:
    text = str(value or "").strip().replace("/", "-")
    if len(text) == 6 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}"
    if len(text) == 7 and text[4] == "-":
        return text
    return ""


def _coerce_date(value: Any) -> str | None:
    text = str(value or "").strip().replace("/", "-")
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y%m%d", "%Y%m"):
        try:
            parsed = datetime.strptime(text, fmt)
            if fmt in {"%Y-%m", "%Y%m"}:
                return parsed.strftime("%Y-%m-01")
            return parsed.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _coerce_time(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            parsed = datetime.strptime(text, fmt)
            return parsed.strftime("%H:%M:%S")
        except ValueError:
            continue
    return None


def _coerce_timestamp(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text).isoformat()
    except ValueError:
        return None


def rows_with_audit_defaults(plan: InsertPlan, now_iso: str) -> list[tuple[Any, ...]]:
    col_idx = {name: idx for idx, name in enumerate(plan.columns)}
    created_idx = col_idx.get("created_at")
    updated_idx = col_idx.get("updated_at")
    rows: list[tuple[Any, ...]] = []

    for row in plan.rows:
        values = list(row)
        if created_idx is not None and not values[created_idx]:
            values[created_idx] = now_iso
        if updated_idx is not None and not values[updated_idx]:
            values[updated_idx] = now_iso
        rows.append(tuple(values))
    return rows


def rows_with_temporal_normalization(
    plan: InsertPlan,
    rows: list[tuple[Any, ...]],
    now_iso: str,
) -> list[tuple[Any, ...]]:
    col_idx = {name: idx for idx, name in enumerate(plan.columns)}
    out_rows: list[tuple[Any, ...]] = []
    now_date = now_iso[:10]

    for row in rows:
        values = list(row)

        if plan.table == "members":
            joined_idx = col_idx.get("joined_at")
            access_until_idx = col_idx.get("system_access_until")
            if joined_idx is not None:
                joined_date = _coerce_date(values[joined_idx])
                values[joined_idx] = joined_date
            if access_until_idx is not None:
                values[access_until_idx] = _coerce_date(values[access_until_idx])

        if plan.table == "desired_piece_votes":
            for key in ("voted_at", "created_at", "updated_at"):
                idx = col_idx.get(key)
                if idx is not None:
                    values[idx] = _coerce_timestamp(values[idx]) or now_iso

        if plan.table == "payments":
            from_idx = col_idx.get("paid_from_month")
            until_idx = col_idx.get("paid_until_month")
            latest_idx = col_idx.get("latest_payment_date")
            if from_idx is not None:
                values[from_idx] = _coerce_year_month(values[from_idx])
            if until_idx is not None:
                values[until_idx] = _coerce_year_month(values[until_idx])
            if latest_idx is not None:
                values[latest_idx] = _coerce_date(values[latest_idx])

        if plan.table == "date_adjustment_candidates":
            date_idx = col_idx.get("date")
            start_idx = col_idx.get("start_time")
            end_idx = col_idx.get("end_time")
            if date_idx is not None:
                values[date_idx] = _coerce_date(values[date_idx]) or now_date
            if start_idx is not None:
                values[start_idx] = _coerce_time(values[start_idx])
            if end_idx is not None:
                values[end_idx] = _coerce_time(values[end_idx])

        out_rows.append(tuple(values))

    return out_rows


def build_plans(data: dict[str, list[dict[str, Any]]]) -> list[InsertPlan]:
    plans: list[InsertPlan] = []

    performances = data.get("performances") or []
    if performances:
        plans.append(
            InsertPlan(
                table="performances",
                columns=["id", "title", "date"],
                rows=[
                    (
                        item.get("id"),
                        item.get("title"),
                        item.get("date"),
                    )
                    for item in performances
                ],
            )
        )

    payments = data.get("payments") or []
    if payments:
        plans.append(
            InsertPlan(
                table="payments",
                columns=["id", "member_id", "name"],
                rows=[
                    (
                        item.get("id"),
                        item.get("member_id"),
                        item.get("name"),
                    )
                    for item in payments
                ],
            )
        )

        fee_rows: list[tuple[Any, ...]] = []
        for item in payments:
            payment_id = item.get("id")
            performance_fees = item.get("performance_fees") or {}
            performance_fee_amounts = item.get("performance_fee_amounts") or {}
            for perf_id, enabled in performance_fees.items():
                if not enabled:
                    continue
                fee_rows.append(
                    (
                        payment_id,
                        int(perf_id),
                        str(performance_fee_amounts.get(perf_id) or ""),
                    )
                )

        if fee_rows:
            plans.append(
                InsertPlan(
                    table="payment_performance_fees",
                    columns=["payment_id", "performance_id", "amount"],
                    rows=fee_rows,
                    has_identity_id=False,
                )
            )

    return plans
