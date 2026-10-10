"""Atomic PostgreSQL storage for organization-wide menu visibility."""
from __future__ import annotations

from ..core.db_config import db_connection_string
from ..core.db_pool import pooled_psycopg as psycopg


class MenuSettingsRepository:
    def _connection(self):
        return psycopg.connect(db_connection_string(), autocommit=False, connect_timeout=5)

    @staticmethod
    def _load(cur, organization_id: str) -> dict[str, bool]:
        cur.execute(
            "SELECT menu_key, visible FROM menu_visibility_settings WHERE organization_id = %s",
            (organization_id,),
        )
        return {str(key): bool(visible) for key, visible in cur.fetchall()}

    def load(self, organization_id: str) -> dict[str, bool]:
        with self._connection() as conn, conn.cursor() as cur:
            return self._load(cur, organization_id)

    def save(self, organization_id: str, settings: dict[str, bool]) -> dict[str, bool]:
        with self._connection() as conn, conn.cursor() as cur:
            # One transaction for the entire form; failure rolls back every item.
            # Sorted keys keep concurrent full-form saves in a consistent lock order.
            cur.executemany(
                """INSERT INTO menu_visibility_settings (organization_id, menu_key, visible)
                   VALUES (%s, %s, %s)
                   ON CONFLICT (organization_id, menu_key) DO UPDATE
                   SET visible = EXCLUDED.visible, updated_at = NOW()""",
                [(organization_id, key, settings[key]) for key in sorted(settings)],
            )
            saved = self._load(cur, organization_id)
            conn.commit()
            return saved
