from __future__ import annotations

from ..utils.datetime_utils import format_instant, jst_now



def current_timestamp() -> str:
    """Return the timestamp format already used by API payloads."""
    return format_instant(jst_now())
