"""JST remediation S01/S03: common date/time contract (spec R02, R05, R07; T01/T02/T04/T10)."""
from __future__ import annotations

import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from src.backend.utils import datetime_utils as dt
from src.backend.utils.concurrency import ensure_expected_updated_at


@pytest.mark.parametrize(
    "text",
    [
        "2026-10-19T03:00:00Z",
        "2026-10-19T03:00:00+00:00",
        "2026-10-19T12:00:00+09:00",
        "2026-10-18T22:00:00-05:00",
        "2026-10-19 12:00:00+09:00",
    ],
)
def test_same_instant_in_any_notation_formats_to_jst(text):
    assert dt.normalize_instant_text(text) == "2026-10-19T12:00:00.000000+09:00"


@pytest.mark.parametrize("digits", ["1", "12", "123", "1234", "12345", "123456"])
def test_one_to_six_fraction_digits_are_kept_exactly(digits):
    parsed = dt.parse_instant(f"2026-10-19T03:00:00.{digits}Z")
    assert parsed.microsecond == int(digits.ljust(6, "0"))


@pytest.mark.parametrize(
    "value",
    [
        "2026-10-19T03:00:00.1234567Z",  # more than 6 digits: no silent truncation
        "2026-10-19T03:00:00",  # naive
        "2026-02-30T00:00:00Z",  # non-existent date
        "2026-10-19T24:00:00Z",
        "2026-10-19",
        "NaN",
        "Infinity",
        "",
        1760842800,
        None,
        datetime(2026, 10, 19, 3, 0),  # naive datetime object
    ],
)
def test_invalid_or_naive_instants_are_rejected(value):
    with pytest.raises(dt.InvalidDateTimeValue):
        dt.parse_instant(value)


def test_error_message_does_not_contain_raw_value():
    with pytest.raises(dt.InvalidDateTimeValue) as error:
        dt.parse_instant("secret-token-2026", field="expected_updated_at")
    assert "secret-token" not in str(error.value)


def test_format_requires_aware_datetime():
    with pytest.raises(dt.InvalidDateTimeValue):
        dt.format_instant(datetime(2026, 1, 1))
    value = datetime(2026, 10, 18, 16, 0, 0, 1, tzinfo=timezone.utc)
    assert dt.format_instant(value) == "2026-10-19T01:00:00.000001+09:00"


def test_calendar_dates_are_strict():
    assert dt.parse_calendar_date("2028-02-29") == date(2028, 2, 29)
    for bad in ["2027-02-29", "2026/10/19", "2026-10", "2026-10-19T00:00:00Z", "", None]:
        with pytest.raises(dt.InvalidDateTimeValue):
            dt.parse_calendar_date(bad)
    assert dt.parse_year_month("2026-12") == "2026-12"
    for bad in ["2026-13", "2026-1", "2026/12"]:
        with pytest.raises(dt.InvalidDateTimeValue):
            dt.parse_year_month(bad)


def test_jst_date_range_is_end_exclusive_next_day():
    start, end = dt.jst_date_range(date(2026, 12, 31), date(2026, 12, 31))
    assert dt.format_instant(start) == "2026-12-31T00:00:00.000000+09:00"
    assert dt.format_instant(end) == "2027-01-01T00:00:00.000000+09:00"
    last = dt.parse_instant("2026-12-31T23:59:59.999999+09:00")
    assert start <= last < end
    assert not (dt.parse_instant("2027-01-01T00:00:00+09:00") < end)
    with pytest.raises(dt.InvalidDateTimeValue):
        dt.jst_date_range(date(2026, 1, 2), date(2026, 1, 1))
    assert dt.jst_date_range(None, None) == (None, None)


def test_utc_midnight_date_codec_round_trip_and_unknown_values():
    stored = dt.utc_midnight_of(date(2026, 10, 19))
    assert dt.decode_utc_midnight_date(stored) == "2026-10-19"
    assert dt.decode_utc_midnight_date("2026-10-19T09:00:00+09:00") == "2026-10-19"
    # JST midnight (a different encoding) is never guessed into a date.
    assert dt.decode_utc_midnight_date("2026-10-18T15:00:00+00:00") is None
    assert dt.decode_utc_midnight_date("garbage") is None
    assert dt.decode_utc_midnight_date(None) is None


def test_legacy_naive_parser_requires_declared_codec():
    with pytest.raises(dt.InvalidDateTimeValue):
        dt.parse_legacy_naive_instant("2026-10-19T00:00:00", assumed=timezone.utc, codec="")
    parsed = dt.parse_legacy_naive_instant("2026-10-19T00:00:00.5", assumed=timezone.utc, codec="ledger:x")
    assert parsed == datetime(2026, 10, 19, 0, 0, 0, 500000, tzinfo=timezone.utc)


def test_next_updated_at_is_aware_monotonic_and_stops_on_future_anomaly():
    now_text = dt.next_updated_at()
    assert now_text.endswith("+09:00") and len(now_text.split(".")[1]) == len("000000+09:00")
    near_future = dt.format_instant(dt.jst_now() + timedelta(seconds=4))
    after = dt.parse_instant(dt.next_updated_at(near_future))
    assert after == dt.parse_instant(near_future) + timedelta(microseconds=1)
    with pytest.raises(dt.FutureVersionAnomaly):
        dt.next_updated_at(dt.format_instant(dt.jst_now() + timedelta(hours=9)))
    # A naive previous value is not compared (offset cannot be proven).
    assert dt.parse_instant(dt.next_updated_at("2099-01-01T00:00:00")) < dt.jst_now() + timedelta(seconds=1)


def test_conflict_check_compares_instants():
    current = {"id": 1, "updated_at": "2026-10-19T03:00:00.123456+00:00"}
    ensure_expected_updated_at(current, "2026-10-19T12:00:00.123456+09:00")
    ensure_expected_updated_at(current, "2026-10-19T03:00:00.123456Z")
    ensure_expected_updated_at(current, "")
    with pytest.raises(HTTPException) as conflict:
        ensure_expected_updated_at(current, "2026-10-19T12:00:00.123457+09:00")
    assert conflict.value.status_code == 409
    with pytest.raises(HTTPException) as naive:
        ensure_expected_updated_at(current, "2026-10-19T12:00:00.123456")
    assert naive.value.status_code == 409
    with pytest.raises(HTTPException) as invalid:
        ensure_expected_updated_at(current, "not-a-date")
    assert invalid.value.status_code == 422
    with pytest.raises(HTTPException) as broken:
        ensure_expected_updated_at({"id": 2, "updated_at": "broken"}, "2026-10-19T12:00:00+09:00")
    assert broken.value.status_code == 500


def test_identical_naive_or_invalid_text_is_not_a_valid_version():
    with pytest.raises(HTTPException) as naive:
        ensure_expected_updated_at({"updated_at": "2026-07-01T00:00:00"}, "2026-07-01T00:00:00")
    assert naive.value.status_code == 409
    with pytest.raises(HTTPException) as invalid:
        ensure_expected_updated_at({"updated_at": "broken"}, "broken")
    assert invalid.value.status_code == 422


@pytest.mark.parametrize("tz_name", ["Asia/Tokyo", "UTC", "America/New_York"])
def test_results_do_not_depend_on_process_timezone(tz_name):
    # Child process so TZ applies from interpreter start (T01). On Windows TZ
    # has limited effect; the Docker/CI run covers POSIX semantics.
    code = (
        "from src.backend.utils import datetime_utils as d;"
        "print(d.normalize_instant_text('2026-10-18T16:00:00Z'));"
        "print(d.jst_now().utcoffset())"
    )
    env = {**os.environ, "TZ": tz_name}
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=60)
    assert result.returncode == 0, result.stderr
    lines = result.stdout.strip().splitlines()
    assert lines[0] == "2026-10-19T01:00:00.000000+09:00"
    assert lines[1] == "9:00:00"
