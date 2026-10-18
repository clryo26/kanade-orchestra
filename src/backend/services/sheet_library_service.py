"""Sheet library: row-level, idempotent operations (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md).

- IDs come from the database; changes and deletions name the revision the
  user saw, so another device's change is never overwritten silently.
- Every operation has an operation ID. A resend of the same request returns
  the stored result; another request under the same ID is a conflict. A
  revision conflict (another operation changed the row) is reported apart.
- Files are uploaded first; the DB row, the file record and the list version
  are committed in one transaction afterwards. Nothing here sends a push
  notification (sheet changes are not member notifications).
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, cast
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

from ..repositories import sheet_repository as repo
from . import sheet_storage_service as storage
from .file_service import safe_upload_name

logger = logging.getLogger(__name__)

MAX_PDF_BYTES = 30 * 1024 * 1024  # Cloud Run limits a request body to 32 MiB (HTTP/1)
MAX_BULK_ITEMS = 500
RELOAD_MESSAGE = "画面を再読み込みしてから、もう一度操作してください"


def failure(status: int, code: str, message: str, **extra: Any) -> tuple[int, dict[str, Any]]:
    return status, {"detail": {"code": code, "message": message, **extra}}


# ----- read model ----------------------------------------------------------------------


def public(item: dict[str, Any]) -> dict[str, Any]:
    """The client-facing record. URLs are the same as before the migration
    (legacy objects keep their paths); new objects use the same routes."""
    out = {key: repo.iso(item.get(key)) for key in repo.LIST_COLUMNS if key not in {"storage_generation", "sha256"}}
    out["file_id"] = str(item["file_id"]) if item.get("file_id") else None
    out["size"] = item.get("size_bytes")
    out["modified_at"] = repo.iso(item.get("updated_at") or item.get("created_at"))
    out["revision"] = int(item.get("revision") or 1)
    if item.get("source") == "google_cloud_storage" and item.get("object_name"):
        encoded = quote(str(item["object_name"]), safe="/")
        out["url"] = f"/api/sheets/cloud/view/{encoded}"
        out["download_url"] = f"/api/sheets/cloud/download/{encoded}"
    elif item.get("path"):
        encoded = quote(str(item["path"]), safe="/")
        out["url"] = f"/api/sheets/view/{encoded}"
        out["download_url"] = f"/api/sheets/download/{encoded}"
    else:
        out["url"] = out["download_url"] = ""
    out["view_url"] = out["url"]
    return out


def list_payload() -> dict[str, Any]:
    try:
        version, rows = repo.snapshot()
    except Exception as exc:
        raise HTTPException(503, detail={"code": "sheet_unavailable", "message": "楽譜一覧を取得できません。再試行してください"}) from exc
    return {"files": [public(item) for item in rows], "list_version": version}


def version_payload() -> dict[str, Any]:
    from . import meta_service
    try:
        # release: lets a screen loaded before a deployment show a notice.
        return {"list_version": repo.current_version(), "release": meta_service.cloud_run_revision()}
    except Exception as exc:
        raise HTTPException(503, detail={"code": "sheet_unavailable", "message": "楽譜一覧を確認できません"}) from exc


def file_for_object(source: str, name: str) -> dict[str, Any]:
    """A published sheet of the current organization for this object/path."""
    with repo.transaction(read_only_snapshot=True) as cur:
        if source == "google_cloud_storage":
            cur.execute("SELECT * FROM sheet_library WHERE organization_id=%s AND source='google_cloud_storage' "
                        "AND object_name=%s ORDER BY id DESC LIMIT 1", (repo.tenant(), name))
        else:
            cur.execute("SELECT * FROM sheet_library WHERE organization_id=%s AND source<>'google_cloud_storage' "
                        "AND path=%s ORDER BY id DESC LIMIT 1", (repo.tenant(), name))
        item = cur.fetchone()
    if not item:
        raise HTTPException(404, detail="File not found")
    return cast(dict[str, Any], item)


def sheet_by_id(sheet_id: int) -> dict[str, Any] | None:
    with repo.transaction(read_only_snapshot=True) as cur:
        return repo.row(cur, sheet_id)


# ----- operations ----------------------------------------------------------------------


def actor_key(device: dict[str, Any]) -> str:
    # Same identity rule as promotions (member ID + member birth, or the
    # hidden system administrator), so a recreated member never inherits keys.
    from .promotion_service import actor
    return str(actor(device))


def operation_key(key: Any, *, legacy_ok: bool = False) -> tuple[str, bool]:
    if key in (None, "") and legacy_ok:
        # Screens loaded before this release send no key; they get a fresh one
        # (no resend protection for them, but still a row-level insert).
        return str(uuid4()), True
    if key in (None, ""):
        # A change from a screen loaded before this release (no operation ID,
        # no revisions): it must reload instead of writing blindly.
        raise HTTPException(428, detail=RELOAD_MESSAGE)
    try:
        return str(UUID(str(key))), False
    except (TypeError, ValueError, AttributeError) as exc:
        raise HTTPException(422, detail=RELOAD_MESSAGE) from exc


def digest(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def stored_result(actor: str, operation_id: str) -> tuple[int, dict[str, Any]]:
    with repo.transaction() as cur:
        op = repo.operation(cur, actor, operation_id, lock=False)
    if op and op["state"] != "processing":
        return int(op["result_status"]), op["result_body"]
    return 202, {"state": "processing", "code": "sheet_processing", "message": "処理結果を確認しています。同じ操作をもう一度送ってください"}


def operation_status(device: dict[str, Any], operation_id: str) -> tuple[int, dict[str, Any]]:
    key, _ = operation_key(operation_id)
    with repo.transaction() as cur:
        op = repo.operation(cur, actor_key(device), key, lock=False)
    if not op:
        return 404, {"state": "unknown", "code": "sheet_operation_unknown", "message": "この操作は受け付けられていません"}
    if op["state"] == "processing":
        return 202, {"state": "processing"}
    return 200, {"state": op["state"], "result_status": op["result_status"], "result_body": op["result_body"]}


def _run(kind: str, actor: str, operation_id: str, request_hash: str, apply) -> tuple[int, dict[str, Any]]:
    """Reserve -> apply (fenced by the attempt) -> finish. apply(op) returns
    (status, body) and must itself commit inside repo.transaction with
    require_attempt + finish."""
    op = None
    try:
        op, claimed, conflict = repo.reserve(actor, operation_id, kind, request_hash)
        if conflict:
            return failure(409, "sheet_operation_conflict", "同じ操作IDで別の内容が送られました。画面を再読み込みしてください")
        if not claimed:
            return stored_result(actor, operation_id)
        return cast(tuple[int, dict[str, Any]], apply(op))
    except repo.LostAttempt:
        return stored_result(actor, operation_id)
    except HTTPException:
        raise
    except Exception:
        # The commit acknowledgement may be lost: look at the durable result
        # on a new connection before giving the attempt back.
        logger.warning("Sheet operation %s needs a retry with the same key", kind, exc_info=True)
        try:
            status, body = stored_result(actor, operation_id)
            if status != 202:
                return status, body
            if op:
                repo.release(op)
        except Exception:
            pass
        return failure(503, "sheet_retry_same_operation", "処理結果を確認できません。同じ操作をもう一度送ってください")


async def read_pdf(file: UploadFile) -> bytes:
    if not str(file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, detail="PDFファイルを選択してください")
    data = bytearray()
    while True:
        chunk = await file.read(256 * 1024)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_PDF_BYTES:
            raise HTTPException(413, detail={"code": "sheet_too_large", "message": "PDFは30MiB以下にしてください"})
    if not data:
        raise HTTPException(422, detail={"code": "sheet_empty", "message": "PDFファイルが空です"})
    if not bytes(data[:1024]).lstrip().startswith(b"%PDF-"):
        raise HTTPException(415, detail={"code": "sheet_not_pdf", "message": "PDFファイルとして読み取れません"})
    return bytes(data)


async def upload(file: UploadFile, fields: dict[str, Any], device: dict[str, Any], key: Any) -> tuple[int, dict[str, Any]]:
    operation_id, legacy = operation_key(key, legacy_ok=True)
    performance_id = str(fields.get("performance_id") or "").strip()
    piece = str(fields.get("piece") or "").strip()
    performance_title = str(fields.get("performance_title") or "").strip()
    if not performance_id or not performance_id.isdigit():
        raise HTTPException(400, detail="performance_id is required")
    if not piece:
        raise HTTPException(400, detail="piece is required")
    content = await read_pdf(file)
    name = safe_upload_name(file.filename or "score.pdf")
    # UploadFile reading is async, but publication uses synchronous DB/GCS
    # clients (including actor lookup). Keep that entire phase off the loop.
    return cast(tuple[int, dict[str, Any]], await run_in_threadpool(
        _store_upload, content, name, performance_id, piece, performance_title, device, operation_id, legacy))


def _store_upload(content: bytes, name: str, performance_id: str, piece: str, performance_title: str,
                  device: dict[str, Any], operation_id: str, legacy: bool) -> tuple[int, dict[str, Any]]:
    sha = hashlib.sha256(content).hexdigest()
    actor = actor_key(device)
    request_hash = digest("upload", performance_id, performance_title, piece, name, len(content), sha)

    def apply(op):
        file_id = str(uuid4())
        source = storage.source_kind()
        object_name = storage.new_object_name(file_id)
        with repo.transaction() as cur:
            repo.require_attempt(cur, op)
            if not _performance_exists(cur, int(performance_id)):
                body = {"detail": {"code": "sheet_performance_missing", "message": "演奏会が見つかりません"}}
                repo.finish(cur, op, 404, body)
                return 404, body
            cur.execute("INSERT INTO sheet_files (file_id,organization_id,actor_key,operation_id,attempt_id,source,object_name,"
                        "byte_size,sha256,legacy,state,created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,FALSE,'staged',clock_timestamp())",
                        (file_id, repo.tenant(), op["actor_key"], str(op["operation_id"]), str(op["attempt_id"]), source,
                         object_name, len(content), sha))
        # Outside the DB transaction; the staged record lets the cleanup
        # remove the object if nothing below commits.
        generation = storage.upload_new(object_name, content)
        with repo.transaction() as cur:
            repo.require_attempt(cur, op)
            staged = repo.file_record(cur, file_id, lock=True)
            if not staged or staged["state"] != "staged":
                raise repo.LostAttempt()
            now = repo.db_now(cur)
            columns = ("organization_id,performance_id,performance_title,piece,part,source,name,path,object_name,size_bytes,"
                       "mime_type,created_at,updated_at,revision,file_id,storage_generation,sha256")
            cur.execute(f"INSERT INTO sheet_library ({columns}) VALUES (%s,%s,%s,%s,'',%s,%s,%s,%s,%s,'application/pdf',%s,%s,1,%s,%s,%s) "
                        "RETURNING id",
                        (repo.tenant(), int(performance_id), performance_title, piece, source, name,
                         object_name if source == "local" else "", object_name if source != "local" else "",
                         len(content), now, now, file_id, generation, sha))
            sheet_id = cur.fetchone()["id"]
            cur.execute("UPDATE sheet_files SET state='active',sheet_id=%s,storage_generation=%s WHERE organization_id=%s "
                        "AND file_id=%s AND state='staged' AND attempt_id=%s RETURNING file_id",
                        (sheet_id, generation, repo.tenant(), file_id, str(op["attempt_id"])))
            if not cur.fetchone():
                raise repo.LostAttempt()
            version = repo.bump_version(cur)
            body = {"file": public(repo.row(cur, sheet_id)), "list_version": version, "operation_id": str(op["operation_id"])}
            repo.finish(cur, op, 200, body)
        return 200, body

    status, body = _run("upload", actor, operation_id, request_hash, apply)
    if legacy and status == 200:
        # Screens loaded before this release read the bare record.
        return status, body["file"]
    return status, body


def _performance_exists(cur, performance_id: int) -> bool:
    if repo.local_json_fallback_enabled():
        # Local development keeps performances in the local data files.
        from .storage_service import load_json_data
        return any(str(p.get("id")) == str(performance_id) for p in load_json_data("performances"))
    cur.execute("SELECT 1 AS ok FROM performances WHERE organization_id=%s AND id=%s", (repo.tenant(), performance_id))
    return cur.fetchone() is not None


def _items(raw: Any) -> list[tuple[int, int]]:
    if not isinstance(raw, list) or not raw:
        raise HTTPException(428, detail=RELOAD_MESSAGE)
    if len(raw) > MAX_BULK_ITEMS:
        raise HTTPException(422, detail={"code": "sheet_too_many", "message": f"一度に操作できるのは{MAX_BULK_ITEMS}件までです"})
    out: list[tuple[int, int]] = []
    for entry in raw:
        try:
            sheet_id = int(entry["id"])
            revision = int(entry["expected_revision"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(428, detail=RELOAD_MESSAGE) from exc
        if sheet_id <= 0 or revision <= 0:
            raise HTTPException(428, detail=RELOAD_MESSAGE)
        out.append((sheet_id, revision))
    if len({sheet_id for sheet_id, _ in out}) != len(out):
        raise HTTPException(422, detail="同じ楽譜が重複しています")
    return sorted(out)


def _check(cur, items: list[tuple[int, int]]) -> tuple[dict[int, dict[str, Any]], dict[str, Any] | None]:
    """All-or-nothing: every row must exist with the revision the user saw."""
    found = repo.rows_locked(cur, [sheet_id for sheet_id, _ in items])
    missing = [sheet_id for sheet_id, _ in items if sheet_id not in found]
    changed = [sheet_id for sheet_id, revision in items if sheet_id in found and int(found[sheet_id]["revision"]) != revision]
    if missing or changed:
        return found, {"detail": {"code": "sheet_revision_conflict",
                                  "message": "ほかの端末で楽譜が変更または削除されています。一覧を更新して確認してください",
                                  "missing_ids": missing, "changed_ids": changed}}
    return found, None


def set_parts(raw: dict[str, Any], device: dict[str, Any], key: Any, *, kind: str) -> tuple[int, dict[str, Any]]:
    operation_id, _ = operation_key(key)
    part = str(raw.get("part") or "").strip()
    if len(part) > 100:
        raise HTTPException(422, detail="パート名が長すぎます")
    if kind == "bulk_part" and not part:
        raise HTTPException(400, detail="part is required")
    items = _items(raw.get("items"))
    actor = actor_key(device)
    request_hash = digest(kind, items, part)

    def apply(op):
        with repo.transaction() as cur:
            repo.require_attempt(cur, op)
            _, conflict = _check(cur, items)
            if conflict:
                repo.finish(cur, op, 409, conflict)
                return 409, conflict
            for sheet_id, revision in items:
                cur.execute("UPDATE sheet_library SET part=%s,revision=revision+1,updated_at=clock_timestamp() "
                            "WHERE organization_id=%s AND id=%s AND revision=%s", (part, repo.tenant(), sheet_id, revision))
            version = repo.bump_version(cur)
            files = [public(repo.row(cur, sheet_id)) for sheet_id, _ in items]
            body = {"files": files, "updated_count": len(files), "list_version": version, "operation_id": str(op["operation_id"])}
            repo.finish(cur, op, 200, body)
        return 200, body

    return _run(kind, actor, operation_id, request_hash, apply)


def delete(raw: dict[str, Any], device: dict[str, Any], key: Any) -> tuple[int, dict[str, Any]]:
    operation_id, _ = operation_key(key)
    items = _items(raw.get("items"))
    actor = actor_key(device)
    request_hash = digest("delete", items)

    def apply(op):
        with repo.transaction() as cur:
            repo.require_attempt(cur, op)
            found, conflict = _check(cur, items)
            if conflict:
                repo.finish(cur, op, 409, conflict)
                return 409, conflict
            for sheet_id, revision in items:
                file_id = repo.ensure_file(cur, found[sheet_id])
                cur.execute("DELETE FROM sheet_library WHERE organization_id=%s AND id=%s AND revision=%s",
                            (repo.tenant(), sheet_id, revision))
                # The object goes only after the grace period, without leases
                # and when no other row refers to it (cleanup).
                repo.retire_file(cur, file_id)
            version = repo.bump_version(cur)
            body = {"deleted": len(items), "deleted_ids": [sheet_id for sheet_id, _ in items],
                    "list_version": version, "operation_id": str(op["operation_id"])}
            repo.finish(cur, op, 200, body)
        return 200, body

    return _run("delete", actor, operation_id, request_hash, apply)
