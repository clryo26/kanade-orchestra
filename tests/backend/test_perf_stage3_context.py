"""Deterministic admission/deadline/cancellation tests; PG tests cover SQL."""
from __future__ import annotations

import asyncio
from threading import Event
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

    async def acquire(self):
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
    monkeypatch.setattr(reads, "_get_slots", lambda: slots)
    return pool, slots


def test_defaults_and_shared_two_second_admission_budget(setup, monkeypatch):
    pool, slots = setup
    clock = [0.0]
    monkeypatch.setattr(reads, "monotonic", lambda: clock[0])
    async def acquire():
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
    async def rejected():
        return False
    monkeypatch.setattr(slots, "acquire", rejected)
    async def run():
        async with reads.read_scope():
            raise AssertionError("must not enter")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run())
    assert exc.value.status_code == 503 and exc.value.headers["Retry-After"] == "2"
    assert pool.timeouts == [] and slots.releases == 0


def test_waiting_request_enters_when_a_slot_is_released(setup, monkeypatch):
    pool, _ = setup
    async def run():
        slots = asyncio.BoundedSemaphore(1)
        await slots.acquire()
        monkeypatch.setattr(reads, "_get_slots", lambda: slots)
        async def release():
            await asyncio.sleep(0.03)
            slots.release()
        task = asyncio.create_task(release())
        async with reads.read_scope():
            assert len(pool.timeouts) == 1 and 0 < pool.timeouts[0] < 2
        await task
        assert slots._value == 1
    asyncio.run(run())


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
    async def wait_slot():
        started.set()
        await asyncio.Future()
    if cancel_at == "admission":
        monkeypatch.setattr(slots, "acquire", wait_slot)
    else:
        monkeypatch.setattr(pool, "getconn", wait_then_acquire)
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
    assert slots.releases == (1 if cancel_at == "connection" else 0)
    assert len(pool.returned) == (1 if cancel_at == "connection" else 0)


def test_pool_never_direct_connects_in_db_mode(setup, monkeypatch):
    pool, _ = setup
    monkeypatch.setattr(db_pool, "_pool", None)
    with db_pool.web_database_runtime(), pytest.raises(RuntimeError, match="pool"):
        with db_pool.db_connection("fake-isolated-dsn"):
            pass
    monkeypatch.setattr(db_pool, "_pool", pool)
    for kwargs in ({"conninfo": "other"}, {"conninfo": "fake-isolated-dsn", "row_factory": object()}):
        with db_pool.web_database_runtime(), pytest.raises(RuntimeError, match="pool"):
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


def test_read_scope_never_direct_connects_even_without_web_lifespan(setup, monkeypatch):
    from unittest.mock import MagicMock
    monkeypatch.setattr(db_pool, "_pool", None)
    direct = MagicMock(side_effect=AssertionError("Must not connect directly"))
    monkeypatch.setattr(db_pool._real_psycopg, "connect", direct)
    async def run():
        async with reads.read_scope():
            pass
    with pytest.raises(RuntimeError, match="pool"):
        asyncio.run(run())
    direct.assert_not_called()


def test_config_disallows_unprotected_clock_and_does_not_default_enable(monkeypatch):
    monkeypatch.delenv("PORTAL_READ_CONTEXT_PATHS", raising=False)
    monkeypatch.delenv("PORTAL_VERSION_ETAG_PATHS", raising=False)
    assert configured_paths() == (frozenset(), frozenset())
    monkeypatch.setenv("PORTAL_VERSION_ETAG_PATHS", "/api/schedules")
    with pytest.raises(ValueError):
        configured_paths()


@pytest.mark.parametrize("count", [41, 80])
def test_admission_does_not_starve_shared_worker_pool(monkeypatch, count):
    """More waiters than AnyIO's 40 tokens must leave DB workers runnable."""
    import anyio.to_thread
    from starlette.concurrency import run_in_threadpool
    pool = Pool()
    monkeypatch.setattr(db_pool, "_pool", pool)
    monkeypatch.setattr(db_pool, "_pool_dsn", "load-dsn")
    monkeypatch.setattr(db_pool, "db_connection_string", lambda: "load-dsn")
    active, peak = 0, 0
    async def run():
        limiter = anyio.to_thread.current_default_thread_limiter()
        previous = limiter.total_tokens
        limiter.total_tokens = 40
        try:
            async def request():
                nonlocal active, peak
                async with reads.read_scope():
                    active += 1
                    peak = max(peak, active)
                    await asyncio.sleep(0.001)
                    active -= 1
            requests = [asyncio.create_task(request()) for _ in range(count)]
            assert await run_in_threadpool(lambda: "unrelated sync API") == "unrelated sync API"
            await asyncio.gather(*requests)
        finally:
            limiter.total_tokens = previous
    asyncio.run(run())
    assert peak <= 4 and len(pool.returned) == count


def test_web_lifespan_requires_pool_before_open_and_until_closed(setup, monkeypatch):
    from src.backend.core.lifespan import build_lifespan
    monkeypatch.setattr(db_pool, "_pool", None)
    checked = []
    def unavailable():
        with pytest.raises(RuntimeError, match="pool"):
            with db_pool.db_connection("web-dsn"):
                pass
        checked.append(True)
    async def seed():
        unavailable()
    lifespan = build_lifespan(open_db_pool=unavailable, close_db_pool=unavailable,
                              startup_self_check=unavailable, seed_startup_data=seed)
    async def run():
        async with lifespan(None):
            unavailable()
    asyncio.run(run())
    assert len(checked) == 5 and db_pool._web_runtime_count == 0


@pytest.mark.parametrize("script", ["reset_promotions", "cleanup_sheet_storage"])
@pytest.mark.parametrize("environment", ["production", "test"])
def test_maintenance_script_dry_run_without_pool_in_db_mode(monkeypatch, script, environment):
    from importlib import import_module
    from unittest.mock import MagicMock
    from src.backend.core.tenant_context import set_current_tenant_id, reset_current_tenant_id
    monkeypatch.setenv("APP_ENV", environment)
    monkeypatch.setenv("DATA_BACKEND", "db")
    monkeypatch.setenv("LOCAL_JSON_FALLBACK_ENABLED", "false")
    monkeypatch.setenv("DB_URL", "maintenance-fixture-dsn")
    monkeypatch.setattr(db_pool, "_pool", None)
    assert db_pool._web_runtime_count == 0
    cursor = MagicMock()
    from datetime import datetime, timezone
    cursor.fetchone.return_value = {"name": "maintenance-fixture", "count": 0, "n": 0,
                                  "now": datetime(2026, 10, 23, tzinfo=timezone.utc)}
    cursor.fetchall.return_value = []
    connection = MagicMock()
    connection.__enter__.return_value = connection
    connection.cursor.return_value.__enter__.return_value = cursor
    connect = MagicMock(return_value=connection)
    monkeypatch.setattr(db_pool._real_psycopg, "connect", connect)
    args = [script, "--environment", environment, "--organization", "synthetic-maintenance",
            "--db-name", "maintenance-fixture"]
    if script == "reset_promotions":
        args += ["--maintenance-url", "https://not-called.invalid"]
    monkeypatch.setattr("sys.argv", args)
    token = set_current_tenant_id("synthetic-maintenance")
    try:
        import_module("scripts."+script).main()
    finally:
        reset_current_tenant_id(token)
    assert connect.call_count > 0 and db_pool._pool is None
    assert all(call.args[0] == "maintenance-fixture-dsn" for call in connect.call_args_list)
