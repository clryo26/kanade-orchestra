from __future__ import annotations

from typing import Any

import psycopg

from fastapi import HTTPException

from ..core.tenant_context import get_current_tenant_id
from ..db.database import db_connection_string
from .db_row_repository import db_row_to_json


_COLUMNS = (
    "id",
    "date",
    "title",
    "content",
    "created_by_member_id",
    "created_at",
    "updated_at",
)


def _row_to_notice(cursor: Any, row: tuple[Any, ...]) -> dict[str, Any]:
    columns = [description[0] for description in cursor.description]
    return db_row_to_json(dict(zip(columns, row)))


class PortalNoticeRepository:
    def list_all(self) -> list[dict[str, Any]]:
        tenant_id = get_current_tenant_id()
        with psycopg.connect(db_connection_string(), autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, date, title, content, created_by_member_id, created_at, updated_at
                    FROM portal_notices
                    WHERE organization_id = %s
                    ORDER BY created_at DESC, id DESC
                    """,
                    (tenant_id,),
                )
                return [_row_to_notice(cur, row) for row in cur.fetchall()]

    def find_by_id(self, notice_id: int) -> dict[str, Any]:
        tenant_id = get_current_tenant_id()
        with psycopg.connect(db_connection_string(), autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, date, title, content, created_by_member_id, created_at, updated_at
                    FROM portal_notices
                    WHERE organization_id = %s AND id = %s
                    """,
                    (tenant_id, notice_id),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="お知らせが見つかりません")
                return _row_to_notice(cur, row)

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        tenant_id = get_current_tenant_id()
        with psycopg.connect(db_connection_string(), autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO portal_notices (
                        organization_id,
                        date,
                        title,
                        content,
                        created_by_member_id
                    ) VALUES (%s, %s, %s, %s, %s)
                    RETURNING id, date, title, content, created_by_member_id, created_at, updated_at
                    """,
                    (
                        tenant_id,
                        payload["date"],
                        payload["title"],
                        payload["content"],
                        payload["created_by_member_id"],
                    ),
                )
                row = cur.fetchone()
                if row is None:
                    raise RuntimeError("Portal notice insert did not return a row")
                result = _row_to_notice(cur, row)
            conn.commit()
        return result

    def update(self, notice_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        tenant_id = get_current_tenant_id()
        with psycopg.connect(db_connection_string(), autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE portal_notices
                    SET date = %s,
                        title = %s,
                        content = %s,
                        updated_at = NOW()
                    WHERE organization_id = %s AND id = %s
                    RETURNING id, date, title, content, created_by_member_id, created_at, updated_at
                    """,
                    (
                        payload["date"],
                        payload["title"],
                        payload["content"],
                        tenant_id,
                        notice_id,
                    ),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="お知らせが見つかりません")
                result = _row_to_notice(cur, row)
            conn.commit()
        return result

    def delete(self, notice_id: int) -> None:
        tenant_id = get_current_tenant_id()
        with psycopg.connect(db_connection_string(), autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM portal_notices
                    WHERE organization_id = %s AND id = %s
                    RETURNING id
                    """,
                    (tenant_id, notice_id),
                )
                if cur.fetchone() is None:
                    raise HTTPException(status_code=404, detail="お知らせが見つかりません")
            conn.commit()
