from __future__ import annotations

from scripts.migrate_json_to_postgres import InsertPlan, rows_with_audit_defaults


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
