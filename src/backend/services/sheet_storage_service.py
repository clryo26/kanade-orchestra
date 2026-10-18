"""Sheet file storage: GCS in production, a local directory in development.

New files get their own object per file ID and are created with
if_generation_match=0, so an upload never replaces another file. Reads and
deletions use the stored generation when it is known, so a cleanup can never
remove a different (newer) object under the same name. DB and storage are not
one atomic transaction: the DB publishes a file only after the upload was
confirmed, and unpublished or retired objects are removed by the cleanup.
"""
from __future__ import annotations

import base64
import hashlib
import shutil
import time
from pathlib import Path
from typing import Any, BinaryIO, Iterator, cast
from uuid import UUID

from fastapi import HTTPException
from google.api_core.exceptions import NotFound, PreconditionFailed
from google.api_core.retry import Retry

from ..core.tenant_context import get_current_tenant_id
from ..drive_storage import get_storage_bucket, storage_enabled

STORAGE_TIMEOUT_SECONDS = 60
STORAGE_RETRY = Retry(deadline=120)
READ_CHUNK = 1024 * 1024
ZIP_PREFIX = "sheet-zips/v1"


class StorageMissing(Exception):
    """The stored object (of the expected generation) does not exist."""


# Timing (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md 7.1): every storage call has
# its own HTTP timeout and is retried here (not by the client library) only
# until a deadline, so one call never runs longer than about
# deadline + timeout. Calls cannot be interrupted once started; the step
# budget only decides whether a new call is started.
IO_TIMEOUT_SECONDS = 10.0  # one ranged read (<= READ_CHUNK), stat, compose, small write
IO_RETRY_DEADLINE_SECONDS = 10.0
UPLOAD_TIMEOUT_SECONDS = 30.0  # one part upload (<= ZIP part size)
UPLOAD_RETRY_DEADLINE_SECONDS = 20.0
MAX_IO_SECONDS = IO_RETRY_DEADLINE_SECONDS + IO_TIMEOUT_SECONDS
MAX_COMPOSE_SECONDS = IO_RETRY_DEADLINE_SECONDS + 2 * IO_TIMEOUT_SECONDS  # compose + metadata reload per try
MAX_UPLOAD_SECONDS = UPLOAD_RETRY_DEADLINE_SECONDS + UPLOAD_TIMEOUT_SECONDS
COMPOSE_LIMIT = 32  # GCS compose takes at most 32 sources

_clock = time.monotonic
_sleep = time.sleep


def _transient_errors() -> tuple[type[BaseException], ...]:
    import requests
    from google.api_core import exceptions as gexc
    return (ConnectionError, TimeoutError, requests.exceptions.ConnectionError, requests.exceptions.Timeout,
            gexc.ServiceUnavailable, gexc.InternalServerError, gexc.TooManyRequests, gexc.GatewayTimeout, gexc.BadGateway)


def with_retry(fn, deadline: float):
    """Runs fn, retrying transient failures with backoff until `deadline`
    seconds have passed since the first try; then the last error is raised."""
    transient = _transient_errors()
    started = _clock()
    delay = 0.5
    while True:
        try:
            return fn()
        except transient:
            if _clock() + delay - started > deadline:
                raise
            _sleep(delay)
            delay = min(delay * 2, 4.0)


def _storage_on() -> bool:
    # Honors the runtime/test override at the compatibility boundary.
    from ..core import compat_gateway
    override = getattr(compat_gateway.app_core, "storage_enabled", None)
    return bool(override() if callable(override) else storage_enabled())


def source_kind() -> str:
    return "google_cloud_storage" if _storage_on() else "local"


def org_hash() -> str:
    # 128 bits are enough to separate organizations and keep local paths
    # below the Windows path limit.
    return hashlib.sha256(get_current_tenant_id().encode()).hexdigest()[:32]


def new_object_name(file_id: str) -> str:
    # Under "sheets/" so the existing prod->test GCS sync policy covers it;
    # the same relative name is used below the local upload directory.
    return f"sheets/v2/{org_hash()}/{UUID(str(file_id))}.pdf"


def _upload_root() -> Path:
    # Resolved at call time so runtime/test overrides of the upload directory
    # apply (the same boundary the promotion images use).
    from ..core.compat_gateway import get_runtime_data_paths
    return Path(get_runtime_data_paths()[1])


def _local_path(name: str, root: Path | None = None) -> Path:
    root = root or _upload_root()
    path = (root / name).resolve()
    base = root.resolve()
    if base not in path.parents:
        raise HTTPException(404, detail="File not found")
    return path


def local_sheet_file(name: str) -> Path:
    path = _local_path(name)
    if (_upload_root() / "sheets").resolve() not in path.parents:
        raise HTTPException(404, detail="File not found")
    return path


def upload_new(name: str, content: bytes, content_type: str = "application/pdf") -> int | None:
    """Creates the object; fails if any object of that name exists."""
    if source_kind() == "local":
        path = local_sheet_file(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as output:
            output.write(content)
        return None
    blob = get_storage_bucket().blob(name)
    blob.upload_from_string(content, content_type=content_type, if_generation_match=0,
                            timeout=STORAGE_TIMEOUT_SECONDS, retry=STORAGE_RETRY)
    return int(blob.generation)


def _local_file(name: str, area: str) -> Path:
    # Two separate areas: published sheet files and built ZIPs.
    return zip_local(name) if area == "zip" else local_sheet_file(name)


def open_reader(source: str, name: str, generation: Any = None, area: str = "sheet") -> BinaryIO:
    if source == "google_cloud_storage":
        if not _storage_on():
            raise StorageMissing(name)
        bucket = get_storage_bucket()
        blob = bucket.blob(name, generation=int(generation)) if generation else bucket.blob(name)
        try:
            # reload() fails fast when the pinned generation is gone.
            blob.reload(timeout=STORAGE_TIMEOUT_SECONDS, retry=STORAGE_RETRY)
            return cast(BinaryIO, blob.open("rb", chunk_size=READ_CHUNK))
        except NotFound as exc:
            raise StorageMissing(name) from exc
    if area == "zip" and not name.startswith(ZIP_PREFIX + "/"):
        raise StorageMissing(name)
    try:
        return _local_file(name, area).open("rb")
    except (HTTPException, FileNotFoundError) as exc:
        raise StorageMissing(name) from exc


def stat(source: str, name: str, generation: Any = None, area: str = "sheet") -> dict[str, Any]:
    if source == "google_cloud_storage":
        if not _storage_on():
            raise StorageMissing(name)
        bucket = get_storage_bucket()
        blob = bucket.blob(name, generation=int(generation)) if generation else bucket.blob(name)
        try:
            # Bounded like every call of a ZIP step (MAX_IO_SECONDS).
            with_retry(lambda: blob.reload(timeout=IO_TIMEOUT_SECONDS, retry=None), IO_RETRY_DEADLINE_SECONDS)
        except NotFound as exc:
            raise StorageMissing(name) from exc
        return {"size": int(blob.size or 0), "generation": int(blob.generation or 0)}
    try:
        path = _local_file(name, area)
    except HTTPException as exc:
        raise StorageMissing(name) from exc
    if not path.is_file():
        raise StorageMissing(name)
    return {"size": path.stat().st_size, "generation": None}


def iter_chunks(reader: BinaryIO) -> Iterator[bytes]:
    with reader:
        while True:
            chunk = reader.read(READ_CHUNK)
            if not chunk:
                return
            yield chunk


def delete_object(source: str, name: str, generation: Any = None) -> None:
    """Deletes exactly the given generation (or the current one, reloaded
    now, for legacy rows without a stored generation). Missing is success."""
    if source == "local":
        try:
            local_sheet_file(name).unlink(missing_ok=True)
        except HTTPException:
            return
        return
    if not _storage_on():
        raise RuntimeError("storage_unavailable")
    blob = get_storage_bucket().blob(name)
    if generation is None:
        try:
            blob.reload(timeout=STORAGE_TIMEOUT_SECONDS, retry=STORAGE_RETRY)
        except NotFound:
            return
        generation = int(blob.generation)
    try:
        blob.delete(if_generation_match=int(generation), timeout=STORAGE_TIMEOUT_SECONDS, retry=STORAGE_RETRY)
    except NotFound:
        return


# ----- ZIP parts (bounded steps, composed progressively) ------------------------------


def read_range(source: str, name: str, generation: Any, start: int, length: int) -> bytes:
    """`length` bytes from `start` of exactly that stored generation."""
    if length <= 0:
        return b""
    if source == "google_cloud_storage":
        if not _storage_on():
            raise StorageMissing(name)
        bucket = get_storage_bucket()
        blob = bucket.blob(name, generation=int(generation)) if generation else bucket.blob(name)
        try:
            return cast(bytes, with_retry(lambda: blob.download_as_bytes(
                start=start, end=start + length - 1, timeout=IO_TIMEOUT_SECONDS, retry=None), IO_RETRY_DEADLINE_SECONDS))
        except NotFound as exc:
            raise StorageMissing(name) from exc
    try:
        with local_sheet_file(name).open("rb") as handle:
            handle.seek(start)
            return handle.read(length)
    except (HTTPException, FileNotFoundError) as exc:
        raise StorageMissing(name) from exc


def zip_part_name(job_id: str, index: int, attempt_id: str) -> str:
    # The attempt is part of every name: an attempt that lost its claim can
    # only ever write (and later remove) its own objects.
    return f"{ZIP_PREFIX}/{org_hash()}/{job_id}/p{index:05d}-{str(attempt_id).replace('-', '')[:12]}"


def zip_final_name(job_id: str, attempt_id: str) -> str:
    return f"{ZIP_PREFIX}/{org_hash()}/{job_id}/zip-{str(attempt_id).replace('-', '')[:12]}.zip"


def zip_local(name: str) -> Path:
    return _local_path(name)


def write_part(name: str, data: bytes) -> int | None:
    """Creates the part (never replaces an object). A retry after a lost
    answer finds the object it created itself and accepts it by size and MD5."""
    if source_kind() == "local":
        path = zip_local(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as output:
            output.write(data)
        return None
    blob = get_storage_bucket().blob(name)
    md5 = base64.b64encode(hashlib.md5(data).digest()).decode()  # noqa: S324 - integrity check, not security

    def upload():
        try:
            blob.upload_from_string(data, content_type="application/octet-stream", if_generation_match=0,
                                    timeout=UPLOAD_TIMEOUT_SECONDS, retry=None)
        except PreconditionFailed:
            blob.reload(timeout=IO_TIMEOUT_SECONDS, retry=None)
            if int(blob.size or -1) != len(data) or blob.md5_hash != md5:
                raise
        return int(blob.generation)

    return cast(int, with_retry(upload, UPLOAD_RETRY_DEADLINE_SECONDS))


def compose_into(sources: list[str], target: str) -> dict[str, Any]:
    """One composition of <= COMPOSE_LIMIT sources into a new object."""
    if len(sources) > COMPOSE_LIMIT:
        raise ValueError("too many sources for one compose")
    if source_kind() == "local":
        out = zip_local(target)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("xb") as output:
            for part in sources:
                with zip_local(part).open("rb") as source:
                    shutil.copyfileobj(source, output, READ_CHUNK)
        return {"size": out.stat().st_size, "generation": None}
    bucket = get_storage_bucket()
    final = bucket.blob(target)
    final.content_type = "application/zip"

    def run():
        try:
            final.compose([bucket.blob(n) for n in sources], if_generation_match=0, timeout=IO_TIMEOUT_SECONDS, retry=None)
        except PreconditionFailed:
            pass  # created by an earlier try of this same call (unique name)
        final.reload(timeout=IO_TIMEOUT_SECONDS, retry=None)
        return {"size": int(final.size or 0), "generation": int(final.generation or 0)}

    return cast(dict[str, Any], with_retry(run, IO_RETRY_DEADLINE_SECONDS))


def read_tail(name: str, generation: Any, size: int, length: int) -> bytes:
    if source_kind() == "local":
        with zip_local(name).open("rb") as handle:
            handle.seek(max(0, size - length))
            return handle.read(length)
    blob = get_storage_bucket().blob(name, generation=generation)
    return cast(bytes, with_retry(lambda: blob.download_as_bytes(
        start=size - length, end=size - 1, timeout=IO_TIMEOUT_SECONDS, retry=None), IO_RETRY_DEADLINE_SECONDS))


def delete_quietly(name: str) -> bool:
    try:
        if source_kind() == "local":
            zip_local(name).unlink(missing_ok=True)
        else:
            blob = get_storage_bucket().blob(name)
            with_retry(lambda: blob.delete(timeout=IO_TIMEOUT_SECONDS, retry=None), IO_RETRY_DEADLINE_SECONDS)
        return True
    except NotFound:
        return True
    except (PreconditionFailed, Exception):
        return False


def delete_prefix_dir(job_dir: str) -> None:
    if source_kind() == "local":
        shutil.rmtree(zip_local(job_dir), ignore_errors=True)
