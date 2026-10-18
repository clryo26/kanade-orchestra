from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from ..core.db_runtime import local_json_fallback_enabled
from ..core.tenant_context import get_current_tenant_id
from ..repositories import promotion_repository as repo
from . import promotion_image_service as images
from .extra_collection_helpers import parse_extra_upsert_request
from .notification_service import emit

logger = logging.getLogger(__name__)


def failure(status, code, message):
    return status, {"detail": {"code": code, "message": message}}


def public(item: dict[str, Any]) -> dict[str, Any]:
    fields = ("id", "title", "summary", "image_url", "member_id", "registered_by", "created_at", "updated_at", "revision")
    return {key: repo.iso(item.get(key)) for key in fields}


def list_items() -> list[dict[str, Any]]:
    try:
        return [public(item) for item in repo.list_items()]
    except Exception as exc:
        raise HTTPException(503, detail={"code": "promotion_unavailable", "message": "宣伝を取得できません。再試行してください"}) from exc


def actor(device):
    member_id = device.get("member_id")
    if member_id is None and device.get("hidden_user") and device.get("permission") == "システム管理者":
        return "system:hidden-admin:v1"
    if member_id in (None, ""):
        raise HTTPException(401, detail="Member identity is required")
    if local_json_fallback_enabled():
        from .storage_service import load_json_data
        member = next((m for m in load_json_data("members") if str(m.get("id")) == str(member_id)), None)
        birth = (member or {}).get("created_at") or "local-development"
    else:
        with repo.transaction() as cur:
            cur.execute("SELECT created_at FROM members WHERE organization_id=%s AND id=%s",
                        (get_current_tenant_id(), member_id))
            member = cur.fetchone()
        if not member:
            raise HTTPException(401, detail="Member identity is unavailable")
        birth = member["created_at"]
        if not birth:
            raise HTTPException(503, detail="Member identity is unavailable")
        if not isinstance(birth, datetime):
            birth = datetime.fromisoformat(str(birth).replace("Z", "+00:00"))
        birth = birth.replace(tzinfo=timezone.utc) if birth.tzinfo is None else birth.astimezone(timezone.utc)
        birth = birth.isoformat()
    return f"member:{member_id}:{birth}"


def authorize(item, device):
    if device.get("permission") in {"管理者", "システム管理者"}:
        return
    if str(device.get("member_id") or "") and str(item.get("member_id") or "") == str(device["member_id"]):
        return
    raise HTTPException(403, detail={"code": "promotion_forbidden", "message": "自分が登録した宣伝だけを編集できます"})


def result(op):
    if op and op["state"] != "processing":
        return int(op["result_status"]), op["result_body"]
    return 202, {"state": "processing", "code": "promotion_processing", "message": "処理結果を確認しています"}


def current_result(actor_key, operation_id):
    with repo.transaction() as cur:
        return result(repo.operation(cur, actor_key, operation_id, lock=False))


def operation_status(device, operation_id):
    operation_id = str(UUID(operation_id))
    with repo.transaction() as cur:
        op = repo.operation(cur, actor(device), operation_id, lock=False)
    if not op:
        raise HTTPException(404, detail="Operation not found")
    if op["state"] == "processing":
        now = repo.utc_now()
        lease = op["lease_until"]
        lease = lease if isinstance(lease, datetime) else datetime.fromisoformat(lease)
        return 202, {"state": "processing", "retryable": lease <= now}
    return 200, {"state": op["state"], "result_status": op["result_status"], "result_body": op["result_body"]}


def http_result(status: int, body: dict[str, Any]) -> JSONResponse:
    headers = {"Cache-Control": "no-store"}
    if status == 202:
        headers["Retry-After"] = "2"
    return JSONResponse(body, status_code=status, headers=headers)


def validate_target(cur, method, item_id, payload, device):
    if method == "POST":
        return None
    item = repo.row(cur, item_id, lock=True)
    if not item:
        raise HTTPException(404, detail={"code": "promotion_missing", "message": "宣伝が見つかりません"})
    authorize(item, device)
    if int(item["revision"]) != payload["expected_revision"]:
        raise HTTPException(409, detail={"code": "promotion_revision_conflict", "message": "他の操作で更新されています。最新情報を確認してください"})
    return item


async def mutate(method, item_id, raw, device, key):
    try:
        operation_id = str(UUID(str(key)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(422, detail="Idempotency-Key is required") from exc
    actor_key = actor(device)
    payload = parse_extra_upsert_request(raw).payload
    if "image_url" in payload:
        raise HTTPException(422, detail="画面を再読み込みしてください")
    if method != "POST":
        try:
            payload["expected_revision"] = int(payload.get("expected_revision") or 0)
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, detail="Invalid revision") from exc
        if payload["expected_revision"] <= 0:
            raise HTTPException(428, detail={"code": "promotion_revision_required", "message": "画面を再読み込みしてください"})
    content = media = ext = None
    file = raw.get("image_url_file")
    action = str(payload.get("image_action") or ("replace" if file else "remove" if method == "POST" else "keep"))
    if method != "DELETE":
        title = str(payload.get("title") or "").strip()
        summary = str(payload.get("summary") or "").strip()
        if not title or len(title) > 200 or len(summary) > 10000:
            raise HTTPException(422, detail="タイトルと概要の長さを確認してください")
        if action not in {"keep", "replace", "remove"} or bool(file) != (action == "replace") or (method == "POST" and action == "keep"):
            raise HTTPException(422, detail="Invalid image action")
        if file:
            content, media, ext = await images.read_image(file)
        payload = {"title": title, "summary": summary, "image_action": action,
                   **({"expected_revision": payload["expected_revision"]} if method != "POST" else {})}
    else:
        payload = {"expected_revision": payload["expected_revision"]}
    digest = hashlib.sha256(json.dumps([method, item_id, payload, hashlib.sha256(content).hexdigest() if content else None],
                                      sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    op = None
    asset_id = None
    generation = None
    notification_changed = False
    try:
        op, claimed, conflict = repo.reserve(actor_key, operation_id, method, item_id, digest)
        if conflict:
            return failure(409, "promotion_operation_conflict", "同じ操作IDで内容を変更できません")
        if not claimed:
            return result(op)
        # Record deterministic errors only while this attempt still owns the lease.
        with repo.transaction() as cur:
            repo.require_attempt(cur, op)
            try:
                validate_target(cur, method, item_id, payload, device)
            except HTTPException as error:
                body = {"detail": error.detail}
                repo.finish(cur, op, error.status_code, body)
                return error.status_code, body
        if content is not None:
            asset_id, name = images.stage(op, content, media, ext)
            with repo.transaction() as cur:
                repo.require_attempt(cur, op)
                stored = repo.asset(cur, asset_id, lock=True)
                if stored["state"] != "staged":
                    raise repo.LostAttempt()
            generation = images.upload(name, content, media)
        with repo.transaction() as cur:
            repo.require_attempt(cur, op)
            try:
                current = validate_target(cur, method, item_id, payload, device)
            except HTTPException as error:
                repo.finish(cur, op, error.status_code, {"detail": error.detail})
                status, body = error.status_code, {"detail": error.detail}
            else:
                now = repo.db_now(cur)
                old_asset = (current or {}).get("image_asset_id")
                for image_id in sorted({str(v) for v in (old_asset, asset_id) if v}):
                    repo.asset(cur, image_id, lock=True)
                if method == "DELETE":
                    cur.execute("DELETE FROM promotions WHERE organization_id=%s AND id=%s AND revision=%s",
                                (get_current_tenant_id(), item_id, payload["expected_revision"]))
                    body = {"message": "Deleted"}
                else:
                    chosen = asset_id if action == "replace" else old_asset if action == "keep" else None
                    url = f"/api/extra/promotions/{item_id}/image?asset={chosen}" if chosen else ""
                    if method == "POST":
                        cur.execute("INSERT INTO promotions (organization_id,title,summary,image_url,member_id,registered_by,"
                                    "created_at,updated_at,revision,image_asset_id) VALUES (%s,%s,%s,'',%s,%s,%s,%s,1,%s) RETURNING id",
                                    (get_current_tenant_id(), payload["title"], payload["summary"], device.get("member_id") or None,
                                     device.get("member_name") or "Administrator", now, now, chosen))
                        item_id = cur.fetchone()["id"]
                        url = f"/api/extra/promotions/{item_id}/image?asset={chosen}" if chosen else ""
                        cur.execute("UPDATE promotions SET image_url=%s WHERE organization_id=%s AND id=%s",
                                    (url, get_current_tenant_id(), item_id))
                    else:
                        cur.execute("UPDATE promotions SET title=%s,summary=%s,image_url=%s,image_asset_id=%s,"
                                    "updated_at=%s,revision=revision+1 WHERE organization_id=%s AND id=%s AND revision=%s",
                                    (payload["title"], payload["summary"], url, chosen, now, get_current_tenant_id(), item_id,
                                     payload["expected_revision"]))
                    if asset_id:
                        cur.execute("UPDATE promotion_image_assets SET state='active',promotion_id=%s,storage_generation=%s "
                                    "WHERE organization_id=%s AND asset_id=%s AND state='staged' AND attempt_id=%s RETURNING asset_id",
                                    (item_id, generation, get_current_tenant_id(), asset_id, op["attempt_id"]))
                        if not cur.fetchone():
                            raise repo.LostAttempt()
                    body = public(repo.row(cur, item_id))
                    notification_changed = method == "POST" or any(
                        (current or {}).get(field) != body.get(field)
                        for field in ("title", "summary", "image_url")
                    )
                if old_asset and (method == "DELETE" or action != "keep"):
                    cur.execute("UPDATE promotion_image_assets SET state='retired',retired_at=clock_timestamp(),"
                                "next_attempt_at=clock_timestamp() WHERE organization_id=%s AND asset_id=%s",
                                (get_current_tenant_id(), old_asset))
                repo.finish(cur, op, 200, body)
                status = 200
        if status >= 400 and asset_id:
            images.abandon(op, asset_id, generation)
        # Emit only after the business transaction commits. Operation replays
        # return above without creating a second notification.
        if status == 200 and notification_changed:
            emit("promotions", body, "created" if method == "POST" else "updated")
        return status, body
    except repo.LostAttempt:
        if asset_id:
            try:
                images.abandon(op, asset_id, generation)
            except Exception:
                logger.warning("Promotion image deferred for reconciliation")
        return current_result(actor_key, operation_id)
    except Exception:
        # Commit acknowledgement can be lost. Inspect the durable operation on a
        # new connection before releasing a lease; never delete a committed image.
        try:
            status, body = current_result(actor_key, operation_id)
            if status != 202:
                if status == 200 and notification_changed:
                    emit("promotions", body, "created" if method == "POST" else "updated")
                return status, body
            if op:
                repo.release(op)
            if asset_id:
                images.abandon(op, asset_id, generation)
        except Exception:
            pass
        logger.warning("Promotion operation requires retry with the same key")
        return failure(503, "promotion_retry_same_operation", "処理結果を確認できません。同じ操作の状態を確認してください")
