"""Strict user-entered calendar fields (JST spec 1.6 "入力", L30/L33; T04)."""
from __future__ import annotations

import pytest

from src.backend.utils.datetime_utils import InvalidDateTimeValue, require_input_dates


def test_valid_and_empty_dates_pass():
    require_input_dates({"date": "2028-02-29", "deadline": ""}, ("date", "deadline"))
    require_input_dates({"joined_at": "2026-04"}, (), month_fields=("joined_at",))
    require_input_dates({"joined_at": "2026-04-01"}, (), month_fields=("joined_at",))


@pytest.mark.parametrize("value", ["2026/10/19", "2026-10", "2026-02-30", "2026-10-19T00:00:00Z", "tomorrow"])
def test_invalid_dates_are_rejected(value):
    with pytest.raises(InvalidDateTimeValue):
        require_input_dates({"date": value}, ("date",))


def test_api_returns_422_for_an_invalid_event_deadline(client, backend_env, seed_device_fn):
    seed_device_fn(device_id="dev-m", permission="一般", member_id=5, member_name="m")
    response = client.post(
        "/api/events",
        headers={"X-Device-Id": "dev-m"},
        json={"title": "E", "date": "2026-10-20", "deadline": "2026/10/19"},
    )
    assert response.status_code == 422
    assert "deadline" in response.json()["detail"]
    assert backend_env.load_json_data("events") == []
