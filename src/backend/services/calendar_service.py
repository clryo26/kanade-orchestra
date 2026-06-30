from __future__ import annotations

from datetime import datetime


def current_timestamp() -> str:
    """Return the timestamp format already used by API payloads."""
    return datetime.now().isoformat()
