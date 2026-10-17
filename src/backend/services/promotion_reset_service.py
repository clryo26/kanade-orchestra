"""Resumable, explicitly invoked reset. Never called at startup or migration."""
from __future__ import annotations

import hashlib
import json
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

from ..core.tenant_context import get_current_tenant_id
from ..repositories import promotion_repository as repo
from . import promotion_image_service as images


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str, ensure_ascii=False).encode()).hexdigest()


def manifest():
    items = []
    for row in repo.list_items():
        items.append({"promotion_id": row["id"], "kind": "promotion", "object_name": None,
                      "storage_generation": None, "fingerprint": fingerprint(row), "state": "pending"})
        name = None
        if row.get("image_asset_id"):
            with repo.transaction() as cur:
                stored = repo.asset(cur, row["image_asset_id"])
            if stored:
                name = stored["object_name"]
        url = str(row.get("image_url") or "")
        if not url or url.startswith("data:image/"):
            continue
        if not name:
            parsed = urlsplit(url)
            ext = parse_qs(parsed.query).get("ext", [""])[0]
            if not parsed.scheme and not parsed.netloc and parsed.path == f"/api/extra/promotions/{row['id']}/image" and ext in {"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"}:
                name = f"promotion-images/{row['id']}/image.{ext}"
        generation = None
        state = "pending" if name else "needs_review"
        if name and not images.local_json_fallback_enabled():
            from google.api_core.exceptions import NotFound
            try:
                blob = images.get_storage_bucket().blob(name)
                blob.reload(timeout=60, retry=images.STORAGE_RETRY)
                generation = int(blob.generation)
            except NotFound:
                state = "missing"
        items.append({"promotion_id": row["id"], "kind": "object", "object_name": name,
                      "storage_generation": generation, "fingerprint": fingerprint([row["id"], name, generation]), "state": state})
    return items


def prepare(environment_id, execute=False):
    items = manifest()
    if not execute:
        return {"mode": "dry-run", "promotion_count": sum(i["kind"] == "promotion" for i in items),
                "image_count": sum(i["kind"] == "object" for i in items),
                "needs_review": sum(i["state"] == "needs_review" for i in items)}
    run_id = str(uuid4())
    with repo.transaction() as cur:
        cur.execute("SELECT * FROM promotions WHERE organization_id=%s ORDER BY created_at DESC,id DESC FOR UPDATE",
                    (get_current_tenant_id(),))
        current = {r["id"]: fingerprint(r) for r in cur.fetchall()}
        expected = {i["promotion_id"]: i["fingerprint"] for i in items if i["kind"] == "promotion"}
        if current != expected:
            raise RuntimeError("Promotions changed while preparing the reset")
        cur.execute("INSERT INTO promotion_reset_runs (run_id,environment_id,organization_id,state,manifest_hash,item_count,created_at,updated_at) "
                    "VALUES (%s,%s,%s,'prepared',%s,%s,clock_timestamp(),clock_timestamp())",
                    (run_id, environment_id, get_current_tenant_id(), fingerprint(items), len(items)))
        for item in items:
            cur.execute("INSERT INTO promotion_reset_items (item_id,run_id,promotion_id,kind,object_name,storage_generation,fingerprint,state,updated_at) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,clock_timestamp())",
                        (str(uuid4()), run_id, item["promotion_id"], item["kind"], item["object_name"],
                         item["storage_generation"], item["fingerprint"], item["state"]))
    return {"run_id": run_id, "state": "prepared"}


def locked_run(cur, run_id, environment_id):
    cur.execute("SELECT * FROM promotion_reset_runs WHERE run_id=%s AND environment_id=%s AND organization_id=%s FOR UPDATE",
                (str(UUID(run_id)), environment_id, get_current_tenant_id()))
    run = cur.fetchone()
    if not run:
        raise RuntimeError("Reset run does not match this environment/organization")
    return run


def resume(run_id, environment_id, execute=False):
    with repo.transaction() as cur:
        run = locked_run(cur, run_id, environment_id)
        cur.execute("SELECT * FROM promotion_reset_items WHERE run_id=%s ORDER BY item_id", (run_id,))
        items = cur.fetchall()
        if not execute or run["state"] == "completed":
            return {"run_id": run_id, "state": run["state"], "remaining": sum(i["state"] not in {"deleted", "missing"} for i in items)}
        if run["state"] == "prepared":
            cur.execute("SELECT * FROM promotions WHERE organization_id=%s FOR UPDATE", (get_current_tenant_id(),))
            current = {r["id"]: fingerprint(r) for r in cur.fetchall()}
            expected = {i["promotion_id"]: i["fingerprint"] for i in items if i["kind"] == "promotion"}
            if current != expected:
                raise RuntimeError("Reset manifest no longer matches the database")
            for item in items:
                if item["kind"] == "promotion":
                    cur.execute("DELETE FROM promotions WHERE organization_id=%s AND id=%s", (get_current_tenant_id(), item["promotion_id"]))
            cur.execute("UPDATE promotion_image_assets SET state='retired',retired_at=clock_timestamp() "
                        "WHERE organization_id=%s AND state='active'", (get_current_tenant_id(),))
            cur.execute("UPDATE promotion_reset_items SET state='deleted',updated_at=clock_timestamp() WHERE run_id=%s AND kind='promotion'", (run_id,))
            cur.execute("UPDATE promotion_reset_runs SET state='db_deleted',db_deleted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE run_id=%s", (run_id,))
    # Committed DB deletion and marker survive any process failure below.
    for item in items:
        if item["kind"] != "object" or item["state"] in {"deleted", "missing", "needs_review"}:
            continue
        with repo.transaction() as cur:
            locked_run(cur, run_id, environment_id)
            cur.execute("UPDATE promotion_reset_runs SET state='cleaning',updated_at=clock_timestamp() WHERE run_id=%s", (run_id,))
            cur.execute("SELECT id FROM promotions WHERE organization_id=%s AND (id=%s OR image_url LIKE %s)",
                        (get_current_tenant_id(), item["promotion_id"], f"%{item['object_name']}%"))
            if cur.fetchone():
                raise RuntimeError("Reset image is referenced by a current promotion")
        try:
            images.delete_object(item["object_name"], item["storage_generation"])
        except Exception:
            with repo.transaction() as cur:
                cur.execute("UPDATE promotion_reset_items SET retry_count=retry_count+1,last_error_code='storage_unavailable',"
                            "updated_at=clock_timestamp() WHERE run_id=%s AND item_id=%s", (run_id, item["item_id"]))
            continue
        with repo.transaction() as cur:
            cur.execute("UPDATE promotion_reset_items SET state='deleted',last_error_code=NULL,updated_at=clock_timestamp() "
                        "WHERE run_id=%s AND item_id=%s", (run_id, item["item_id"]))
    with repo.transaction() as cur:
        locked_run(cur, run_id, environment_id)
        cur.execute("SELECT COUNT(*) AS count FROM promotion_reset_items WHERE run_id=%s AND state NOT IN ('deleted','missing')", (run_id,))
        remaining = cur.fetchone()["count"]
        if not remaining:
            cur.execute("UPDATE promotion_reset_runs SET state='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE run_id=%s", (run_id,))
    return {"run_id": run_id, "state": "cleaning" if remaining else "completed", "remaining": remaining}
