"""Immutable promotion images; a DB reference is published only after upload."""
from __future__ import annotations

import hashlib
from datetime import timedelta
from uuid import UUID, uuid4

from fastapi import HTTPException
from fastapi.responses import Response
from google.api_core.exceptions import NotFound, PreconditionFailed
from google.api_core.retry import Retry

from ..core.db_runtime import local_json_fallback_enabled
from ..core.tenant_context import get_current_tenant_id
from ..drive_storage import get_storage_bucket
from ..repositories import promotion_repository as repo

MAX_IMAGE_BYTES = 10 * 1024 * 1024
STORAGE_RETRY = Retry(deadline=120)


def image_kind(content):
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "jpg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "png"
    if content[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif", "gif"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp", "webp"
    raise HTTPException(415, detail={"code": "promotion_image_type", "message": "JPEG・PNG・GIF・WebP画像を選択してください"})


async def read_image(file):
    data = bytearray()
    while True:
        chunk = await file.read(64 * 1024)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(413, detail={"code": "promotion_image_size", "message": "画像は10MiB以下にしてください"})
    if not data:
        raise HTTPException(422, detail="Image file is empty")
    media, ext = image_kind(data)
    declared = str(file.content_type or "").lower().replace("image/jpg", "image/jpeg")
    if declared != media:
        raise HTTPException(415, detail={"code": "promotion_image_type", "message": "画像の形式を確認してください"})
    return bytes(data), media, ext


def object_name(asset_id, ext):
    UUID(str(asset_id))
    if ext not in {"jpg", "png", "gif", "webp"}:
        raise ValueError("Unsupported image extension")
    org = hashlib.sha256(get_current_tenant_id().encode()).hexdigest()
    return f"promotion-images/v2/{org}/{asset_id}.{ext}"


def local_path(name):
    from ..core.compat_gateway import get_runtime_data_paths
    root = get_runtime_data_paths()[1].resolve()
    path = (root / name).resolve()
    if not path.is_relative_to(root) or not name.startswith("promotion-images/"):
        raise ValueError("Invalid promotion image path")
    return path


def upload(name, content, media):
    if local_json_fallback_enabled():
        path = local_path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as output:
            output.write(content)
        return None
    blob = get_storage_bucket().blob(name)
    blob.upload_from_string(content, content_type=media, if_generation_match=0,
                            timeout=60, retry=STORAGE_RETRY)
    return int(blob.generation)


def delete_object(name, generation=None):
    if local_json_fallback_enabled():
        local_path(name).unlink(missing_ok=True)
        return
    blob = get_storage_bucket().blob(name)
    if generation is None:
        try:
            blob.reload(timeout=60, retry=STORAGE_RETRY)
        except NotFound:
            return
        generation = int(blob.generation)
    try:
        blob.delete(if_generation_match=int(generation), timeout=60, retry=STORAGE_RETRY)
    except NotFound:
        pass


def stage(op, content, media, ext):
    asset_id = str(uuid4())
    name = object_name(asset_id, ext)
    with repo.transaction() as cur:
        repo.require_attempt(cur, op)
        cur.execute("INSERT INTO promotion_image_assets (asset_id,organization_id,operation_id,actor_key,attempt_id,"
                    "object_name,content_type,byte_size,sha256,state,created_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'staged',clock_timestamp())",
                    (asset_id, get_current_tenant_id(), op["operation_id"], op["actor_key"], op["attempt_id"],
                     name, media, len(content), hashlib.sha256(content).hexdigest()))
    return asset_id, name


def abandon(op, asset_id, generation=None):
    """An expired writer may retire its own image, never another attempt's image."""
    with repo.transaction() as cur:
        repo.operation(cur, op["actor_key"], op["operation_id"])
        item = repo.asset(cur, asset_id, lock=True)
        if not item or str(item["attempt_id"]) != str(op["attempt_id"]) or item["state"] == "active":
            return
        cur.execute("UPDATE promotion_image_assets SET state='delete_pending',storage_generation=%s,"
                    "next_attempt_at=clock_timestamp() WHERE organization_id=%s AND asset_id=%s",
                    (generation, get_current_tenant_id(), asset_id))


def response(item, asset_id):
    if not item or str(item.get("image_asset_id")) != str(asset_id):
        raise HTTPException(404, detail="Image not found")
    with repo.transaction() as cur:
        stored = repo.asset(cur, asset_id)
    if not stored or stored["state"] != "active" or stored["promotion_id"] != item["id"]:
        raise HTTPException(404, detail="Image not found")
    if local_json_fallback_enabled():
        try:
            content = local_path(stored["object_name"]).read_bytes()
        except FileNotFoundError as exc:
            raise HTTPException(404, detail="Image not found") from exc
    else:
        try:
            content = get_storage_bucket().blob(stored["object_name"], generation=stored["storage_generation"]).download_as_bytes(
                timeout=60, retry=STORAGE_RETRY)
        except NotFound as exc:
            raise HTTPException(404, detail="Image not found") from exc
    return Response(content, media_type=stored["content_type"], headers={"Cache-Control": "no-store"})


def cleanup(limit=100, execute=False):
    """Reconcile tombstones too: an upload can complete after an earlier NotFound.

    Claim under the operation/image locks before I/O. The publishing transaction
    refuses delete_pending, so no live image can be published during deletion.
    """
    with repo.transaction() as cur:
        now = repo.db_now(cur)
        cur.execute("SELECT asset_id FROM promotion_image_assets WHERE organization_id=%s AND state<>'active' "
                    "AND (next_attempt_at IS NULL OR next_attempt_at<=%s) "
                    "ORDER BY COALESCE(last_checked_at,created_at),asset_id LIMIT %s",
                    (get_current_tenant_id(), now, limit))
        candidates = cur.fetchall()
    results = []
    for candidate in candidates:
        with repo.transaction() as cur:
            stored = repo.asset(cur, candidate["asset_id"])
            if not stored:
                continue
            op = repo.operation(cur, stored["actor_key"], stored["operation_id"])
            stored = repo.asset(cur, candidate["asset_id"], lock=True)
            now = repo.db_now(cur)
            lease = op["lease_until"] if isinstance(op["lease_until"], type(now)) else type(now).fromisoformat(op["lease_until"])
            created = stored["created_at"] if isinstance(stored["created_at"], type(now)) else type(now).fromisoformat(stored["created_at"])
            if stored["state"] == "active" or (op["state"] == "processing" and lease > now):
                continue
            if stored["state"] == "staged" and created + timedelta(hours=24) > now:
                continue
            cur.execute("SELECT id FROM promotions WHERE organization_id=%s AND image_asset_id=%s",
                        (get_current_tenant_id(), stored["asset_id"]))
            if cur.fetchone():
                continue
            results.append(str(stored["asset_id"]))
            if not execute:
                continue
            cur.execute("UPDATE promotion_image_assets SET state='delete_pending' WHERE asset_id=%s AND organization_id=%s",
                        (stored["asset_id"], get_current_tenant_id()))
        if not execute:
            continue
        error = None
        try:
            # Reload on every reconciliation: an old generation may have been
            # deleted and a late upload created a different, still-unreferenced one.
            delete_object(stored["object_name"])
        except Exception as exc:
            error = "generation_changed" if isinstance(exc, PreconditionFailed) else "storage_unavailable"
        with repo.transaction() as cur:
            repo.operation(cur, stored["actor_key"], stored["operation_id"])
            current = repo.asset(cur, stored["asset_id"], lock=True)
            if current["state"] != "delete_pending":
                continue
            retry = int(current["retry_count"] or 0) + (1 if error else 0)
            next_time = repo.db_now(cur) + timedelta(seconds=min(86400, 60 * 2 ** min(retry, 11)) if error else 86400)
            cur.execute("UPDATE promotion_image_assets SET state=%s,last_checked_at=clock_timestamp(),"
                        "deleted_at=CASE WHEN %s IS NULL THEN clock_timestamp() ELSE deleted_at END,"
                        "next_attempt_at=%s,retry_count=%s,last_error_code=%s WHERE asset_id=%s AND organization_id=%s",
                        ("delete_pending" if error else "deleted", error, next_time, retry, error,
                         stored["asset_id"], get_current_tenant_id()))
    return results
