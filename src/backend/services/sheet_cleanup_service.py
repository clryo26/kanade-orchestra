"""Cleanup of sheet storage (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md, section 2).

All state is in the DB, so a cleanup that stopped half way (restart, outage)
continues on the next run. A file is deleted only when, under its row lock:
- it is not active and no sheet_library row of any organization refers to its
  object or path (legacy rows may share an object),
- it has no unexpired lease (ZIP building), and
- the grace period after retirement has passed (views/downloads in flight),
  or, for a staged upload, the operation's lease has expired and 24 hours have
  passed since staging.
Deletion uses the recorded generation, so a newer object under the same name
is never removed. A retry only repeats the same file IDs (no wider scope).
"""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from ..drive_storage import get_storage_bucket
from ..repositories import sheet_repository as repo
from . import sheet_storage_service as storage

logger = logging.getLogger(__name__)

RETIRED_GRACE = timedelta(minutes=15)
STAGED_GRACE = timedelta(hours=24)
ABANDONED_JOB = timedelta(minutes=30)
OPERATION_RETENTION = timedelta(days=30)
MAX_BACKOFF_SECONDS = 86400


def _candidates(limit: int) -> list[dict[str, Any]]:
    with repo.transaction(read_only_snapshot=True) as cur:
        cur.execute("SELECT file_id FROM sheet_files WHERE organization_id=%s AND state IN ('staged','retired','delete_pending') "
                    "AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()) "
                    "ORDER BY COALESCE(last_checked_at, created_at), file_id LIMIT %s", (repo.tenant(), limit))
        return list(cur.fetchall())


def _eligible(cur, stored: dict[str, Any]) -> str | None:
    """None when the file may be deleted now, else the reason to keep it."""
    now = repo.db_now(cur)
    if stored["state"] == "active":
        return "active"
    if repo.live_lease(cur, str(stored["file_id"])):
        return "leased"
    if repo.object_referenced(cur, stored["source"], stored["object_name"]):
        return "referenced"
    if stored["state"] == "retired" and stored.get("retired_at") and repo.as_datetime(stored["retired_at"]) + RETIRED_GRACE > now:
        return "grace"
    if stored["state"] == "staged":
        if repo.as_datetime(stored["created_at"]) + STAGED_GRACE > now:
            return "grace"
        if stored.get("operation_id"):
            op = repo.operation(cur, stored["actor_key"], str(stored["operation_id"]), lock=False)
            if op and op["state"] == "processing" and repo.as_datetime(op["lease_until"]) > now:
                return "operation-live"
    return None


def cleanup_files(limit: int = 100, execute: bool = False) -> list[dict[str, Any]]:
    report = []
    for candidate in _candidates(limit):
        with repo.transaction(read_only_snapshot=not execute) as cur:
            stored = repo.file_record(cur, str(candidate["file_id"]), lock=execute)
            if not stored or stored["state"] not in ("staged", "retired", "delete_pending"):
                continue
            reason = _eligible(cur, stored)
            if reason:
                # Re-check later; a referenced/active file is never touched.
                # A dry-run must not reschedule work or change later results.
                if execute:
                    wait = RETIRED_GRACE if reason in ("grace", "leased", "operation-live") else timedelta(hours=6)
                    cur.execute("UPDATE sheet_files SET last_checked_at=clock_timestamp(),next_attempt_at=%s "
                                "WHERE organization_id=%s AND file_id=%s AND state<>'active'",
                                (repo.db_now(cur) + wait, repo.tenant(), str(stored["file_id"])))
                report.append({"file_id": str(stored["file_id"]), "kept": reason})
                continue
            report.append({"file_id": str(stored["file_id"]), "delete": stored["object_name"]})
            if not execute:
                continue
            cur.execute("UPDATE sheet_files SET state='delete_pending',last_checked_at=clock_timestamp() WHERE file_id=%s",
                        (str(stored["file_id"]),))
        if not execute:
            continue
        error = None
        try:
            storage.delete_object(stored["source"], stored["object_name"], stored.get("storage_generation"))
        except Exception as exc:
            error = "generation_changed" if exc.__class__.__name__ == "PreconditionFailed" else "storage_unavailable"
            logger.warning("Sheet file cleanup deferred (%s)", error)
        with repo.transaction() as cur:
            current = repo.file_record(cur, str(stored["file_id"]), lock=True)
            if not current or current["state"] != "delete_pending":
                continue
            retry = int(current["retry_count"] or 0) + (1 if error else 0)
            delay = timedelta(seconds=min(MAX_BACKOFF_SECONDS, 60 * 2 ** min(retry, 11)))
            if error:
                cur.execute("UPDATE sheet_files SET retry_count=%s,last_error_code=%s,next_attempt_at=%s,"
                            "last_checked_at=clock_timestamp() WHERE file_id=%s",
                            (retry, error, repo.db_now(cur) + delay, str(stored["file_id"])))
            else:
                cur.execute("UPDATE sheet_files SET state='deleted',deleted_at=clock_timestamp(),last_error_code=NULL,"
                            "next_attempt_at=NULL WHERE file_id=%s", (str(stored["file_id"]),))
    return report


def _delete_job_objects(job: dict[str, Any]) -> bool:
    prefix = f"{storage.ZIP_PREFIX}/{storage.org_hash()}/{job['job_id']}/"
    if storage.source_kind() == "local":
        storage.delete_prefix_dir(prefix)
        return True
    try:
        # Everything below the job's own prefix: recorded parts, parts of
        # attempts that died before they were recorded, and the final ZIP.
        for blob in get_storage_bucket().list_blobs(prefix=prefix):
            blob.delete(timeout=storage.STORAGE_TIMEOUT_SECONDS, retry=storage.STORAGE_RETRY)
        return True
    except Exception:
        logger.warning("Sheet ZIP cleanup deferred", exc_info=True)
        return False


def cleanup_jobs(limit: int = 50, execute: bool = False) -> list[dict[str, Any]]:
    report = []
    with repo.transaction(read_only_snapshot=not execute) as cur:
        now = repo.db_now(cur)
        # A building job without a live step for 30 minutes was abandoned.
        cur.execute("SELECT job_id FROM sheet_zip_jobs WHERE organization_id=%s AND state='building' "
                    "AND (lease_until IS NULL OR lease_until<=%s) AND updated_at<=%s LIMIT %s",
                    (repo.tenant(), now, now - ABANDONED_JOB, limit))
        candidates = [str(r["job_id"]) for r in cur.fetchall()]
        abandoned = []
        for job_id in candidates:
            if execute:
                # Selection is only a hint. A step may have claimed the job
                # since then: recheck under the UPDATE's row lock, and release
                # leases/delete parts only if this transition really won.
                cur.execute("UPDATE sheet_zip_jobs SET state='failed',error_code='abandoned',expires_at=clock_timestamp(),"
                            "attempt_id=NULL,lease_until=NULL,updated_at=clock_timestamp() "
                            "WHERE organization_id=%s AND job_id=%s AND state='building' "
                            "AND (lease_until IS NULL OR lease_until<=%s) AND updated_at<=%s RETURNING job_id",
                            (repo.tenant(), job_id, now, now - ABANDONED_JOB))
                if not cur.fetchone():
                    continue
                cur.execute("DELETE FROM sheet_file_leases WHERE organization_id=%s AND holder=%s", (repo.tenant(), f"zip:{job_id}"))
            abandoned.append(job_id)
        report += [{"job_id": j, "abandoned": True} for j in abandoned]
        cur.execute("SELECT job_id FROM sheet_zip_jobs WHERE organization_id=%s AND state<>'building' AND cleaned_at IS NULL "
                    "AND expires_at<=%s ORDER BY expires_at LIMIT %s", (repo.tenant(), now, limit))
        expired = [dict(r) for r in cur.fetchall()]
    for job in expired:
        report.append({"job_id": str(job["job_id"]), "expire": True})
        if not execute:
            continue
        if _delete_job_objects(job):
            with repo.transaction() as cur:
                cur.execute("UPDATE sheet_zip_jobs SET state=CASE WHEN state='ready' THEN 'expired' ELSE state END,"
                            "cleaned_at=clock_timestamp(),updated_at=clock_timestamp() "
                            "WHERE organization_id=%s AND job_id=%s AND state<>'building'", (repo.tenant(), str(job["job_id"])))
                cur.execute("DELETE FROM sheet_file_leases WHERE organization_id=%s AND holder=%s",
                            (repo.tenant(), f"zip:{job['job_id']}"))
    return report


def cleanup_records(execute: bool = False) -> dict[str, int]:
    with repo.transaction(read_only_snapshot=not execute) as cur:
        now = repo.db_now(cur)
        counts = {}
        for name, sql, params in (
            ("tickets", "FROM sheet_download_tickets WHERE organization_id=%s AND expires_at<=%s", (repo.tenant(), now)),
            ("leases", "FROM sheet_file_leases WHERE organization_id=%s AND expires_at<=%s", (repo.tenant(), now)),
            ("operations", "FROM sheet_operations WHERE organization_id=%s AND state<>'processing' AND updated_at<=%s",
             (repo.tenant(), now - OPERATION_RETENTION)),
        ):
            cur.execute("SELECT COUNT(*) AS n " + sql, params)
            counts[name] = int(cur.fetchone()["n"])
            if execute:
                cur.execute("DELETE " + sql, params)
    return counts


def run(limit: int = 100, execute: bool = False) -> dict[str, Any]:
    return {
        "files": cleanup_files(limit, execute),
        "jobs": cleanup_jobs(limit, execute),
        "records": cleanup_records(execute),
    }
