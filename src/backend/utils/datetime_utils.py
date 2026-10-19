"""Portal date/time contract helpers (JST remediation spec R02).

Why a fixed offset: Japan has had no daylight saving time since 1951 and the
portal only serves the current era, so ``+09:00`` is exact. A fixed offset
avoids depending on IANA data being present in the slim Docker image or on
Windows (``ZoneInfo`` availability differs per environment).

Rules enforced here:
- an *instant* is always timezone-aware; naive values are never given a zone
  by guessing (only explicit legacy codecs may do that, see
  ``parse_legacy_naive_instant``),
- business API output for instants is ``YYYY-MM-DDTHH:MM:SS.ffffff+09:00``,
- calendar dates / months are validated strictly and never shifted.

DB-generated versions (``updated_at``) are produced in SQL by the row-level
repository; ``next_updated_at`` remains only for the explicit local JSON
development mode and the app_core compatibility facade.
"""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from typing import Any

JST = timezone(timedelta(hours=9), "JST")
API_DATETIME_FORMAT_VERSION = "jst-us-1"
MAX_FUTURE_VERSION_SKEW = timedelta(seconds=5)

_INSTANT_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?"
    r"(Z|z|[+-]\d{2}:\d{2})$"
)
_NAIVE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$")
_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_MONTH_RE = re.compile(r"^(\d{4})-(\d{2})$")


class InvalidDateTimeValue(ValueError):
    """A date/time value that violates its declared contract.

    The message carries the field name and a reason only; the raw value is
    never included so request contents cannot leak into logs.
    """

    def __init__(self, field: str, reason: str) -> None:
        super().__init__(f"{field}: {reason}")
        self.field = field
        self.reason = reason


class FutureVersionAnomaly(RuntimeError):
    """A stored version timestamp is further in the future than allowed (R07)."""

    def __init__(self, table: str, item_id: Any) -> None:
        super().__init__(f"{table}:{item_id}: stored version is in the future")
        self.table = table
        self.item_id = item_id


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def jst_now() -> datetime:
    return datetime.now(JST)


def jst_today() -> date:
    return jst_now().date()


def is_naive_datetime_text(value: Any) -> bool:
    return isinstance(value, str) and bool(_NAIVE_RE.match(value.strip()))


def parse_instant(value: Any, *, field: str = "datetime") -> datetime:
    """Parse an instant that carries an explicit offset.

    Accepts ``Z``/``±HH:MM`` and 1–6 fractional digits (Python 3.10's
    ``fromisoformat`` handles neither ``Z`` nor 1/2/4/5 digits, so the value
    is decomposed here). Naive values, more than 6 fractional digits, numbers
    and non-finite values are rejected.
    """
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise InvalidDateTimeValue(field, "timezone offset is required")
        return value
    if not isinstance(value, str):
        raise InvalidDateTimeValue(field, "string value is required")
    match = _INSTANT_RE.match(value.strip())
    if not match:
        if is_naive_datetime_text(value):
            raise InvalidDateTimeValue(field, "timezone offset is required")
        raise InvalidDateTimeValue(field, "invalid datetime format")
    year, month, day, hour, minute, second, fraction, offset = match.groups()
    micro = int((fraction or "").ljust(6, "0") or 0)
    if offset in {"Z", "z"}:
        tz: tzinfo = timezone.utc
    else:
        sign = 1 if offset[0] == "+" else -1
        hours, minutes = int(offset[1:3]), int(offset[4:6])
        if hours > 23 or minutes > 59:
            raise InvalidDateTimeValue(field, "invalid timezone offset")
        tz = timezone(sign * timedelta(hours=hours, minutes=minutes))
    try:
        return datetime(
            int(year), int(month), int(day), int(hour), int(minute), int(second or 0), micro, tzinfo=tz
        )
    except ValueError as exc:
        raise InvalidDateTimeValue(field, "non-existent date or time") from exc


def format_instant(value: datetime) -> str:
    """Return the business API representation ``…ffffff+09:00``."""
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise InvalidDateTimeValue("datetime", "timezone offset is required")
    return value.astimezone(JST).isoformat(timespec="microseconds")


def normalize_instant_text(value: Any, *, field: str = "datetime") -> str:
    return format_instant(parse_instant(value, field=field))


def instant_or_none(value: Any) -> datetime | None:
    """Lenient parse for display/sort keys: ``None`` instead of an error."""
    if value in (None, ""):
        return None
    try:
        return parse_instant(value)
    except InvalidDateTimeValue:
        return None


def instant_sort_key(value: Any) -> tuple[int, float]:
    """Sort key placing unparseable/missing values first in ascending order."""
    parsed = instant_or_none(value)
    if parsed is None:
        return (0, 0.0)
    return (1, parsed.timestamp())


def same_instant(a: datetime, b: datetime) -> bool:
    return parse_instant(a) == parse_instant(b)


def parse_calendar_date(value: Any, *, field: str = "date") -> date:
    if isinstance(value, datetime):
        raise InvalidDateTimeValue(field, "date value is required")
    if isinstance(value, date):
        return value
    match = _DATE_RE.match(str(value or "").strip())
    if not match:
        raise InvalidDateTimeValue(field, "YYYY-MM-DD is required")
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError as exc:
        raise InvalidDateTimeValue(field, "non-existent date") from exc


def parse_year_month(value: Any, *, field: str = "month") -> str:
    match = _MONTH_RE.match(str(value or "").strip())
    if not match or not 1 <= int(match.group(2)) <= 12:
        raise InvalidDateTimeValue(field, "YYYY-MM is required")
    return f"{match.group(1)}-{match.group(2)}"


def jst_day_start(value: date) -> datetime:
    return datetime.combine(value, time.min, tzinfo=JST)


def jst_date_range(start: date | None, end: date | None) -> tuple[datetime | None, datetime | None]:
    """Return ``(start 00:00+09:00, day after end 00:00+09:00)`` (end exclusive)."""
    if start is not None and end is not None and start > end:
        raise InvalidDateTimeValue("date_range", "start must not be after end")
    return (
        jst_day_start(start) if start is not None else None,
        jst_day_start(end + timedelta(days=1)) if end is not None else None,
    )


def utc_midnight_of(value: date) -> datetime:
    """Encoding used by ``events.deadline``: a calendar date stored as UTC 00:00."""
    return datetime.combine(value, time.min, tzinfo=timezone.utc)


def decode_utc_midnight_date(value: Any) -> str | None:
    """Inverse of ``utc_midnight_of``. Any other time of day is unknown (``None``)."""
    if value in (None, ""):
        return None
    try:
        instant = parse_instant(value)
    except InvalidDateTimeValue:
        return None
    as_utc = instant.astimezone(timezone.utc)
    if as_utc.time() != time.min:
        return None
    return as_utc.date().isoformat()


def parse_legacy_naive_instant(value: str, *, assumed: tzinfo, codec: str) -> datetime:
    """Attach a zone to a naive value for a *declared* legacy codec only.

    ``codec`` names the ledger entry that justifies the assumption so call
    sites stay auditable. No production path uses this yet.
    """
    if not codec:
        raise InvalidDateTimeValue("datetime", "legacy codec name is required")
    text = str(value or "").strip()
    if not _NAIVE_RE.match(text):
        raise InvalidDateTimeValue("datetime", "naive datetime is required")
    head, _, fraction = text.replace(" ", "T").partition(".")
    if len(fraction) > 6:
        raise InvalidDateTimeValue("datetime", "too many fractional digits")
    parsed = datetime.fromisoformat(head + (f".{fraction.ljust(6, '0')}" if fraction else ""))
    return parsed.replace(tzinfo=assumed)


def next_updated_at(previous: Any = None) -> str:
    """Local JSON mode version generator (DB mode generates versions in SQL).

    Returns ``max(now, previous + 1µs)``. A naive or invalid previous value is
    not compared (its offset cannot be proven). A previous value more than
    ``MAX_FUTURE_VERSION_SKEW`` ahead stops the update instead of chasing it.
    """
    current = jst_now()
    previous_instant = instant_or_none(previous)
    if previous_instant is not None:
        if previous_instant > current + MAX_FUTURE_VERSION_SKEW:
            raise FutureVersionAnomaly("local", "")
        if current <= previous_instant:
            current = previous_instant + timedelta(microseconds=1)
    return format_instant(current)


def require_input_dates(
    payload: dict[str, Any],
    fields: tuple[str, ...],
    *,
    month_fields: tuple[str, ...] = (),
) -> None:
    """Strict check of user-entered calendar fields (spec 1.6: invalid input -> 422).

    Empty means "not set" and stays allowed. ``month_fields`` accept
    ``YYYY-MM`` as well (existing month inputs such as ``joined_at``).
    Stored values and server-derived dates are not validated here.
    """
    for name in (*fields, *month_fields):
        value = payload.get(name)
        if value in (None, ""):
            continue
        if name in month_fields and _MONTH_RE.match(str(value).strip()):
            parse_year_month(value, field=name)
            continue
        parse_calendar_date(value, field=name)
