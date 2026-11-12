# AIDO derived pure-test subset. Original repository is unchanged.
from __future__ import annotations
import pytest
from src.backend.utils.datetime_utils import InvalidDateTimeValue, require_input_dates
from datetime import date, datetime
from src.backend.utils.datetime_utils import parse_calendar_date, parse_year_month

def test_valid_and_empty_dates_pass():
    require_input_dates({"date": "2028-02-29", "deadline": ""}, ("date", "deadline"))
    require_input_dates({"joined_at": "2026-04"}, (), month_fields=("joined_at",))
    require_input_dates({"joined_at": "2026-04-01"}, (), month_fields=("joined_at",))


@pytest.mark.parametrize("value", ["2026/10/19", "2026-10", "2026-02-30", "2026-10-19T00:00:00Z", "tomorrow"])
def test_invalid_dates_are_rejected(value):
    with pytest.raises(InvalidDateTimeValue):
        require_input_dates({"date": value}, ("date",))



def assert_invalid_value(excinfo, field, reason):
    assert excinfo.value.field == field
    assert excinfo.value.reason == reason
    assert str(excinfo.value) == field + ": " + reason


def test_parse_calendar_date_returns_same_date_object():
    value = date(2024, 2, 29)
    result = parse_calendar_date(value, field="event_date")
    assert result is value
    assert type(result) is date
    assert result == date(2024, 2, 29)
    assert result.isoformat() == "2024-02-29"


@pytest.mark.parametrize(
    "value",
    [
        datetime(2024, 2, 29),
        datetime(2024, 2, 29, 0, 0, 0),
        datetime(2024, 2, 29, 12, 30, 15, 123456),
    ],
)
def test_parse_calendar_date_rejects_datetime_instances(value):
    with pytest.raises(InvalidDateTimeValue) as excinfo:
        parse_calendar_date(value, field="event_date")
    assert_invalid_value(excinfo, "event_date", "date value is required")


def test_parse_calendar_date_datetime_rejection_uses_supplied_field():
    with pytest.raises(InvalidDateTimeValue) as excinfo:
        parse_calendar_date(datetime(2030, 1, 2), field="deadline")
    assert_invalid_value(excinfo, "deadline", "date value is required")


@pytest.mark.parametrize(
    "value",
    [
        "2024-1",
        "2024",
        "2024-001",
        "24-01",
        "2024/01",
        "2024-01-01",
        "2024-1x",
        "abc",
        "",
        None,
    ],
)
def test_parse_year_month_rejects_malformed_text(value):
    with pytest.raises(InvalidDateTimeValue) as excinfo:
        parse_year_month(value, field="month")
    assert_invalid_value(excinfo, "month", "YYYY-MM is required")


@pytest.mark.parametrize("value", ["2024-00", "2024-13", "2024-99"])
def test_parse_year_month_rejects_out_of_range_months(value):
    with pytest.raises(InvalidDateTimeValue) as excinfo:
        parse_year_month(value, field="joined_at")
    assert_invalid_value(excinfo, "joined_at", "YYYY-MM is required")


@pytest.mark.parametrize(
    "value, expected",
    [
        ("2024-01", "2024-01"),
        ("2024-09", "2024-09"),
        ("2024-12", "2024-12"),
        (" 2024-06 ", "2024-06"),
    ],
)
def test_parse_year_month_accepts_valid_months(value, expected):
    result = parse_year_month(value, field="month")
    assert isinstance(result, str)
    assert result == expected

