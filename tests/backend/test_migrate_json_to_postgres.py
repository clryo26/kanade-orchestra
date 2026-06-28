from __future__ import annotations

from scripts.migrate_json_to_postgres import InsertPlan, build_plans, rows_with_audit_defaults


def test_rows_with_audit_defaults_fills_missing_performance_piece_timestamps():
    plan = InsertPlan(
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
        rows=[(1, 1, 1, "「名探偵コナン」メインテーマ", "コナン", "", False, None, None)],
    )

    rows = rows_with_audit_defaults(plan, "2026-06-27T00:00:00+00:00")

    assert rows[0][-2:] == ("2026-06-27T00:00:00+00:00", "2026-06-27T00:00:00+00:00")


def test_rows_with_audit_defaults_preserves_existing_timestamps():
    plan = InsertPlan(
        table="performance_pieces",
        columns=["id", "created_at", "updated_at"],
        rows=[(1, "2026-01-01T00:00:00", "2026-01-02T00:00:00")],
    )

    rows = rows_with_audit_defaults(plan, "2026-06-27T00:00:00+00:00")

    assert rows[0] == (1, "2026-01-01T00:00:00", "2026-01-02T00:00:00")


def test_build_plans_inserts_payments_before_payment_performance_fees():
    plans = build_plans(
        {
            "performances": [{"id": 10, "title": "Concert", "date": "2026-07-01", "pieces": []}],
            "payments": [
                {
                    "id": 1,
                    "member_id": None,
                    "name": "Member",
                    "performance_fees": {"10": True},
                    "performance_fee_amounts": {"10": "1500"},
                }
            ],
        }
    )

    table_order = [plan.table for plan in plans]
    payment_fee_plan = next(plan for plan in plans if plan.table == "payment_performance_fees")

    assert table_order.index("payments") < table_order.index("payment_performance_fees")
    assert payment_fee_plan.has_identity_id is False
