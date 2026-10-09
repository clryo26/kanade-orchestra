"""Post-save Web Push events. Failures never roll back successful business writes."""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
from contextvars import ContextVar
from typing import Any
from time import monotonic
from urllib.parse import urlsplit

from fastapi import HTTPException
from starlette.background import BackgroundTasks

from ..auth_helpers import member_access_expired
from ..core.db_schema import DB_COLLECTION_COLUMNS
from ..core.tenant_context import get_current_tenant_id
from ..repositories.db_row_repository import db_item_value, db_json_value, db_write_value
from ..repositories.notification_repository import NotificationRepository
from .notification_types import NOTIFICATION_TYPES

logger = logging.getLogger(__name__)
_repo = NotificationRepository()
_pending_orgs: ContextVar[set[str] | None] = ContextVar("notification_orgs", default=None)


def enabled() -> bool:
    return os.getenv("WEB_PUSH_ENABLED", "false").lower() == "true"


def configured() -> bool:
    return enabled() and all(
        os.getenv(key, "").strip()
        for key in ("VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT")
    )


def member_identity(device: dict[str, Any]) -> tuple[str, int, str]:
    # Never accept a caller-supplied user ID or invent an ID for hidden accounts.
    value = str(device.get("member_id") or "")
    if not value.isdigit() or int(value) <= 0 or not device.get("device_id"):
        raise HTTPException(403, "通知設定には団員アカウントでログインしてください")
    org, member_id, device_id = get_current_tenant_id(), int(value), str(device["device_id"])
    # Deleted/recreated members and expired sessions must not retain a push identity.
    member = _repo.current_owner(org, member_id, device_id)
    if member is None or member_access_expired(member):
        raise HTTPException(403, "団員アカウントの利用権限を確認できません")
    device["permission"] = member.get("permission") or "一般"
    return org, member_id, device_id


def validate_subscription(subscription: dict[str, Any]) -> None:
    try:
        endpoint = str(subscription["endpoint"])
        parsed = urlsplit(endpoint)
        host = parsed.hostname or ""
        # Fixed provider allowlist plus disabled redirects prevents subscription SSRF.
        allowed = host in {"fcm.googleapis.com", "updates.push.services.mozilla.com"} or any(
            host.endswith("." + suffix) for suffix in ("push.apple.com", "notify.windows.com")
        )
        if (
            len(endpoint) > 4096
            or parsed.scheme != "https"
            or parsed.port not in (None, 443)
            or parsed.username
            or parsed.password
            or parsed.fragment
            or not allowed
        ):
            raise ValueError("endpoint")
        for key, size in (("p256dh", 65), ("auth", 16)):
            value = subscription["keys"][key]
            decoded = base64.b64decode(
                value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
            )
            if len(decoded) != size or (key == "p256dh" and decoded[0] != 4):
                raise ValueError("key")
    except (KeyError, TypeError, ValueError):
        raise HTTPException(422, "Push購読情報が不正、または未対応の配信先です") from None


def data_changed(before: dict[str, Any], after: dict[str, Any], collection: str | None = None) -> bool:
    # Compare actual persisted columns with the repository's date/time/ID conversion.
    # HTML times such as 13:00 and DB times such as 13:00:00 are the same change.
    ignored = {"created_at", "updated_at", "organization_id"}

    def normalized(item) -> str:
        values = {k: v for k, v in item.items() if k not in ignored}
        if collection:
            values = {
                column: db_json_value(db_write_value(collection, column, db_item_value(collection, item, column)))
                for column in DB_COLLECTION_COLUMNS[collection]
                if column not in ignored
            }
        return json.dumps(
            values,
            sort_keys=True,
            default=str,
            ensure_ascii=False,
        )

    return normalized(before) != normalized(after)


def emit(kind: str, item: dict[str, Any], operation: str = "created") -> None:
    if not configured():
        return
    try:
        org = get_current_tenant_id()
        label, target = NOTIFICATION_TYPES[kind]
        # Only harmless saved date/title metadata; no body, names, secrets or storage paths.
        date = str(item.get("date") or item.get("practice_date") or "")[:10]
        action = "更新" if operation == "updated" else "登録"
        title = f"{label}が{action}されました"
        body = f'{date + "の" if date else ""}{label}が{action}されました。'
        identity = item.get("id") or item.get("object_name") or item.get("path")
        if not identity:
            raise ValueError("Notification resource has no stable identity")
        version = (
            item.get("updated_at")
            or item.get("generation")
            or item.get("modified_at")
            or item.get("created_at")
            or ""
        )
        event_id = hashlib.sha256(
            json.dumps(
                [org, kind, str(identity), str(version), operation], ensure_ascii=False
            ).encode()
        ).hexdigest()
        _repo.enqueue(
            event_id, org, kind, {"title": title, "body": body, "target": target, "tag": event_id}
        )
        orgs = _pending_orgs.get()
        if orgs is not None:
            orgs.add(org)
    except Exception as exc:
        # Exception text can contain endpoint keys/DB credentials: log type and category only.
        logger.warning("Push event enqueue failed kind=%s error=%s", kind, type(exc).__name__)


def eligible(recipient: dict[str, Any], kind: str) -> bool:
    permission = str(recipient.get("permission") or "一般")
    if recipient.get("enabled") not in (True, "true") or member_access_expired(recipient):
        return False
    if permission not in {"一般", "管理者", "システム管理者", "エキストラ"}:
        return False
    if kind == "improvements":
        return permission == "システム管理者"
    return not (kind == "events" and permission == "エキストラ")


def send_push(subscription: dict[str, Any], payload: dict[str, Any]) -> int:
    from pywebpush import webpush
    from requests import Session

    class NoRedirectSession(Session):
        def post(self, url, **kwargs):
            kwargs["allow_redirects"] = False
            return super().post(url, **kwargs)

    validate_subscription(subscription)
    with NoRedirectSession() as session:
        response = webpush(
            subscription_info=subscription,
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
            vapid_claims={"sub": os.environ["VAPID_SUBJECT"]},
            ttl=3600,
            timeout=5,
            requests_session=session,
        )
        return int(response.status_code)


def dispatch_pending(org: str) -> None:
    if not configured():
        return
    try:
        with _repo.dispatch_lock(org) as acquired:
            if acquired:
                _dispatch_locked(org)
    except Exception as exc:
        logger.warning("Push dispatch failed error=%s", type(exc).__name__)


def _dispatch_locked(org: str) -> None:
    budget = 500
    deadline = monotonic() + 180
    for event in _repo.pending(org):
        for recipient in _repo.recipients(org, event):
            if budget <= 0 or monotonic() >= deadline:
                return  # Leave remaining deliveries pending for the next scan.
            if not eligible(recipient, event["kind"]) or not _repo.claim(
                event["id"], recipient["id"]
            ):
                continue
            budget -= 1
            subscription = {
                "endpoint": recipient["endpoint"],
                "keys": {"p256dh": recipient["p256dh"], "auth": recipient["auth"]},
            }
            try:
                push_status = send_push(subscription, event["payload"])
            except Exception as exc:
                response = getattr(exc, "response", None)
                status = getattr(response, "status_code", None)
                result = (
                    "invalid"
                    if status in (404, 410)
                    else "retry"
                    if status in (429, 503)
                    else "failed"
                    if status
                    else "unknown"
                )
                _repo.finish(event["id"], recipient["id"], result, status)
                logger.warning(
                    "Push delivery failed event=%s status=%s error=%s",
                    event["id"],
                    status,
                    type(exc).__name__,
                )
            else:
                _repo.finish(event["id"], recipient["id"], "sent", push_status)
        _repo.complete(event["id"])


def install_notification_middleware(app) -> None:
    @app.middleware("http")
    async def notification_middleware(request, call_next):
        orgs: set[str] = set()
        token = _pending_orgs.set(orgs)
        try:
            response = await call_next(request)
            # Dependency headers do not survive HTTPException/validation responses.
            # Apply only to notification APIs, without changing their status or body.
            if request.url.path.startswith("/api/notifications/"):
                response.headers["Cache-Control"] = "no-store"
            if orgs:
                # ASGI background work is attached to the response, not a detached thread.
                tasks = BackgroundTasks()
                if response.background:
                    tasks.add_task(response.background)
                for org in orgs:
                    tasks.add_task(dispatch_pending, org)
                response.background = tasks
            return response
        finally:
            _pending_orgs.reset(token)


def schedule_retry_scan() -> None:
    orgs = _pending_orgs.get()
    if configured() and orgs is not None:
        orgs.add(get_current_tenant_id())
