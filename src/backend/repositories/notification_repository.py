"""Tenant-scoped push storage, separate from bulk JSON collection replacement."""
from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, cast
from uuid import uuid4

from ..core.db_config import db_connection_string
from ..core.db_pool import pooled_psycopg as psycopg
from ..services.notification_types import DEFAULT_PREFERENCES


class NotificationRepository:
    @contextmanager
    def dispatch_lock(self, org: str):
        # Serialize each organization's scan across instances without a detached worker.
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_xact_lock(hashtext(%s))", ("push-dispatch:" + org,))
            yield bool(cur.fetchone()[0])

    def _connection(self):
        return psycopg.connect(db_connection_string(), autocommit=False, connect_timeout=5)

    def current_owner(self, org: str, member_id: int, device_id: str) -> dict[str, Any] | None:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT m.permission,m.system_access_until FROM members m
                JOIN auth_devices a ON a.organization_id=m.organization_id AND a.member_id=m.id
                WHERE m.organization_id=%s AND m.id=%s AND a.device_id=%s
                AND a.authenticated_at>=m.created_at""",
                (org, member_id, device_id),
            )
            row = cur.fetchone()
            return dict(zip(("permission", "system_access_until"), row)) if row else None

    def preferences(self, organization_id: str, member_id: int) -> dict[str, bool]:
        # Persist initial defaults rather than relying on a browser-local fallback.
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO notification_preferences (organization_id, member_id) VALUES (%s,%s)
                ON CONFLICT (organization_id,member_id) DO UPDATE SET preferences=EXCLUDED.preferences,updated_at=NOW()
                WHERE notification_preferences.updated_at <
                    (SELECT created_at FROM members WHERE organization_id=%s AND id=%s)""",
                (organization_id, member_id, organization_id, member_id),
            )
            cur.execute(
                "SELECT preferences FROM notification_preferences WHERE organization_id=%s AND member_id=%s",
                (organization_id, member_id),
            )
            result = {**DEFAULT_PREFERENCES, **cur.fetchone()[0]}
            conn.commit()
        return cast(dict[str, bool], result)

    def save_preferences(
        self, organization_id: str, member_id: int, patch: dict[str, bool]
    ) -> dict[str, bool]:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO notification_preferences (organization_id,member_id,preferences)
                VALUES (%s,%s,%s::jsonb) ON CONFLICT (organization_id,member_id)
                DO UPDATE SET preferences=notification_preferences.preferences || %s::jsonb,updated_at=NOW()
                RETURNING preferences""",
                (
                    organization_id,
                    member_id,
                    json.dumps({**DEFAULT_PREFERENCES, **patch}),
                    json.dumps(patch),
                ),
            )
            result = cur.fetchone()[0]
            conn.commit()
        return cast(dict[str, bool], result)

    def subscribe(
        self, org: str, member_id: int, device_id: str, subscription: dict[str, Any]
    ) -> str:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(
                """UPDATE push_subscriptions SET active=FALSE,updated_at=NOW()
                WHERE organization_id=%s AND member_id=%s AND device_id=%s AND endpoint<>%s""",
                (org, member_id, device_id, subscription["endpoint"]),
            )
            # One browser endpoint belongs to one current account, even after account switching.
            cur.execute(
                """INSERT INTO push_subscriptions (id,organization_id,member_id,device_id,endpoint,p256dh,auth)
                VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (endpoint) DO UPDATE SET
                organization_id=EXCLUDED.organization_id,member_id=EXCLUDED.member_id,device_id=EXCLUDED.device_id,
                p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,active=TRUE,created_at=NOW(),updated_at=NOW()
                RETURNING id""",
                (
                    uuid4().hex,
                    org,
                    member_id,
                    device_id,
                    subscription["endpoint"],
                    subscription["keys"]["p256dh"],
                    subscription["keys"]["auth"],
                ),
            )
            subscription_id = str(cur.fetchone()[0])
            conn.commit()
        return subscription_id

    def unsubscribe(self, org: str, member_id: int, device_id: str) -> None:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE push_subscriptions SET active=FALSE,updated_at=NOW() WHERE organization_id=%s AND member_id=%s AND device_id=%s",
                (org, member_id, device_id),
            )
            conn.commit()

    def subscribed(self, org: str, member_id: int, device_id: str) -> bool:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT 1 FROM push_subscriptions s WHERE organization_id=%s AND member_id=%s AND device_id=%s AND active
                AND created_at >= (SELECT m.created_at FROM members m WHERE m.organization_id=s.organization_id AND m.id=s.member_id)""",
                (org, member_id, device_id),
            )
            return cur.fetchone() is not None

    def enqueue(self, event_id: str, org: str, kind: str, payload: dict[str, Any]) -> None:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO notification_events (id,organization_id,kind,payload) VALUES (%s,%s,%s,%s::jsonb) ON CONFLICT DO NOTHING",
                (event_id, org, kind, json.dumps(payload, ensure_ascii=False)),
            )
            conn.commit()

    def pending(self, org: str) -> list[dict[str, Any]]:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT id,kind,payload,created_at FROM notification_events WHERE organization_id=%s AND NOT completed AND created_at > NOW()-INTERVAL '1 day' ORDER BY created_at LIMIT 20",
                (org,),
            )
            return [
                dict(zip(("id", "kind", "payload", "created_at"), row)) for row in cur.fetchall()
            ]

    def recipients(self, org: str, event: dict[str, Any]) -> list[dict[str, Any]]:
        with self._connection() as conn, conn.cursor() as cur:
            # Read current members/preferences, never stale auth-device permission snapshots.
            cur.execute(
                """SELECT s.id,s.endpoint,s.p256dh,s.auth,m.permission,m.system_access_until,
                COALESCE(p.preferences->>%s,'true'),m.id FROM push_subscriptions s
                JOIN members m ON m.organization_id=s.organization_id AND m.id=s.member_id
                LEFT JOIN notification_preferences p ON p.organization_id=s.organization_id AND p.member_id=s.member_id
                WHERE s.organization_id=%s AND s.active AND s.created_at<=%s AND s.created_at>=m.created_at
                AND EXISTS (SELECT 1 FROM auth_devices a WHERE a.organization_id=s.organization_id
                    AND a.member_id=s.member_id AND a.device_id=s.device_id AND a.authenticated_at>=m.created_at)""",
                (event["kind"], org, event["created_at"]),
            )
            return [
                dict(
                    zip(
                        (
                            "id",
                            "endpoint",
                            "p256dh",
                            "auth",
                            "permission",
                            "system_access_until",
                            "enabled",
                            "member_id",
                        ),
                        row,
                    )
                )
                for row in cur.fetchall()
            ]

    def claim(self, event_id: str, subscription_id: str) -> bool:
        with self._connection() as conn, conn.cursor() as cur:
            # Atomic claim prevents concurrent Cloud Run instances sending the same delivery.
            # A crash/timeout in 'sending' is ambiguous: do not resend it automatically.
            cur.execute(
                """INSERT INTO notification_deliveries (event_id,subscription_id,status) VALUES (%s,%s,'sending')
                ON CONFLICT (event_id,subscription_id) DO UPDATE SET status='sending',
                attempts=notification_deliveries.attempts+1,updated_at=NOW()
                WHERE notification_deliveries.status='retry' AND notification_deliveries.attempts<3
                    AND notification_deliveries.next_attempt_at<=NOW() RETURNING event_id""",
                (event_id, subscription_id),
            )
            claimed = cur.fetchone() is not None
            conn.commit()
        return claimed

    def finish(
        self, event_id: str, subscription_id: str, status: str, http_status: int | None = None
    ) -> None:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(
                """UPDATE notification_deliveries SET status=%s,http_status=%s,updated_at=NOW(),
                next_attempt_at=NOW()+INTERVAL '5 minutes' WHERE event_id=%s AND subscription_id=%s""",
                (status, http_status, event_id, subscription_id),
            )
            if status == "invalid":
                cur.execute(
                    "UPDATE push_subscriptions SET active=FALSE,updated_at=NOW() WHERE id=%s",
                    (subscription_id,),
                )
            if status == "retry":
                cur.execute(
                    """UPDATE notification_deliveries SET status='failed'
                    WHERE event_id=%s AND subscription_id=%s AND attempts>=3""",
                    (event_id, subscription_id),
                )
            conn.commit()

    def complete(self, event_id: str) -> None:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(
                """UPDATE notification_events SET completed=TRUE WHERE id=%s AND NOT EXISTS
                (SELECT 1 FROM notification_deliveries WHERE event_id=%s AND status='retry' AND attempts<3)""",
                (event_id, event_id),
            )
            conn.commit()
