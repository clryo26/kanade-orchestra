from __future__ import annotations


def test_part_settings_db_rows_keep_frontend_display_order(backend_env):
    row = backend_env.db_row_to_json({"id": 1, "name": "Violin", "sort_order": 20, "is_active": True})

    assert row["display_order"] == 20


def test_part_settings_save_uses_db_when_database_is_enabled(backend_env, monkeypatch):
    saved: dict[str, list[dict]] = {}
    data = [{"id": 1, "name": "Violin", "display_order": 20, "is_active": True}]

    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_replace_collection", lambda name, rows: saved.setdefault(name, rows))

    backend_env.save_json_data("part_settings", data)

    assert saved == {"part_settings": data}
    assert backend_env.load_json_data("part_settings") == data


def test_db_write_values_accept_month_and_display_order_alias(backend_env):
    part_row = backend_env.db_row_tuple(
        "part_settings",
        backend_env.DB_COLLECTION_COLUMNS["part_settings"],
        {"id": "1", "name": "Violin", "display_order": "20", "is_active": "true"},
    )
    payment_row = backend_env.db_row_tuple(
        "payments",
        backend_env.DB_COLLECTION_COLUMNS["payments"],
        {"id": "1", "member_id": "2", "paid_until_month": "2022-09", "latest_payment_date": "2022-09"},
    )

    assert part_row[2] == 20
    assert part_row[3] is True
    assert payment_row[3] == ""
    assert payment_row[4] == "2022-09"
    assert payment_row[5] == "2022-09-01"


def test_payment_child_rows_are_built_for_db_foreign_keys(backend_env):
    rows = backend_env.db_child_rows_for_collection(
        "payments",
        [
            {
                "id": 1,
                "performance_fees": {"10": True},
                "performance_fee_amounts": {"10": "1500"},
            }
        ],
    )
    db_row = backend_env.db_row_tuple(
        "payment_performance_fees",
        backend_env.DB_CHILD_COLUMNS["payment_performance_fees"],
        rows["payment_performance_fees"][0],
    )

    assert db_row[:4] == (1, 10, True, backend_env.Decimal("1500"))


def test_org_settings_accept_frontend_payload_without_membership_fee(backend_env):
    row = backend_env.db_row_tuple(
        "org_settings",
        backend_env.DB_COLLECTION_COLUMNS["org_settings"],
        {"id": "1", "name": "Kanade Orchestra", "short_name": "Kanade", "icon_url": "data:image/png;base64,x"},
    )

    assert row[1] == "Kanade Orchestra"
    assert row[2] == "Kanade"
    assert row[3] == "Kanade"
    assert row[4] == "data:image/png;base64,x"
    assert row[5] == backend_env.Decimal("0")


def test_db_rows_fill_json_compatibility_keys(backend_env):
    row = backend_env.db_row_to_json(
        {
            "id": 1,
            "organization_name": "Kanade Orchestra",
            "organization_abbreviation": "Kanade",
            "membership_fee_amount": backend_env.Decimal("1000"),
        }
    )

    assert row["name"] == "Kanade Orchestra"
    assert row["short_name"] == "Kanade"
    assert row["membership_fee_amount"] == "1000"

    response_row = backend_env.db_row_to_json({"id": 2, "candidate_key": "cand-1"})

    assert response_row["candidate_id"] == "cand-1"
