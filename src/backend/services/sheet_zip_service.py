"""Bulk download ZIP jobs (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md, section 7).

- The content is fixed when the job is created: sheet IDs, file IDs, stored
  generations, names and sizes. Files of the job are protected by leases.
- Building runs in bounded steps that may end inside a file (STEP_BUDGET_SECONDS
  for starting new I/O, MAX_STEP_SECONDS worst case per request). Each step
  writes one new part; the DB records only committed steps, so a step that died
  is repeated with the same bytes. See "steps" below.
- The ZIP becomes downloadable only after all parts were composed and the end
  record was read back. A missing file stops a complete ZIP (state
  "incomplete"); a partial ZIP exists only when the user asked for it, and it
  contains a list of what is missing.
"""
from __future__ import annotations

import io
import json
import struct
import time
import zlib
from datetime import timedelta
from typing import Any, cast
from uuid import UUID, uuid4

from fastapi import HTTPException

from ..core.tenant_context import get_current_tenant_id
from ..repositories import sheet_repository as repo
from . import sheet_storage_service as storage
from .file_service import safe_segment, safe_upload_name

MAX_ZIP_FILES = 1000  # a concert of 20 pieces x 30 parts fits; building streams one file at a time
MAX_ZIP_BYTES = 1024 * 1024 * 1024  # 1 GiB; also keeps every offset in the 32-bit ZIP format
# Step timing (design 7.1). New storage I/O is started only within the budget;
# started calls are bounded by storage.MAX_IO_SECONDS / MAX_UPLOAD_SECONDS.
STEP_BUDGET_SECONDS = 15.0
PART_MAX_BYTES = 8 * 1024 * 1024  # one part upload per step
DB_ALLOWANCE_SECONDS = 30.0  # claim + commit transactions (connect timeout 10 s each)
_BUILD_MAX = (STEP_BUDGET_SECONDS + 2 * storage.MAX_IO_SECONDS  # stat + read started before the budget ended
              + storage.MAX_UPLOAD_SECONDS + storage.MAX_COMPOSE_SECONDS  # the part, compose + metadata reload
              + 2 * storage.MAX_IO_SECONDS + DB_ALLOWANCE_SECONDS)  # own objects removed after a lost claim
_FINISH_MAX = (storage.MAX_UPLOAD_SECONDS + storage.MAX_COMPOSE_SECONDS + storage.MAX_IO_SECONDS  # end, compose, read back
               + 2 * storage.MAX_IO_SECONDS + DB_ALLOWANCE_SECONDS)
MAX_STEP_SECONDS = max(_BUILD_MAX, _FINISH_MAX)
# The claim outlasts the worst step, so a live step never loses it; the
# client waits longer than the claim (save_dialog.js ZIP_STEP_TIMEOUT_MS).
STEP_LEASE = timedelta(seconds=240)
FILE_LEASE = timedelta(minutes=15)
READY_TTL = timedelta(hours=24)
BUILDING_TTL = timedelta(hours=24)
MISSING_LIST_NAME = "不足している楽譜.txt"


def _json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def _job(cur, job_id: str, actor: str | None, lock: bool = False) -> dict[str, Any]:
    cur.execute("SELECT * FROM sheet_zip_jobs WHERE organization_id=%s AND job_id=%s" + (" FOR UPDATE" if lock else ""),
                (repo.tenant(), job_id))
    job = cur.fetchone()
    if not job or (actor is not None and job["actor_key"] != actor):
        raise HTTPException(404, detail={"code": "sheet_zip_missing", "message": "ZIPの作成状況が見つかりません"})
    for key in ("manifest", "missing", "parts", "entries"):
        job[key] = _json(job[key]) or []
    return cast(dict[str, Any], job)


def public(job: dict[str, Any], current_version: int | None = None) -> dict[str, Any]:
    out = {
        "job_id": str(job["job_id"]),
        "state": job["state"],
        "title": job["title"],
        "file_count": int(job["file_count"]),
        "done_count": int(job["done_count"]),
        "total_bytes": int(job["total_bytes"]),
        "written_bytes": int(job["written_bytes"]),
        "allow_partial": bool(job["allow_partial"]),
        "missing": job["missing"],
        "zip_bytes": job.get("zip_bytes"),
        "error_code": job.get("error_code"),
        "expires_at": repo.iso(job["expires_at"]),
        "list_version": int(job["list_version"]),
    }
    if current_version is not None:
        out["changed_since"] = current_version != int(job["list_version"])
    return out


def _zip_name(title: str, piece: str, part: str, partial: bool) -> str:
    base = safe_segment(f"{title}_{piece or 'all'}_{part or 'all-parts'}", "sheets")
    return base + ("_一部" if partial else "") + ".zip"


def create(device: dict[str, Any], raw: dict[str, Any]) -> dict[str, Any]:
    from .sheet_library_service import actor_key
    actor = actor_key(device)
    performance_id = str(raw.get("performance_id") or "").strip()
    piece = str(raw.get("piece") or "").strip()
    part = str(raw.get("part") or "").strip()
    allow_partial = bool(raw.get("allow_partial"))
    excluded = {int(x) for x in (raw.get("exclude_sheet_ids") or []) if str(x).isdigit()} if allow_partial else set()
    if not performance_id.isdigit():
        raise HTTPException(400, detail="performance_id is required")
    with repo.transaction() as cur:
        version = repo.list_version(cur)
        sql = ("SELECT id,performance_title,piece,part,name,source,path,object_name,size_bytes,file_id,storage_generation,revision "
               "FROM sheet_library WHERE organization_id=%s AND performance_id=%s")
        params: list[Any] = [repo.tenant(), int(performance_id)]
        # scope "piece" filters by the piece even when its name is empty
        # (an unnamed piece is one piece, not the whole concert).
        if piece or str(raw.get("scope") or "") == "piece":
            sql += " AND COALESCE(piece,'')=%s"
            params.append(piece)
        if part:
            sql += " AND part=%s"
            params.append(part)
        cur.execute(sql + " ORDER BY piece, part, id", tuple(params))
        rows = [r for r in cur.fetchall() if int(r["id"]) not in excluded]
        if not rows:
            raise HTTPException(404, detail={"code": "sheet_zip_empty", "message": "対象の楽譜がありません"})
        if len(rows) > MAX_ZIP_FILES:
            raise HTTPException(413, detail={"code": "sheet_zip_too_many", "message": f"一度にまとめられるのは{MAX_ZIP_FILES}件までです。曲やパートで絞り込んでください"})
        known = sum(int(r["size_bytes"] or 0) for r in rows)
        if known > MAX_ZIP_BYTES:
            raise HTTPException(413, detail={"code": "sheet_zip_too_large", "message": "合計が1GiBを超えるため、曲やパートで絞り込んでください"})
        used: set[str] = set()
        manifest = []
        for r in rows:
            repo.ensure_file(cur, r)
            folder = safe_segment(str(r.get("piece") or "piece"), "piece")
            manifest.append({
                "sheet_id": int(r["id"]), "revision": int(r["revision"]), "file_id": str(r["file_id"]),
                "source": r["source"] if r["source"] == "google_cloud_storage" else "local",
                "object_name": r["object_name"] if r["source"] == "google_cloud_storage" else r["path"],
                "generation": r.get("storage_generation"), "size": r.get("size_bytes"),
                "zip_name": f"{folder}/{_unique(str(r.get('name') or 'score.pdf'), used, folder)}",
                "label": f"{r.get('piece') or ''} {r.get('part') or ''} {r.get('name') or ''}".strip(),
            })
        job_id = str(uuid4())
        now = repo.db_now(cur)
        title = str(rows[0].get("performance_title") or "sheets")
        prior_missing = [m for m in (raw.get("missing") or []) if isinstance(m, dict)][:MAX_ZIP_FILES] if allow_partial else []
        cur.execute("INSERT INTO sheet_zip_jobs (job_id,organization_id,actor_key,performance_id,piece,part,title,list_version,"
                    "allow_partial,manifest,missing,file_count,total_bytes,state,created_at,updated_at,expires_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,'building',%s,%s,%s)",
                    (job_id, repo.tenant(), actor, performance_id, piece, part, title, version, allow_partial,
                     json.dumps(manifest, ensure_ascii=False), json.dumps(prior_missing, ensure_ascii=False),
                     len(manifest), known, now, now, now + BUILDING_TTL))
        for entry in manifest:
            _lease(cur, entry["file_id"], job_id, now)
        job = _job(cur, job_id, actor)
    return public(job, version)


def _unique(name: str, used: set[str], folder: str) -> str:
    base = safe_upload_name(name or "score.pdf")
    if not base.lower().endswith(".pdf"):
        base += ".pdf"
    stem, suffix = base[:-4], base[-4:]
    candidate, counter = base, 2
    while f"{folder}/{candidate}" in used:
        candidate = f"{stem}_{counter}{suffix}"
        counter += 1
    used.add(f"{folder}/{candidate}")
    return candidate


def _lease(cur, file_id: str, job_id: str, now) -> None:
    cur.execute("INSERT INTO sheet_file_leases (lease_id,organization_id,file_id,holder,expires_at,created_at) "
                "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (file_id,holder) DO UPDATE SET expires_at=EXCLUDED.expires_at",
                (str(uuid4()), repo.tenant(), file_id, f"zip:{job_id}", now + FILE_LEASE, now))


def _release_leases(cur, job_id: str) -> None:
    cur.execute("DELETE FROM sheet_file_leases WHERE organization_id=%s AND holder=%s", (repo.tenant(), f"zip:{job_id}"))


def status(device: dict[str, Any], job_id: str) -> dict[str, Any]:
    from .sheet_library_service import actor_key
    job_id = str(UUID(job_id))
    with repo.transaction() as cur:
        job = _job(cur, job_id, actor_key(device))
        return public(job, repo.list_version(cur))


def cancel(device: dict[str, Any], job_id: str) -> dict[str, Any]:
    from .sheet_library_service import actor_key
    job_id = str(UUID(job_id))
    with repo.transaction() as cur:
        job = _job(cur, job_id, actor_key(device), lock=True)
        if job["state"] == "building":
            # Parts already written are removed by the cleanup (expires_at now).
            cur.execute("UPDATE sheet_zip_jobs SET state='cancelled',attempt_id=NULL,lease_until=NULL,"
                        "updated_at=clock_timestamp(),expires_at=clock_timestamp() WHERE organization_id=%s AND job_id=%s",
                        (repo.tenant(), job_id))
            _release_leases(cur, job_id)
        job = _job(cur, job_id, None)
        return public(job, repo.list_version(cur))


# ----- ZIP records (stored entries, UTF-8 names, data descriptors) --------------------


def _dos_time() -> tuple[int, int]:
    t = time.localtime()
    return ((t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2),
            ((t.tm_year - 1980) << 9) | (t.tm_mon << 5) | t.tm_mday)


FLAGS = 0x0008 | 0x0800  # data descriptor follows, UTF-8 file name


def _local_header(name: bytes, dos: tuple[int, int]) -> bytes:
    return struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, FLAGS, 0, dos[0], dos[1], 0, 0, 0, len(name), 0) + name


def _descriptor(crc: int, size: int) -> bytes:
    return struct.pack("<IIII", 0x08074B50, crc, size, size)


def _central(entries: list[dict[str, Any]]) -> bytes:
    out = io.BytesIO()
    for e in entries:
        name = e["name"].encode("utf-8")
        out.write(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, FLAGS, 0, e["time"], e["date"], e["crc"],
                              e["size"], e["size"], len(name), 0, 0, 0, 0, 0, e["offset"]) + name)
    return out.getvalue()


def _end(count: int, cd_size: int, cd_offset: int) -> bytes:
    return struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, count, count, cd_size, cd_offset, 0)


# ----- steps (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md 7.1) ----------------------------
#
# A step holds the job's claim (attempt_id + lease_until) while it works:
# - it starts new storage I/O only within STEP_BUDGET_SECONDS (checked before
#   each new file and before each further chunk, so one slow or large file is
#   split over several steps); the first file/chunk of a step always runs, so
#   every step progresses;
# - the bytes of the step are uploaded as one new part (unique name with the
#   attempt); the chain of parts is composed into one object whenever it
#   reaches COMPOSE_LIMIT, so the final compose never has more than 32 sources;
# - the result is committed only by the attempt that still holds the claim
#   (fenced). An intermediate step gives the claim back in that commit, so the
#   next request continues at once; an attempt that lost the claim removes
#   only its own new objects;
# - finishing (end records, compose, read back) is a step of its own.
# Started storage calls cannot be interrupted: the worst case of one request
# is MAX_STEP_SECONDS, which the claim (STEP_LEASE) and the client timeout
# exceed.

clock = time.monotonic


def _claim(job_id: str, actor: str) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    with repo.transaction() as cur:
        job = _job(cur, job_id, actor, lock=True)
        if job["state"] != "building":
            return None, job
        now = repo.db_now(cur)
        if job.get("attempt_id") and job.get("lease_until") and repo.as_datetime(job["lease_until"]) > now:
            job["busy"] = True
            return None, job  # another step really is running now
        attempt = str(uuid4())
        cur.execute("UPDATE sheet_zip_jobs SET attempt_id=%s,lease_until=%s,updated_at=clock_timestamp() "
                    "WHERE organization_id=%s AND job_id=%s", (attempt, now + STEP_LEASE, repo.tenant(), job_id))
        # The leases exist since the job was created; a live step renews them
        # all at once (the cleanup keeps leased files).
        cur.execute("UPDATE sheet_file_leases SET expires_at=%s WHERE organization_id=%s AND holder=%s",
                    (now + FILE_LEASE, repo.tenant(), f"zip:{job_id}"))
        job["attempt_id"] = attempt
        return job, job


def _fenced(cur, job_id: str, attempt: str) -> dict[str, Any]:
    job = _job(cur, job_id, None, lock=True)
    if (job["state"] != "building" or str(job.get("attempt_id")) != attempt or not job.get("lease_until")
            or repo.as_datetime(job["lease_until"]) <= repo.db_now(cur)):
        raise repo.LostAttempt()
    return job


def step(device: dict[str, Any], job_id: str) -> dict[str, Any]:
    from .sheet_library_service import actor_key
    actor = actor_key(device)
    job_id = str(UUID(job_id))
    job, current = _claim(job_id, actor)
    if job is None:
        out = status(device, job_id)
        if current.get("busy"):
            out["busy"] = True  # the client waits briefly; nothing is run twice
        return out
    return _work(job, actor)


class _TooLarge(Exception):
    pass


class _SourceChanged(Exception):
    pass


def _work(job: dict[str, Any], actor: str) -> dict[str, Any]:
    attempt = str(job["attempt_id"])
    job_id = str(job["job_id"])
    with repo.transaction() as cur:
        try:
            _fenced(cur, job_id, attempt)
        except repo.LostAttempt:
            return _status_in(cur, job_id)
    try:
        if int(job["done_count"]) >= len(job["manifest"]) and not _progress(job):
            return _finish(job, attempt)
        return _build(job, attempt)
    except Exception:
        # A replacement attempt may have completed and removed source parts
        # during our I/O. Such an obsolete failure must not replace its result.
        # Otherwise this request has ended: let a retry claim immediately and
        # replay only the last uncommitted step, using new object names.
        with repo.transaction() as cur:
            try:
                _fenced(cur, job_id, attempt)
            except repo.LostAttempt:
                return _status_in(cur, job_id)
            cur.execute("UPDATE sheet_zip_jobs SET attempt_id=NULL,lease_until=NULL,updated_at=clock_timestamp() "
                        "WHERE organization_id=%s AND job_id=%s AND attempt_id=%s",
                        (repo.tenant(), job_id, attempt))
        raise


def _progress(job: dict[str, Any]) -> dict[str, Any]:
    value = _json(job.get("progress")) if job.get("progress") is not None else {}
    return dict(value or {})


def _build(job: dict[str, Any], attempt: str) -> dict[str, Any]:
    job_id = str(job["job_id"])
    manifest = job["manifest"]
    index = int(job["done_count"])
    base = int(job["written_bytes"])  # ZIP bytes already in committed parts
    entries = list(job["entries"])
    missing = list(job["missing"])
    chain = [p["name"] for p in job["parts"]]
    progress = _progress(job)
    started = clock()
    buf = bytearray()
    error = None
    state = "building"
    first = True
    dos = _dos_time()
    try:
        while index < len(manifest):
            if not first and (clock() - started >= STEP_BUDGET_SECONDS or len(buf) >= PART_MAX_BYTES):
                break
            first = False
            entry = manifest[index]
            if not progress:
                try:
                    info = storage.stat(entry["source"], entry["object_name"], entry.get("generation"))
                except storage.StorageMissing:
                    missing.append({"sheet_id": entry["sheet_id"], "label": entry["label"], "reason": "missing"})
                    index += 1
                    if not job["allow_partial"]:
                        state = "incomplete"
                        break
                    continue
                # Generation pinned now: later steps read exactly the same bytes.
                progress = {"read": 0, "crc": 0, "entry_offset": base + len(buf),
                            "generation": info.get("generation") or entry.get("generation"), "size": int(info["size"])}
                buf += _local_header(entry["zip_name"].encode("utf-8"), dos)
            if progress["read"] < progress["size"]:
                length = min(storage.READ_CHUNK, progress["size"] - progress["read"])
                try:
                    data = storage.read_range(entry["source"], entry["object_name"], progress["generation"], progress["read"], length)
                except storage.StorageMissing as exc:
                    raise _SourceChanged() from exc
                if len(data) != length:
                    raise _SourceChanged()
                progress["crc"] = zlib.crc32(data, progress["crc"]) & 0xFFFFFFFF
                progress["read"] += len(data)
                buf += data
            if base + len(buf) > MAX_ZIP_BYTES:
                raise _TooLarge()
            if progress["read"] >= progress["size"]:
                # The entry exists only once its file is complete.
                buf += _descriptor(progress["crc"], progress["size"])
                entries.append({"name": entry["zip_name"], "crc": progress["crc"], "size": progress["size"],
                                "offset": progress["entry_offset"], "time": dos[0], "date": dos[1]})
                index += 1
                progress = {}
    except _TooLarge:
        state, error = "failed", "too_large"
    except _SourceChanged:
        # Bytes of this file are already in earlier parts: a ZIP without it
        # cannot be made from them. Not complete -> incomplete; partial -> failed.
        missing.append({"sheet_id": manifest[index]["sheet_id"], "label": manifest[index]["label"], "reason": "changed"})
        state, error = ("failed", "source_changed") if job["allow_partial"] else ("incomplete", None)
    created: list[str] = []
    if buf and state == "building":
        name = storage.zip_part_name(job_id, len(chain), attempt)
        storage.write_part(name, bytes(buf))
        created.append(name)
        chain.append(name)
        if len(chain) >= storage.COMPOSE_LIMIT:
            composite = storage.zip_part_name(job_id, len(chain), attempt) + "-c"
            storage.compose_into(chain, composite)
            created.append(composite)
            obsolete, chain = chain, [composite]
        else:
            obsolete = []
    else:
        obsolete = []
    written = base + (len(buf) if state == "building" else 0)
    with repo.transaction() as cur:
        try:
            _fenced(cur, job_id, attempt)
        except repo.LostAttempt:
            for name in created:
                storage.delete_quietly(name)
            return _status_in(cur, job_id)
        cur.execute("UPDATE sheet_zip_jobs SET done_count=%s,written_bytes=%s,parts=%s::jsonb,entries=%s::jsonb,missing=%s::jsonb,"
                    "progress=%s::jsonb,state=%s,error_code=%s,attempt_id=NULL,lease_until=NULL,updated_at=clock_timestamp() "
                    "WHERE organization_id=%s AND job_id=%s AND attempt_id=%s",
                    (index, written, json.dumps([{"name": n} for n in chain]), json.dumps(entries, ensure_ascii=False),
                     json.dumps(missing, ensure_ascii=False), json.dumps(progress), state, error,
                     repo.tenant(), job_id, attempt))
        if state != "building":
            _release_leases(cur, job_id)
            cur.execute("UPDATE sheet_zip_jobs SET expires_at=%s WHERE organization_id=%s AND job_id=%s",
                        (repo.db_now(cur) + READY_TTL, repo.tenant(), job_id))
        out = _status_in(cur, job_id)
    # Sources of a composition are no longer referenced by the committed
    # chain. Deleting them is not part of the step's worst case: only within
    # the budget, the rest goes with the job's prefix in the cleanup.
    _delete_within(obsolete, started)
    return out


def _delete_within(names: list[str], started: float) -> None:
    for name in names:
        if clock() - started >= STEP_BUDGET_SECONDS:
            return
        storage.delete_quietly(name)


def _finish(job: dict[str, Any], attempt: str) -> dict[str, Any]:
    job_id = str(job["job_id"])
    started = clock()
    entries = list(job["entries"])
    offset = int(job["written_bytes"])
    tail = io.BytesIO()
    if job["allow_partial"] and job["missing"]:
        text = ("次の楽譜は取得できなかったため、このZIPに含まれていません。\r\n" +
                "\r\n".join(f"- {m.get('label') or m.get('sheet_id')}" for m in job["missing"])).encode("utf-8")
        list_name = MISSING_LIST_NAME.encode("utf-8")
        dos = _dos_time()
        tail.write(_local_header(list_name, dos))
        tail.write(text)
        crc = zlib.crc32(text) & 0xFFFFFFFF
        tail.write(_descriptor(crc, len(text)))
        entries.append({"name": MISSING_LIST_NAME, "crc": crc, "size": len(text), "offset": offset, "time": dos[0], "date": dos[1]})
    cd_offset = offset + tail.tell()
    cd = _central(entries)
    tail.write(cd)
    tail.write(_end(len(entries), len(cd), cd_offset))
    chain = [p["name"] for p in job["parts"]]
    tail_name = storage.zip_part_name(job_id, len(chain), attempt) + "-end"
    storage.write_part(tail_name, tail.getvalue())
    final_name = storage.zip_final_name(job_id, attempt)
    created = [tail_name]
    result = storage.compose_into(chain + [tail_name], final_name)  # <= 32 sources (composed while building)
    created.append(final_name)
    expected = cd_offset + len(cd) + 22
    verified = result["size"] == expected and _end_matches(final_name, result.get("generation"), expected,
                                                           len(entries), len(cd), cd_offset)
    with repo.transaction() as cur:
        try:
            _fenced(cur, job_id, attempt)
        except repo.LostAttempt:
            for name in created:
                storage.delete_quietly(name)
            return _status_in(cur, job_id)
        state = "ready" if verified else "failed"
        cur.execute("UPDATE sheet_zip_jobs SET state=%s,object_name=%s,zip_bytes=%s,error_code=%s,"
                    "attempt_id=NULL,lease_until=NULL,ready_at=CASE WHEN %s='ready' THEN clock_timestamp() ELSE NULL END,"
                    "expires_at=%s,updated_at=clock_timestamp() WHERE organization_id=%s AND job_id=%s AND attempt_id=%s",
                    (state, final_name if verified else None, result["size"], None if verified else "verify_failed",
                     state, repo.db_now(cur) + READY_TTL, repo.tenant(), job_id, attempt))
        _release_leases(cur, job_id)
        out = _status_in(cur, job_id)
    _delete_within(chain + [tail_name] if verified else [final_name], started)
    return out


def _end_matches(name: str, generation: Any, size: int, count: int, cd_size: int, cd_offset: int) -> bool:
    # Reads the end record back from storage: the composed object is the
    # ZIP the user will get, not the bytes this process believes it wrote.
    try:
        return storage.read_tail(name, generation, size, 22) == _end(count, cd_size, cd_offset)
    except Exception:
        return False


def _status_in(cur, job_id: str) -> dict[str, Any]:
    job = _job(cur, job_id, None)
    return public(job, repo.list_version(cur))


def ready_job(job_id: str) -> dict[str, Any]:
    with repo.transaction() as cur:
        job = _job(cur, str(UUID(job_id)), None)
    if job["state"] != "ready" or repo.as_datetime(job["expires_at"]) <= repo.utc_now():
        raise HTTPException(410, detail={"code": "sheet_zip_not_ready", "message": "ZIPの保存期限が切れたか、まだ作成中です。もう一度作成してください"})
    return job


def download_name(job: dict[str, Any]) -> str:
    return _zip_name(job["title"], job["piece"], job["part"], bool(job["allow_partial"] and job["missing"]))


def owned_ready_job(device: dict[str, Any], job_id: str) -> dict[str, Any]:
    from .sheet_library_service import actor_key
    job = ready_job(job_id)
    if job["actor_key"] != actor_key(device):
        raise HTTPException(404, detail="Not found")
    return job


def tenant_check(job: dict[str, Any]) -> None:
    if job["organization_id"] != get_current_tenant_id():
        raise HTTPException(404, detail="Not found")
