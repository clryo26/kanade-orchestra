from __future__ import annotations

from fastapi import HTTPException


def ensure_expected_updated_at(current: dict[str, object], expected_updated_at: str | None) -> None:
    expected = str(expected_updated_at or "").strip()
    if not expected:
        return
    current_updated = str(current.get("updated_at") or "")
    if current_updated != expected:
        raise HTTPException(status_code=409, detail="Data has been updated by another user")
