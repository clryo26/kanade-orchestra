"""Collection-wide policy shared by DB writers and compatibility services."""
from __future__ import annotations

from fastapi import HTTPException


def reject_album_bulk_write(name: str) -> None:
    # PERF-R15: allow_bulk, legacy list mutation and shadow JSON storage must
    # not bypass the row API. Explicit local JSON callers do not enter here.
    if name == "albums":
        raise HTTPException(status_code=409, detail="albums requires the row-level API")
