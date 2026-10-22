"""PERF-R05: bounded, request-local, single-connection RR read scope.

Repositories explicitly borrow the read-only facade. Opening another pooled
connection is forbidden; the facade never commits or controls the transaction.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from threading import BoundedSemaphore, Lock, get_ident
from time import monotonic
from typing import Any

import anyio
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from .tenant_context import get_current_tenant_id

READ_SLOTS = 4
ADMISSION_SECONDS = 2.0
READ_SECONDS = 5.0
SQL_SECONDS = 3.0
_slots = BoundedSemaphore(READ_SLOTS)
_current: ContextVar[ReadContext | None] = ContextVar("portal_read_context", default=None)


class ClockAnomaly(RuntimeError):
    """No data or connection string is included in the public error."""


def clock_error() -> HTTPException:
    return HTTPException(503, detail={"code": "version_clock_anomaly",
                                     "message": "データを確認できませんでした。管理者に連絡してください"},
                         headers={"Cache-Control": "no-store"})


def capacity_error() -> HTTPException:
    return HTTPException(503, detail={"code": "read_capacity_exceeded",
                                     "message": "現在、処理が混み合っています。時間をおいて再試行してください。"},
                         headers={"Retry-After": "2", "Cache-Control": "no-store"})


def current_read_context():
    return _current.get()


async def _worker(function, *args, cancel_cleanup=None):
    """Native Task.cancel must not abandon a thread holding a pool/slot lease."""
    async def wait(task):
        cancelled = False
        while True:
            try:
                return await asyncio.shield(task), cancelled
            except asyncio.CancelledError:
                if task.cancelled():
                    raise
                cancelled = True
    task = asyncio.create_task(run_in_threadpool(function, *args))
    result, cancelled = await wait(task)
    if cancelled:
        if cancel_cleanup is not None:
            cleanup = asyncio.create_task(run_in_threadpool(cancel_cleanup, result))
            await wait(cleanup)
        raise asyncio.CancelledError()
    return result


class ReadCursor:
    def __init__(self, connection, raw):
        self.connection, self.frame, self.raw = connection, connection.frame, raw

    def __enter__(self):
        self.connection.check()
        self.raw.__enter__()
        return self

    def __exit__(self, *args):
        return self.raw.__exit__(*args)

    def __getattr__(self, name):
        if name not in {"fetchone", "fetchall", "fetchmany", "description", "rowcount", "close"}:
            raise RuntimeError("Unsupported operation in read context")
        self.connection.check()
        value = getattr(self.raw, name)
        if callable(value):
            def checked(*args, **kwargs):
                self.connection.check()
                return value(*args, **kwargs)
            return checked
        return value

    def execute(self, query, params=None, **kwargs):
        self.connection.check()
        text = query.as_string(self.frame.raw) if hasattr(query, "as_string") else str(query)
        # PostgreSQL READ ONLY also rejects data-modifying CTEs/functions.
        command = text.lstrip().split(None, 1)
        if not command or command[0].upper() not in {"SELECT", "WITH"}:
            raise RuntimeError("Only SELECT is allowed in read context")
        remaining = self.frame.remaining()
        milliseconds = max(1, int(min(SQL_SECONDS, remaining) * 1000))
        # BEGIN already installed 3s/1s. Avoid a redundant SQL roundtrip while
        # those limits still fit the remaining request budget; only tighten.
        if milliseconds < self.frame.statement_limit_ms:
            self.raw.execute("SELECT set_config('statement_timeout', %s, true), "
                             "set_config('lock_timeout', %s, true)",
                             (str(milliseconds), str(max(1, min(1000, milliseconds)))))
            self.frame.statement_limit_ms = milliseconds
        if not self.frame.snapshot_at:
            self.frame.snapshot_at = monotonic()
        self.raw.execute(query, params, **kwargs)
        return self


class ReadConnection:
    def __init__(self, frame):
        self.frame = frame
        self.active = True
        self.thread = get_ident()

    def check(self):
        self.frame.check_owner()
        if not self.active or self.thread != get_ident():
            raise RuntimeError("Expired or cross-thread read connection lease")

    @property
    def info(self):
        return self.frame.raw.info

    @property
    def autocommit(self):
        return False

    @autocommit.setter
    def autocommit(self, value):
        raise RuntimeError("Repository cannot change read transaction mode")

    def cursor(self, *args, **kwargs):
        self.check()
        return ReadCursor(self, self.frame.raw.cursor(*args, **kwargs))

    def execute(self, query, params=None):
        return self.cursor().execute(query, params)

    def commit(self):
        raise RuntimeError("Repository cannot commit a read context")

    def rollback(self):
        raise RuntimeError("Repository cannot rollback a read context")


@dataclass
class ReadContext:
    raw: Any
    deadline: float
    tenant: str
    owner_task: Any
    lock: Any = field(default_factory=Lock)
    closed: bool = False
    snapshot_at: float = 0.0
    statement_limit_ms: int = 3000
    auth_results: dict = field(default_factory=dict)
    auth_trusted: bool = True
    response_etag: str = ""
    versions: dict = field(default_factory=dict)
    generation: str = ""
    collections: frozenset = field(default_factory=frozenset)

    def remaining(self):
        value = self.deadline - monotonic()
        if value <= 0:
            raise capacity_error()
        return value

    def check_owner(self):
        try:
            task = asyncio.current_task()
        except RuntimeError:  # normal FastAPI sync dependency worker
            task = None
        if task is not None and task is not self.owner_task:
            raise RuntimeError("Read connection cannot be shared with child tasks")
        if self.closed or _current.get() is not self or self.tenant != get_current_tenant_id():
            raise RuntimeError("Invalid read context owner")

    @contextmanager
    def borrow(self):
        self.check_owner()
        if not self.lock.acquire(blocking=False):
            raise RuntimeError("Invalid or concurrent read connection use")
        connection = ReadConnection(self)
        try:
            self.remaining()
            yield connection
        finally:
            connection.active = False
            self.lock.release()


@contextmanager
def repository_read_connection(connection=None, *, factory):
    frame = current_read_context()
    if frame:
        if connection is not None:
            raise RuntimeError("Read context owns the repository connection")
        with frame.borrow() as borrowed:
            yield borrowed
    elif connection is not None:
        yield connection  # caller owns its transaction; never commit here
    else:
        with factory() as borrowed:
            yield borrowed


@asynccontextmanager
async def read_scope():
    from . import db_pool

    started = monotonic()
    admission_deadline = started + ADMISSION_SECONDS
    admitted = await _worker(_slots.acquire, True, ADMISSION_SECONDS,
                             cancel_cleanup=lambda acquired: _slots.release() if acquired else None)
    if not admitted:
        raise capacity_error()
    manager, entered, token, frame, failure = None, False, None, None, None
    try:
        left = admission_deadline - monotonic()
        if left <= 0:
            raise capacity_error()
        manager = db_pool.db_connection(db_pool.db_connection_string(), autocommit=False, connect_timeout=left)
        try:
            raw = await _worker(manager.__enter__, cancel_cleanup=lambda raw: manager.__exit__(
                asyncio.CancelledError, asyncio.CancelledError(), None))
        except Exception as exc:
            from psycopg_pool import PoolTimeout
            if isinstance(exc, PoolTimeout):
                raise capacity_error() from exc
            raise
        entered = True
        frame = ReadContext(raw, started + READ_SECONDS, get_current_tenant_id(), asyncio.current_task())

        def begin():
            frame.remaining()
            raw.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            raw.execute("SET LOCAL statement_timeout='3s'")
            raw.execute("SET LOCAL lock_timeout='1s'")
        await _worker(begin)
        token = _current.set(frame)
        yield frame
        frame.remaining()
    except BaseException as exc:
        failure = exc
        raise
    finally:
        if token is not None:
            _current.reset(token)
        # Never put a connection back while a worker still uses it. Cleanup is
        # shielded from client disconnects, including BaseException cancellation.
        with anyio.CancelScope(shield=True):
            try:
                if entered:
                    def finish():
                        with frame.lock:
                            frame.closed = True
                            manager.__exit__(type(failure) if failure else None, failure,
                                             failure.__traceback__ if failure else None)
                    await _worker(finish)
            finally:
                _slots.release()
