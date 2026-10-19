"""Legacy desired-piece reference score storage: read-only discovery.

Before the JST remediation (spec R06, D07/D08) reference scores were stored as
``desired_piece_reference_scores/{piece_id}/{timestamp}_{name}.pdf`` and the
newest file in the prefix was served. That made unconfirmed uploads visible
and allowed prefix-wide deletes before the DB commit.

New uploads use ``portal_file_asset_service`` (confirmed asset references).
What remains here is only the *read-only* listing used by
``scripts/migrate_reference_assets.py`` to build an evidence manifest. It
never selects a file by recency and never deletes anything.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from ..core.runtime_paths import UPLOAD_DIR
from ..drive_storage import get_storage_bucket, storage_enabled

REFERENCE_SCORE_ROUTE_PREFIX = "/api/extra/desired_pieces"
REFERENCE_SCORE_STORAGE_PREFIX = "desired_piece_reference_scores"


def reference_score_route(piece_id: int) -> str:
    return f"{REFERENCE_SCORE_ROUTE_PREFIX}/{piece_id}/reference_score"


def legacy_object_prefix(piece_id: int) -> str:
    return f"{REFERENCE_SCORE_STORAGE_PREFIX}/{piece_id}/"


def list_legacy_reference_scores(piece_id: int) -> list[dict[str, Any]]:
    """Every legacy PDF object of one piece with its identity (name, generation, size, time).

    The caller decides with evidence; the count of candidates is never proof
    that a file was committed (spec R06, C03).
    """
    if storage_enabled():
        rows = []
        for blob in get_storage_bucket().list_blobs(prefix=legacy_object_prefix(piece_id), timeout=60):
            if not str(blob.name or "").lower().endswith(".pdf"):
                continue
            updated = getattr(blob, "updated", None)
            rows.append(
                {
                    "source": "gcs",
                    "object_name": blob.name,
                    "generation": getattr(blob, "generation", None),
                    "byte_size": int(getattr(blob, "size", 0) or 0),
                    "updated": updated.isoformat() if isinstance(updated, datetime) else None,
                }
            )
        return rows
    directory = UPLOAD_DIR / REFERENCE_SCORE_STORAGE_PREFIX / str(piece_id)
    if not directory.exists():
        return []
    return [
        {
            "source": "local",
            "object_name": path.relative_to(UPLOAD_DIR).as_posix(),
            "generation": None,
            "byte_size": path.stat().st_size,
            "updated": None,
        }
        for path in sorted(directory.iterdir())
        if path.is_file() and path.suffix.lower() == ".pdf"
    ]
