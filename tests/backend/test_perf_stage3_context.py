"""Deterministic admission/deadline/cancellation tests; PG tests cover SQL."""
from __future__ import annotations

import asyncio
from threading import BoundedSemaphore, Event, Timer
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from src.backend.core import db_pool, read_context as reads
from src.backend.core.collection_clock_schema import configured_paths


class Connection:
    def __init__(self):
        self.autocommit = False
        self.commands = []
        self.commits = self.rollbacks = 0
        self.info = SimpleNamespace(backend_pid=1)

    def execute(self, query, *args):
        self.commands.append(query)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class Pool:
    def __init__(self):
        self.connection = Connection()
        self.timeouts = []
        self.returned = []

    def getconn(self, timeout=None):
        self.timeouts.append(timeout)
        return self.connection

    def putconn(self, connection):
        self.returned.append(connection)


class Slots:
    def __init__(self):
        self.releases = 0

    def acquire(self, blocking, timeout):
        return True

    def release(self):
        self.releases += 1


@pytest.fixture
def setup(monkeypatch):
    pool, slots = Pool(), Slots()
    monkeypatch.setattr(db_pool, "_pool", pool)
    monkeypatch.setattr(db_pool, "_pool_dsn", "fake-isolated-dsn")
    monkeypatch.setattr(db_pool, "db_connection_string", lambda: "fake-isolated-dsn")
    monkeypatch.setattr(db_pool, "local_json_fallback_enabled", lambda: False)
    monkeypatch.setattr(reads, "_slots", slots)
    return pool, slots


def test_defaults_and_shared_two_second_admission_budget(setup, monkeypatch):
    pool, slots = setup
    clock = [0.0]
    monkeypatch.setattr(reads, "monotonic", lambda: clock[0])
    def acquire(*args):
        clock[0] = 1.5
        return True
    monkeypatch.setattr(slots, "acquire", acquire)
    assert reads.ADMISSION_SECONDS == 2 and reads.READ_SECONDS == 5 and reads.SQL_SECONDS == 3
    async def run():
        async with reads.read_scope() as frame:
            assert frame.deadline == 5
    asyncio.run(run())
    assert pool.timeouts == [0.5]
    assert slots.releases == 1 and pool.returned == [pool.connection]


def test_admission_rejection_does_not_request_db_connection(setup, monkeypatch):
    pool, slots = setup
    monkeypatch.setattr(slots, "acquire", lambda *a: False)
    async def run():
        async with reads.read_scope():
            raise AssertionError("must not enter")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run())
    assert exc.value.status_code == 503 and exc.value.headers["Retry-After"] == "2"
    assert pool.timeouts == [] and slots.releases == 0


def test_waiting_request_enters_when_a_slot_is_released(setup, monkeypatch):
    pool, _ = setup
    slots = BoundedSemaphore(1)
    slots.acquire()
    monkeypatch.setattr(reads, "_slots", slots)
    release = Timer(0.03, slots.release)
    release.start()
    async def run():
        async with reads.read_scope():
            assert len(pool.timeouts) == 1 and 0 < pool.timeouts[0] < 2
    try:
        asyncio.run(run())
    finally:
        release.join()
    assert slots.acquire(blocking=False)
    slots.release()


def test_global_deadline_is_not_reset_after_connection(setup, monkeypatch):
    pool, slots = setup
    clock = [0.0]
    monkeypatch.setattr(reads, "monotonic", lambda: clock[0])
    async def run():
        async with reads.read_scope():
            clock[0] = 5.01
    with pytest.raises(HTTPException):
        asyncio.run(run())
    assert pool.connection.rollbacks == 1 and slots.releases == 1


@pytest.mark.parametrize("cancel_at", ["admission", "connection"])
def test_native_task_cancellation_never_loses_resource_lease(setup, monkeypatch, cancel_at):
    pool, slots = setup
    started, release = Event(), Event()
    def wait_then_acquire(*args, **kwargs):
        started.set()
        assert release.wait(3)
        if cancel_at == "connection":
            pool.timeouts.append(kwargs["timeout"])
            return pool.connection
        return True
    monkeypatch.setattr(slots if cancel_at == "admission" else pool,
                        "acquire" if cancel_at == "admission" else "getconn", wait_then_acquire)
    async def scope():
        async with reads.read_scope():
            raise AssertionError("cancelled scope must not enter")
    async def run():
        task = asyncio.create_task(scope())
        while not started.is_set():
            await asyncio.sleep(0.001)
        task.cancel()
        await asyncio.sleep(0)
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(run())
    assert slots.releases == 1
    assert len(pool.returned) == (1 if cancel_at == "connection" else 0)


def test_pool_never_direct_connects_in_db_mode(setup, monkeypatch):
    pool, _ = setup
    monkeypatch.setattr(db_pool, "_pool", None)
    with pytest.raises(RuntimeError, match="pool"):
        with db_pool.db_connection("fake-isolated-dsn"):
            pass
    monkeypatch.setattr(db_pool, "_pool", pool)
    for kwargs in ({"conninfo": "other"}, {"conninfo": "fake-isolated-dsn", "row_factory": object()}):
        with pytest.raises(RuntimeError, match="pool"):
            with db_pool.db_connection(**kwargs):
                pass
    assert pool.timeouts == []


def test_unrelated_pool_wait_and_write_lock_contract_are_unchanged(setup):
    pool, _ = setup
    from src.backend.repositories.db_item_repository import LOCK_TIMEOUT
    assert LOCK_TIMEOUT == "5s"
    with db_pool.db_connection("fake-isolated-dsn", autocommit=True):
        pass
    with db_pool.db_connection("fake-isolated-dsn", autocommit=True, connect_timeout=10):
        pass
    assert pool.timeouts == [None, 10]


def test_config_disallows_unprotected_clock_and_does_not_default_enable(monkeypatch):
    monkeypatch.delenv("PORTAL_READ_CONTEXT_PATHS", raising=False)
    monkeypatch.delenv("PORTAL_VERSION_ETAG_PATHS", raising=False)
    assert configured_paths() == (frozenset(), frozenset())
    monkeypatch.setenv("PORTAL_VERSION_ETAG_PATHS", "/api/schedules")
    with pytest.raises(ValueError):
        configured_paths()
