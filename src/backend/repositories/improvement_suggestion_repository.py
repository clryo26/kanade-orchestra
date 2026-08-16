from __future__ import annotations

from datetime import date
from typing import Any

from ..core.db_pool import pooled_psycopg as psycopg


class ImprovementSuggestionRepository:
    def __init__(self, conn_str: str) -> None:
        self._conn_str = conn_str

    @staticmethod
    def _row_to_dict(row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "member_id": row[1],
            "registered_by": row[2] or "",
            "suggestion": row[3] or "",
            "status": row[4] or "未対応",
            "resolution": row[5] or "",
            "responded_at": row[6].isoformat() if row[6] else None,
            "created_at": row[7].isoformat() if row[7] else "",
            "updated_at": row[8].isoformat() if row[8] else "",
        }

    def list_all(self, organization_id: str) -> list[dict[str, Any]]:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, member_id, registered_by, suggestion, status,
                           resolution, responded_at, created_at, updated_at
                    FROM improvement_suggestions
                    WHERE organization_id = %s
                    ORDER BY created_at DESC, id DESC
                    """,
                    (organization_id,),
                )
                return [self._row_to_dict(row) for row in cur.fetchall()]

    def create(
        self,
        *,
        organization_id: str,
        member_id: int | None,
        registered_by: str,
        suggestion: str,
        status: str,
        resolution: str,
        responded_at: date | None,
    ) -> dict[str, Any]:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO improvement_suggestions (
                        organization_id, member_id, registered_by, suggestion,
                        status, resolution, responded_at, updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
                    RETURNING id, member_id, registered_by, suggestion, status,
                              resolution, responded_at, created_at, updated_at
                    """,
                    (
                        organization_id,
                        member_id,
                        registered_by,
                        suggestion,
                        status,
                        resolution,
                        responded_at,
                    ),
                )
                return self._row_to_dict(cur.fetchone())

    def update(
        self,
        *,
        organization_id: str,
        item_id: int,
        suggestion: str,
        status: str,
        resolution: str,
        responded_at: date | None,
    ) -> dict[str, Any] | None:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE improvement_suggestions
                    SET suggestion = %s,
                        status = %s,
                        resolution = %s,
                        responded_at = %s,
                        updated_at = NOW()
                    WHERE organization_id = %s AND id = %s
                    RETURNING id, member_id, registered_by, suggestion, status,
                              resolution, responded_at, created_at, updated_at
                    """,
                    (suggestion, status, resolution, responded_at, organization_id, item_id),
                )
                row = cur.fetchone()
                return self._row_to_dict(row) if row else None

    def delete(self, *, organization_id: str, item_id: int) -> bool:
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM improvement_suggestions WHERE organization_id = %s AND id = %s",
                    (organization_id, item_id),
                )
                return int(cur.rowcount) > 0
