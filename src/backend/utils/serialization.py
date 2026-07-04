from __future__ import annotations

from typing import Any, cast


def model_dump(model: Any) -> dict[str, Any]:
    if isinstance(model, dict):
        return dict(model)
    dumped = model.model_dump() if hasattr(model, "model_dump") else model.dict()
    return cast(dict[str, Any], dumped)


def fk_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
