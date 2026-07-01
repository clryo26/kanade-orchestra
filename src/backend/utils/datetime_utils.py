from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any


def next_updated_at(previous: Any = None) -> str:
    current = datetime.now()
    previous_text = str(previous or "").strip()
    if previous_text:
        try:
            previous_datetime = datetime.fromisoformat(previous_text.replace("Z", "+00:00"))
            if previous_datetime.tzinfo is not None:
                previous_datetime = previous_datetime.astimezone().replace(tzinfo=None)
            if current <= previous_datetime:
                current = previous_datetime + timedelta(microseconds=1)
        except ValueError:
            pass
    return current.isoformat()
