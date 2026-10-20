"""File operations for desired-piece reference scores and common images.

JST spec R05-A/R05-B/R06/R06-A (plan 6.5). Targets: desired_pieces reference
score, member photo, performance flyer, organization icon. Promotions and the
sheet library keep their own dedicated mechanisms (not changed here).

Order of one request (R05-B):
1. session / tenant / actor generation (``promotion_service.actor``: member
   ID + immutable member registration time), request syntax, file hash;
2. operation record match by (tenant, actor, operation ID). Same ID with a
   different fingerprint -> 409; same content and terminal -> the stored
   result (current result-view permission checked, the target row's current
   existence/version is *not* required);
3. one attempt gets the lease (compare-and-update takeover after expiry);
4. that attempt checks the current target, permission and expected version;
5. a ``staged`` asset row is committed *before* the upload (the upload
   never happens without a durable record);
6. upload to a UUID key with a create-only precondition, no DB lock held;
7. one transaction re-checks the attempt, applies the business row change,
   activates the new asset, retires the old one and stores the result;
8. old/abandoned files are deleted only by ``cleanup`` after commit, with
   reference/lease/grace checks, ``delete_pending`` first, and the exact
   generation. No prefix trim, no delete before the DB commit.

A commit whose acknowledgement is lost is re-read from the operation record
on a new connection; nothing is deleted on guesswork and no new operation ID
is created for a retry.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import mimetypes
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

from ..core.tenant_context import get_current_tenant_id
from ..repositories import portal_file_repository as repo
from ..utils.datetime_utils import format_instant

logger = logging.getLogger(__name__)

MAX_PDF_BYTES = 30 * 1024 * 1024
STAGED_GRACE = timedelta(hours=24)
RETIRED_GRACE = timedelta(minutes=15)
DELETED_RECHECK = timedelta(hours=24)
MAX_BACKOFF_SECONDS = 86400
REQUEST_HASH_VERSION = 1
RELOAD_MESSAGE = "画面を再読み込みしてから、もう一度操作してください"

DATA_IMAGE_RE = re.compile(r"^data:(image/[^;]+);base64,(.*)$", re.IGNORECASE | re.DOTALL)
IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
}


@dataclass(frozen=True)
class KindSpec:
    collection: str
    url_field: str
    route: Callable[[int], str]
    is_image: bool


KINDS: dict[str, KindSpec] = {
    "desired_piece_reference_score": KindSpec(
        "desired_pieces", "reference_score_url", lambda item_id: f"/api/extra/desired_pieces/{item_id}/reference_score", False
    ),
    "org_icon": KindSpec("org_settings", "icon_url", lambda item_id: f"/api/extra/org_settings/{item_id}/icon", True),
    "member_photo": KindSpec("members", "photo_url", lambda item_id: f"/api/members/{item_id}/photo", True),
    "performance_flyer": KindSpec(
        "performances", "flyer_image", lambda item_id: f"/api/performances/{item_id}/flyer-image", True
    ),
}
KIND_BY_COLLECTION = {spec.collection: kind for kind, spec in KINDS.items()}


@dataclass
class FileInput:
    content: bytes
    content_type: str
    ext: str
    filename: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.content).hexdigest()


@dataclass
class Tx:
    cur: Any
    ctx: Any


@dataclass
class FileOperation:
    """One file-bearing change. ``validate``/``apply`` run inside DB transactions."""

    kind: str
    method: str
    target_id: int | None
    action: str  # replace | remove | keep | delete
    file: FileInput | None
    fingerprint: dict[str, Any]
    validate: Callable[[Tx], None]
    apply: Callable[[Tx, "Applied"], tuple[int, dict[str, Any]]]
    view_scope: str = "owner"
    prepare_file: Callable[[FileInput], FileInput] | None = None


@dataclass
class Applied:
    """What ``apply`` receives: the new asset (if any) and helpers bound to the transaction."""

    op: dict[str, Any]
    asset_id: str | None
    generation: Any
    file: FileInput | None
    kind: str
    retired: list[str] = field(default_factory=list)

    def url_for(self, owner_id: int) -> str:
        spec = KINDS[self.kind]
        if not self.asset_id or self.file is None:
            return ""
        url = f"{spec.route(owner_id)}?asset={self.asset_id}"
        if spec.is_image:
            url += f"&ext={self.file.ext.lstrip('.')}"
        return url

    def commit_reference(self, tx: Tx, owner_id: int) -> None:
        """Retire the current active asset and activate the new one (same transaction)."""
        current = repo.active_asset(tx.cur, self.kind, owner_id, lock=True)
        if current and current["asset_id"] != self.asset_id:
            repo.retire(tx.cur, current["asset_id"])
            self.retired.append(current["asset_id"])
        if self.asset_id:
            repo.activate(tx.cur, self.op, self.asset_id, owner_id=owner_id, generation=self.generation)

    def retire_reference(self, tx: Tx, owner_id: int) -> None:
        current = repo.active_asset(tx.cur, self.kind, owner_id, lock=True)
        if current:
            repo.retire(tx.cur, current["asset_id"])
            self.retired.append(current["asset_id"])


# --------------------------------------------------------------------------- transactions


@contextmanager
def transaction() -> Iterator[Tx]:
    if repo.uses_local_store():
        with repo.local_transaction() as cur:
            yield Tx(cur=cur, ctx=None)
        return
    from ..core.compat_gateway import row_store

    store = row_store()
    with store.transaction() as ctx:
        assert ctx is not None  # Local mode returned through local_transaction above.
        yield Tx(cur=ctx.cur, ctx=ctx)


@contextmanager
def _savepoint(tx: Tx) -> Iterator[None]:
    # A deterministic rejection inside ``apply`` must undo partial business
    # writes while the rejection result itself still commits.
    tx.cur.execute("SAVEPOINT portal_file_apply")
    try:
        yield
    except Exception:
        tx.cur.execute("ROLLBACK TO SAVEPOINT portal_file_apply")
        raise
    tx.cur.execute("RELEASE SAVEPOINT portal_file_apply")


# --------------------------------------------------------------------------- inputs


def operation_id_from(key: Any) -> str:
    if key in (None, ""):
        raise HTTPException(status_code=428, detail={"code": "file_operation_key_required", "message": RELOAD_MESSAGE})
    try:
        return str(UUID(str(key)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise HTTPException(status_code=422, detail={"code": "file_operation_key_invalid", "message": RELOAD_MESSAGE}) from exc


async def read_pdf(file: Any) -> FileInput:
    filename = str(getattr(file, "filename", "") or "reference_score.pdf")
    if Path(filename).suffix.lower() != ".pdf":
        raise HTTPException(status_code=400, detail="Please upload a PDF file")
    data = bytearray()
    while True:
        chunk = await file.read(256 * 1024)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_PDF_BYTES:
            raise HTTPException(status_code=413, detail={"code": "reference_score_too_large", "message": "PDFは30MiB以下にしてください"})
    return FileInput(bytes(data), "application/pdf", ".pdf", filename)


async def read_image_upload(file: UploadFile) -> FileInput:
    filename = str(file.filename or "").strip()
    media_type = str(file.content_type or mimetypes.guess_type(filename)[0] or "").lower()
    if not media_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Please upload an image file")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Image file is empty")
    return FileInput(content, media_type, IMAGE_EXTENSIONS.get(media_type, ".png"), filename)


def read_data_image(value: str) -> FileInput:
    match = DATA_IMAGE_RE.match(str(value or "").strip())
    if not match:
        raise HTTPException(status_code=400, detail="Image payload must be a data URL")
    media_type = match.group(1).lower()
    try:
        content = base64.b64decode(match.group(2).strip(), validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid base64 image payload") from exc
    return FileInput(content, media_type, IMAGE_EXTENSIONS.get(media_type, ".png"), "")


def is_data_image(value: Any) -> bool:
    return bool(DATA_IMAGE_RE.match(str(value or "").strip()))


def has_upload(value: Any) -> bool:
    return value is not None and hasattr(value, "read")


# --------------------------------------------------------------------------- identity / results


def actor_key(device: dict[str, Any]) -> str:
    # Same identity rule as promotions/sheets: member ID + immutable member
    # registration time, so a recreated member never inherits results.
    from .promotion_service import actor

    return str(actor(device))


def public_actor_scope(device: dict[str, Any]) -> str:
    """Opaque tenant/account-generation scope, stable across re-login.

    Session timestamps are too narrow for durable pending operations: a fresh
    login of the same account must still be able to recover its old result.
    Neither the raw registration time nor the internal actor key is exposed.
    """
    return hashlib.sha256(json.dumps([get_current_tenant_id(), actor_key(device)]).encode()).hexdigest()


def _is_admin(device: dict[str, Any]) -> bool:
    return str(device.get("permission") or "") in {"管理者", "システム管理者"}


def _digest(spec: FileOperation) -> str:
    return hashlib.sha256(
        json.dumps(
            [REQUEST_HASH_VERSION, spec.kind, spec.method, spec.target_id, spec.action, spec.fingerprint,
             spec.file.sha256 if spec.file else None],
            sort_keys=True,
            ensure_ascii=False,
            default=str,
        ).encode()
    ).hexdigest()


def _result(op: dict[str, Any] | None, device: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    if not op or op["state"] == "processing":
        return 202, {"state": "processing", "code": "file_operation_processing", "message": "処理結果を確認しています"}
    if op.get("view_scope") == "admin" and not _is_admin(device):
        raise HTTPException(status_code=403, detail={"code": "file_operation_forbidden", "message": "この操作の結果は表示できません"})
    if op.get("result_body") is None:
        return 409, {"detail": {"code": "file_operation_expired", "message": "この操作の結果は保存期間を過ぎました。" + RELOAD_MESSAGE}}
    return int(op["result_status"]), op["result_body"]


def _current_result(actor: str, operation_id: str, device: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    with transaction() as tx:
        return _result(repo.operation(tx.cur, actor, operation_id, lock=False), device)


def operation_status(device: dict[str, Any], key: str) -> tuple[int, dict[str, Any]]:
    """Authenticated status query; never needs the original file or target row."""
    operation_id = operation_id_from(key)
    actor = actor_key(device)
    with transaction() as tx:
        op = repo.operation(tx.cur, actor, operation_id, lock=False)
    if op is None:
        return 404, {"state": "unknown", "code": "file_operation_unknown", "message": "この操作は受け付けられていません"}
    if op["state"] == "processing":
        return 202, {"state": "processing"}
    status, body = _result(op, device)
    return 200, {"state": op["state"], "result_status": status, "result_body": body}


def http_result(status: int, body: dict[str, Any]) -> JSONResponse:
    headers = {"Cache-Control": "no-store"}
    if status == 202:
        headers["Retry-After"] = "2"
    return JSONResponse(body, status_code=status, headers=headers)


# --------------------------------------------------------------------------- storage


def _storage_enabled() -> bool:
    from ..drive_storage import storage_enabled

    return bool(storage_enabled())


def _object_name(kind: str, asset_id: str, ext: str) -> str:
    return f"portal-files/{quote(get_current_tenant_id(), safe='')}/{kind}/{asset_id}{ext}"


def _local_path(object_name: str) -> Path:
    from ..core.compat_gateway import get_runtime_data_paths

    return get_runtime_data_paths()[1] / object_name


def _retry() -> Any:
    from google.api_core.retry import Retry

    return Retry(deadline=120)


def upload(object_name: str, file: FileInput) -> Any:
    """Create-only upload; returns the GCS generation (None locally)."""
    if _storage_enabled():
        from ..drive_storage import get_storage_bucket

        blob = get_storage_bucket().blob(object_name)
        blob.upload_from_string(
            file.content, content_type=file.content_type, if_generation_match=0, timeout=60, retry=_retry()
        )
        return blob.generation
    path = _local_path(object_name)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as target:  # exclusive create: never overwrite
        target.write(file.content)
    return None


def _read_bytes(stored: dict[str, Any]) -> bytes:
    if stored["source"] == "gcs":
        from ..drive_storage import get_storage_bucket

        generation = stored.get("storage_generation")
        blob = get_storage_bucket().blob(stored["object_name"], generation=int(generation) if generation else None)
        return bytes(blob.download_as_bytes(timeout=60, retry=_retry()))
    return _local_path(stored["object_name"]).read_bytes()


def _delete_object(stored: dict[str, Any]) -> None:
    """Delete exactly the recorded object/generation. Missing objects are success."""
    if stored["source"] == "gcs":
        from google.api_core.exceptions import NotFound

        from ..drive_storage import get_storage_bucket

        blob = get_storage_bucket().blob(stored["object_name"])
        generation = stored.get("storage_generation")
        try:
            if generation is None:
                blob.reload(timeout=60, retry=_retry())
                generation = blob.generation
            blob.delete(if_generation_match=int(generation), timeout=60, retry=_retry())
        except NotFound:
            return
        return
    path = _local_path(stored["object_name"])
    path.unlink(missing_ok=True)


def _object_exists(stored: dict[str, Any]) -> bool:
    if stored["source"] == "gcs":
        from ..drive_storage import get_storage_bucket

        return bool(get_storage_bucket().blob(stored["object_name"]).exists(timeout=60, retry=_retry()))
    return _local_path(stored["object_name"]).exists()


# --------------------------------------------------------------------------- runner


async def run(spec: FileOperation, device: dict[str, Any], key: Any, *, actor: str | None = None) -> tuple[int, dict[str, Any]]:
    """Run one file operation. ``actor`` is only for internal migration runs
    (``migration:<run_id>``); user requests always derive it from the session."""
    operation_id = operation_id_from(key)
    actor = actor or actor_key(device)
    digest = _digest(spec)
    op: dict[str, Any] | None = None
    asset_id: str | None = None
    generation: Any = None
    try:
        with transaction() as tx:
            op, claimed, conflict = repo.reserve(
                tx.cur, actor_key=actor, operation_id=operation_id, kind=spec.kind, method=spec.method,
                target_id=spec.target_id, view_scope=spec.view_scope, digest=digest,
            )
        if conflict:
            return 409, {"detail": {"code": "file_operation_conflict", "message": "同じ操作IDで別の内容が送られました。" + RELOAD_MESSAGE}}
        if not claimed:
            return _result(op, device)
        # Deterministic rejections are stored only while this attempt owns the lease.
        with transaction() as tx:
            repo.require_attempt(tx.cur, op)
            try:
                spec.validate(tx)
            except HTTPException as error:
                body = {"detail": error.detail}
                repo.finish(tx.cur, op, error.status_code, body)
                return error.status_code, body
        stored_file = spec.file
        if stored_file is not None and spec.kind == "member_photo" and spec.prepare_file is not None:
            # Digest/replay above always uses the ORIGINAL bytes (including
            # pre-deploy retries). Only the stored member portrait is resized.
            from starlette.concurrency import run_in_threadpool
            try:
                stored_file = await run_in_threadpool(spec.prepare_file, stored_file)
            except HTTPException as error:
                with transaction() as tx:
                    repo.require_attempt(tx.cur, op)
                    repo.finish(tx.cur, op, error.status_code, {"detail": error.detail})
                return error.status_code, {"detail": error.detail}
        if stored_file is not None:
            asset_id = str(uuid4())
            object_name = _object_name(spec.kind, asset_id, stored_file.ext)
            if spec.kind == "member_photo" and spec.prepare_file is not None and stored_file.filename == "member-photo-v1.webp":
                # Versioned namespace proves normalization; a user's original
                # filename alone must never make a legacy image look converted.
                prefix, leaf = object_name.rsplit("/", 1)
                object_name = f"{prefix}/v1/{leaf}"
            with transaction() as tx:
                repo.require_attempt(tx.cur, op)
                repo.stage_asset(
                    tx.cur, op, kind=spec.kind, owner_id=spec.target_id, object_name=object_name, asset_id=asset_id,
                    source="gcs" if _storage_enabled() else "local", filename=stored_file.filename,
                    content_type=stored_file.content_type, byte_size=len(stored_file.content), sha256=stored_file.sha256,
                )
            generation = upload(object_name, stored_file)
        applied = Applied(op=op, asset_id=asset_id, generation=generation, file=stored_file, kind=spec.kind)
        with transaction() as tx:
            repo.require_attempt(tx.cur, op)
            try:
                with _savepoint(tx):
                    status, body = spec.apply(tx, applied)
            except HTTPException as error:
                status, body = error.status_code, {"detail": error.detail}
            repo.finish(tx.cur, op, status, body)
        if status >= 400 and asset_id:
            _abandon(op, asset_id, generation)
        return status, body
    except repo.LostAttempt:
        if asset_id and op:
            _abandon(op, asset_id, generation)
        return _current_result(actor, operation_id, device)
    except HTTPException:
        raise
    except Exception:
        # The commit acknowledgement may be lost: read the durable result on a
        # new connection before giving the lease back. Never delete a file of
        # a possibly committed operation.
        logger.warning("File operation %s needs a retry with the same key", spec.kind, exc_info=True)
        try:
            status, body = _current_result(actor, operation_id, device)
            if status != 202:
                return status, body
            if op:
                with transaction() as tx:
                    repo.release(tx.cur, op)
            if asset_id and op:
                _abandon(op, asset_id, generation)
        except Exception:
            logger.warning("File operation state could not be confirmed")
        return 503, {"detail": {"code": "file_operation_retry_same_key", "message": "処理結果を確認できません。同じ操作をもう一度送ってください"}}


def _abandon(op: dict[str, Any], asset_id: str, generation: Any) -> None:
    try:
        with transaction() as tx:
            repo.abandon(tx.cur, op, asset_id, generation)
    except Exception:
        logger.warning("Staged file deferred for reconciliation")


# --------------------------------------------------------------------------- internal migration


MIGRATION_NAMESPACE = UUID("6f1d0c7a-3b2e-4c55-9a1e-2d6b9c0f4e11")


def migration_operation_id(run_id: str, kind: str, owner_id: int) -> str:
    """Deterministic per run/item so a re-run joins the same operation (idempotent)."""
    from uuid import uuid5

    return str(uuid5(MIGRATION_NAMESPACE, f"{run_id}:{kind}:{owner_id}"))


async def migrate_inline_image(kind: str, owner_id: int, expected_value: str, *, run_id: str) -> tuple[int, dict[str, Any]]:
    """Move a legacy inline data-URL image of one row to a confirmed asset.

    Internal operation of a migration run (not a user request): the actor is
    ``migration:<run_id>`` and the result is kept in the operation record as
    an audit trail. The row is changed only while it still holds
    ``expected_value`` (stale-value guard); otherwise the run stops for that
    row with 409.
    """
    spec = KINDS[kind]
    file = read_data_image(expected_value)
    from ..core.compat_gateway import row_store

    def validate(tx: Tx) -> None:
        current = row_store().get(spec.collection, owner_id, ctx=tx.ctx, lock=True)
        if current is None:
            raise HTTPException(status_code=404, detail="Data not found")
        if str(current.get(spec.url_field) or "") != expected_value:
            raise HTTPException(status_code=409, detail="The stored value changed; re-run the dry-run")

    def apply(tx: Tx, applied: Applied) -> tuple[int, dict[str, Any]]:
        saved = row_store().update_columns(
            spec.collection, owner_id, {spec.url_field: applied.url_for(owner_id)},
            where={spec.url_field: expected_value}, ctx=tx.ctx,
        )
        if saved is None:
            raise HTTPException(status_code=409, detail="The stored value changed; re-run the dry-run")
        applied.commit_reference(tx, owner_id)
        return 200, {"collection": spec.collection, "id": owner_id, "field": spec.url_field, "to": saved.get(spec.url_field)}

    return await run(
        FileOperation(
            kind=kind, method="PUT", target_id=owner_id, action="replace", file=file,
            fingerprint={"expected_sha256": hashlib.sha256(expected_value.encode()).hexdigest()},
            validate=validate, apply=apply, view_scope="admin",
        ),
        # The run itself is the (system) viewer of its own audit results.
        {"permission": "システム管理者", "migration_run": run_id},
        migration_operation_id(run_id, kind, owner_id),
        actor=f"migration:{run_id}",
    )


# --------------------------------------------------------------------------- delivery


def has_active_asset(kind: str, owner_id: Any) -> bool:
    with transaction() as tx:
        return repo.active_asset(tx.cur, kind, owner_id) is not None


def deliver(kind: str, owner_id: int, requested_asset: str | None, *, inline_value: str = "") -> Response:
    """Serve only DB-confirmed content (R06-5). No latest-candidate search."""
    spec = KINDS[kind]
    if not requested_asset and is_data_image(inline_value):
        # Legacy inline data stored in the DB row itself is DB-confirmed.
        file = read_data_image(inline_value)
        return Response(content=file.content, media_type=file.content_type, headers={"Cache-Control": "no-cache"})
    try:
        with transaction() as tx:
            if requested_asset:
                try:
                    asset_id = str(UUID(str(requested_asset)))
                except ValueError as exc:
                    raise HTTPException(status_code=404, detail="File not found") from exc
                stored = repo.asset(tx.cur, asset_id, lock=True)
                # Version-pinned URL: keep serving that version while it is
                # still retained (active or within the retired grace period).
                if not stored or stored["kind"] != kind or int(stored.get("owner_id") or 0) != int(owner_id) or stored["state"] not in {"active", "retired"}:
                    raise HTTPException(status_code=404, detail="File not found")
            else:
                stored = repo.active_asset(tx.cur, kind, owner_id, lock=True)
                if not stored:
                    raise HTTPException(status_code=404, detail="File not found")
            # Commit the read protection before storage I/O. Cleanup takes the
            # same row lock and re-checks this deadline even for a candidate it
            # selected earlier. Retirement must never reset this protection.
            repo.protect_asset_read(tx.cur, stored["asset_id"])
        content = _read_bytes(stored)
    except HTTPException:
        raise
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="File not found") from exc
    except Exception as exc:
        try:
            from google.api_core.exceptions import NotFound

            if isinstance(exc, NotFound):
                raise HTTPException(status_code=404, detail="File not found") from exc
        except ImportError:  # pragma: no cover
            pass
        logger.exception("File delivery failed")
        raise HTTPException(status_code=503, detail="File temporarily unavailable") from exc
    headers = {"Cache-Control": "private, max-age=3600" if requested_asset else "no-cache"}
    if not spec.is_image:
        filename = stored.get("filename") or "reference_score.pdf"
        headers["Content-Disposition"] = f"inline; filename*=UTF-8''{quote(filename)}"
    return Response(content=content, media_type=stored["content_type"], headers=headers)


# --------------------------------------------------------------------------- reconciliation


def cleanup(limit: int = 100, execute: bool = False) -> dict[str, Any]:
    """Reclaim abandoned/retired files of the current tenant (dry-run unless ``execute``).

    Order per asset: re-check reference/lease/grace under the asset lock ->
    mark ``delete_pending`` (commit) -> delete the exact object/generation ->
    record ``deleted`` and schedule one late re-check for delayed uploads.
    """
    with transaction() as tx:
        now = repo.db_now(tx.cur)
        candidates = repo.reconcile_candidates(tx.cur, now, limit)
        expired_results = repo.expire_results(tx.cur, now) if execute else 0
    decisions: list[dict[str, Any]] = []
    for candidate in candidates:
        with transaction() as tx:
            stored = repo.asset(tx.cur, candidate["asset_id"], lock=True)
            if not stored:
                continue
            now = repo.db_now(tx.cur)
            op = repo.operation(tx.cur, stored["actor_key"], stored["operation_id"], lock=False)
            reason = _reclaim_reason(stored, op, now)
            decisions.append({"asset_id": stored["asset_id"], "state": stored["state"], "decision": reason})
            if reason != "reclaim" or not execute:
                if execute and reason not in {"reclaim", "done"}:
                    tx.cur.execute(
                        "UPDATE portal_file_assets SET next_attempt_at=%s,last_checked_at=clock_timestamp() WHERE organization_id=%s AND asset_id=%s",
                        (now + RETIRED_GRACE, get_current_tenant_id(), stored["asset_id"]),
                    )
                continue
            if stored["state"] != "deleted":
                tx.cur.execute(
                    "UPDATE portal_file_assets SET state='delete_pending',last_checked_at=clock_timestamp() WHERE organization_id=%s AND asset_id=%s",
                    (get_current_tenant_id(), stored["asset_id"]),
                )
        if reason != "reclaim" or not execute:
            continue
        error = None
        try:
            if stored["state"] == "deleted":
                if _object_exists(stored):
                    _delete_object({**stored, "storage_generation": None})
            else:
                _delete_object(stored)
        except Exception as exc:  # noqa: BLE001 - recorded and retried
            error = "storage_unavailable" if "Precondition" not in type(exc).__name__ else "generation_changed"
        with transaction() as tx:
            current = repo.asset(tx.cur, stored["asset_id"], lock=True)
            if not current or current["state"] not in {"delete_pending", "deleted"}:
                continue
            now = repo.db_now(tx.cur)
            retry = int(current.get("retry_count") or 0) + (1 if error else 0)
            if error:
                next_time = now + timedelta(seconds=min(MAX_BACKOFF_SECONDS, 60 * 2 ** min(retry, 11)))
                state, deleted_at = "delete_pending", current.get("deleted_at")
            elif current["state"] == "deleted":
                next_time, state, deleted_at = None, "deleted", current.get("deleted_at")
            else:
                # One delayed re-check catches an upload that finished after deletion.
                next_time, state, deleted_at = now + DELETED_RECHECK, "deleted", now
            tx.cur.execute(
                "UPDATE portal_file_assets SET state=%s,deleted_at=%s,next_attempt_at=%s,retry_count=%s,last_error_code=%s,"
                "last_checked_at=clock_timestamp() WHERE organization_id=%s AND asset_id=%s",
                (state, deleted_at, next_time, retry, error, get_current_tenant_id(), stored["asset_id"]),
            )
    return {"candidates": decisions, "expired_results": expired_results, "executed": execute}


def _reclaim_reason(stored: dict[str, Any], op: dict[str, Any] | None, now: Any) -> str:
    state = stored["state"]
    if state == "active":
        return "active"
    if stored.get("read_protected_until") and repo.as_instant(stored["read_protected_until"]) > now:
        return "read-protected"
    if state == "deleted":
        return "reclaim" if stored.get("next_attempt_at") else "done"
    if op and op["state"] == "processing" and repo.as_instant(op["lease_until"]) > now and state == "staged":
        # Lease expiry alone does not prove the old upload stopped; a live
        # lease certainly means it may still be running.
        return "operation-live"
    if state == "staged" and repo.as_instant(stored["created_at"]) + STAGED_GRACE > now:
        return "grace"
    if state == "retired" and stored.get("retired_at") and repo.as_instant(stored["retired_at"]) + RETIRED_GRACE > now:
        return "grace"
    return "reclaim"


def public_time(value: Any) -> str:
    return format_instant(repo.as_instant(value)) if value else ""


# --------------------------------------------------------------------------- legacy reference migration (S17)

LEGACY_IMAGE_PREFIXES = {
    "member_photo": "member-images/{id}/photo",
    "performance_flyer": "performance-flyers/{id}/flyer",
    "org_icon": "org-settings/{id}/icon",
}


def legacy_object_identity(object_name: str) -> dict[str, Any] | None:
    """Current identity (source, generation, size) of an existing legacy object, or None."""
    if _storage_enabled():
        from ..drive_storage import get_storage_bucket

        blob = get_storage_bucket().get_blob(object_name, timeout=60)
        if blob is None:
            return None
        return {"source": "gcs", "generation": blob.generation, "byte_size": int(blob.size or 0), "content_type": blob.content_type}
    path = _local_path(object_name)
    if not path.is_file():
        return None
    return {"source": "local", "generation": None, "byte_size": path.stat().st_size, "content_type": mimetypes.guess_type(path.name)[0]}


def register_legacy_asset(
    kind: str,
    owner_id: int,
    *,
    db_value: str,
    object_name: str,
    generation: Any,
    evidence: str,
    run_id: str,
) -> tuple[int, dict[str, Any]]:
    """Fix the confirmed reference of one legacy file from a *confirmed* manifest entry.

    Spec R06/C03: a single candidate is not proof. The operator records the
    evidence (old DB value, owner, key/generation, known committed operation);
    this function only re-verifies that nothing changed since: the row still
    holds ``db_value``, no active asset exists, and the object still has the
    recorded generation. Nothing is deleted or rewritten in storage.
    """
    if not evidence.strip():
        return 409, {"detail": "evidence is required"}
    spec = KINDS[kind]
    identity = legacy_object_identity(object_name)
    if identity is None:
        return 409, {"detail": "legacy object not found"}
    if identity["source"] == "gcs" and str(identity["generation"]) != str(generation):
        return 409, {"detail": "legacy object generation changed"}
    from ..core.compat_gateway import row_store

    actor = f"migration:{run_id}"
    operation_id = migration_operation_id(run_id, kind, owner_id)
    asset_id = str(uuid4())
    with transaction() as tx:
        current = row_store().get(spec.collection, owner_id, ctx=tx.ctx, lock=True)
        if current is None or str(current.get(spec.url_field) or "") != db_value:
            return 409, {"detail": "the row changed after the manifest was made"}
        if repo.active_asset(tx.cur, kind, owner_id, lock=True) is not None:
            return 409, {"detail": "a confirmed asset already exists"}
        op, claimed, conflict = repo.reserve(
            tx.cur, actor_key=actor, operation_id=operation_id, kind=kind, method="PUT",
            target_id=owner_id, view_scope="admin", digest=hashlib.sha256(f"{object_name}:{generation}".encode()).hexdigest(),
        )
        if conflict or not claimed:
            return 409, {"detail": "this run already handled the owner"}
        content_type = identity.get("content_type") or ("application/pdf" if kind == "desired_piece_reference_score" else "image/png")
        tx.cur.execute(
            "INSERT INTO portal_file_assets (asset_id,organization_id,kind,owner_id,actor_key,operation_id,attempt_id,object_name,"
            "source,filename,content_type,byte_size,sha256,storage_generation,state,legacy,legacy_evidence,created_at,activated_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'',%s,'active',TRUE,%s::jsonb,clock_timestamp(),clock_timestamp())",
            (asset_id, get_current_tenant_id(), kind, owner_id, actor, operation_id, op["attempt_id"], object_name,
             identity["source"], Path(object_name).name, content_type, identity["byte_size"], generation,
             json.dumps({"evidence": evidence, "db_value": db_value, "run_id": run_id}, ensure_ascii=False)),
        )
        body = {"kind": kind, "owner_id": owner_id, "asset_id": asset_id, "object_name": object_name}
        repo.finish(tx.cur, op, 200, body)
    return 200, body
