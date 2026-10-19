from __future__ import annotations

import logging

from fastapi import HTTPException

from .datetime_utils import InvalidDateTimeValue, is_naive_datetime_text, parse_instant

logger = logging.getLogger(__name__)

CONFLICT_DETAIL = "Data has been updated by another user"


def ensure_expected_updated_at(current: dict[str, object], expected_updated_at: str | None) -> None:
    """Compare the client's version token with the current one as instants.

    The same instant written as ``Z``/``+00:00``/``+09:00`` matches; a
    microsecond difference conflicts. Omitting the token keeps the existing
    contract (no version check). A naive token comes from a screen loaded
    before the JST release: its offset cannot be proven, so it is treated as a
    stale view (409, reload) rather than guessed.
    """
    expected = str(expected_updated_at or "").strip()
    if not expected:
        return
    if is_naive_datetime_text(expected):
        raise HTTPException(status_code=409, detail=CONFLICT_DETAIL)
    try:
        expected_instant = parse_instant(expected, field="expected_updated_at")
    except InvalidDateTimeValue as exc:
        raise HTTPException(status_code=422, detail="expected_updated_at is invalid") from exc
    try:
        current_instant = parse_instant(current.get("updated_at"), field="updated_at")
    except InvalidDateTimeValue as exc:
        # A stored version that cannot be read is a data problem, not a user
        # conflict. Stop the update so it can be investigated.
        logger.error("Stored updated_at is not a valid instant (id=%s)", current.get("id"))
        raise HTTPException(
            status_code=500,
            detail={"code": "datetime_value_invalid", "message": "保存データの日時を確認できません"},
        ) from exc
    if expected_instant != current_instant:
        raise HTTPException(status_code=409, detail=CONFLICT_DETAIL)
