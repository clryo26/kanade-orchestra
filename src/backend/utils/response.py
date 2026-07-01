from __future__ import annotations

from typing import Any


def success_response(**payload: Any) -> dict[str, Any]:
    return {"ok": True, **payload}


def error_response(message: str, **payload: Any) -> dict[str, Any]:
    return {"ok": False, "message": message, **payload}
