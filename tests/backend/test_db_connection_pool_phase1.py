from __future__ import annotations

import asyncio

import pytest

from src.backend.core import db_pool
from src.backend.core.lifespan import build_lifespan


class _FakeConnection:
    def __init__(self) -> None:
        self.autocommit = False
        self.commit_count = 0
        self.rollback_count = 0

    def commit(self) -> None:
        self.commit_count += 1

    def rollback(self) -> None:
        self.rollback_count += 1


class _FakeCheckoutPool:
    def __init__(self, connection: _FakeConnection) -> None:
        self.connection = connection
        self.getconn_timeouts: list[float | None] = []
        self.returned: list[_FakeConnection] = []

    def getconn(self, timeout: float | None = None) -> _FakeConnection:
        self.getconn_timeouts.append(timeout)
        return self.connection

    def putconn(self, connection: _FakeConnection) -> None:
        self.returned.append(connection)


def _reset_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(db_pool, "_pool", None)
    monkeypatch.setattr(db_pool, "_pool_dsn", None)


def test_open_pool_uses_bounded_phase1_sizes(monkeypatch: pytest.MonkeyPatch) -> None:
    _reset_pool(monkeypatch)
    created: list[object] = []

    class FakePool:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.open_calls: list[bool] = []
            self.closed = False
            created.append(self)

        def open(self, *, wait: bool = False) -> None:
            self.open_calls.append(wait)

        def close(self) -> None:
            self.closed = True

    monkeypatch.setattr(db_pool, "ConnectionPool", FakePool)
    monkeypatch.setattr(db_pool, "local_json_fallback_enabled", lambda: False)
    monkeypatch.setattr(db_pool, "db_connection_string", lambda: "postgresql://pool-test")

    db_pool.open_db_pool()

    assert len(created) == 1
    pool = created[0]
    assert pool.kwargs["conninfo"] == "postgresql://pool-test"
    assert pool.kwargs["min_size"] == 1
    assert pool.kwargs["max_size"] == 5
    assert pool.kwargs["kwargs"] == {"autocommit": False}
    assert pool.kwargs["open"] is False
    assert pool.open_calls == [True]

    db_pool.close_db_pool()
    assert pool.closed is True


def test_local_json_mode_does_not_create_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    _reset_pool(monkeypatch)

    class UnexpectedPool:
        def __init__(self, **kwargs):
            raise AssertionError(f"pool must not be created: {kwargs}")

    monkeypatch.setattr(db_pool, "ConnectionPool", UnexpectedPool)
    monkeypatch.setattr(db_pool, "local_json_fallback_enabled", lambda: True)
    monkeypatch.setattr(
        db_pool,
        "db_connection_string",
        lambda: (_ for _ in ()).throw(AssertionError("DB config must not be read")),
    )

    db_pool.open_db_pool()

    assert db_pool._pool is None
    assert db_pool._pool_dsn is None


def test_pooled_transaction_commits_and_returns_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = _FakeConnection()
    pool = _FakeCheckoutPool(connection)
    monkeypatch.setattr(db_pool, "_pool", pool)
    monkeypatch.setattr(db_pool, "_pool_dsn", "postgresql://pool-test")

    with db_pool.db_connection("postgresql://pool-test", autocommit=False) as checked_out:
        assert checked_out is connection

    assert connection.commit_count == 1
    assert connection.rollback_count == 0
    assert connection.autocommit is False
    assert pool.returned == [connection]


def test_pooled_transaction_rolls_back_on_error(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = _FakeConnection()
    pool = _FakeCheckoutPool(connection)
    monkeypatch.setattr(db_pool, "_pool", pool)
    monkeypatch.setattr(db_pool, "_pool_dsn", "postgresql://pool-test")

    with pytest.raises(RuntimeError, match="boom"):
        with db_pool.db_connection("postgresql://pool-test", autocommit=False):
            raise RuntimeError("boom")

    assert connection.commit_count == 0
    assert connection.rollback_count == 1
    assert connection.autocommit is False
    assert pool.returned == [connection]


def test_pooled_autocommit_does_not_issue_explicit_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = _FakeConnection()
    pool = _FakeCheckoutPool(connection)
    monkeypatch.setattr(db_pool, "_pool", pool)
    monkeypatch.setattr(db_pool, "_pool_dsn", "postgresql://pool-test")

    with db_pool.db_connection(
        "postgresql://pool-test",
        autocommit=True,
        connect_timeout=2,
    ):
        assert connection.autocommit is True

    assert connection.commit_count == 0
    assert connection.rollback_count == 0
    assert connection.autocommit is False
    assert pool.getconn_timeouts == [2.0]
    assert pool.returned == [connection]


def test_lifespan_opens_pool_before_startup_and_closes_after_shutdown() -> None:
    events: list[str] = []

    async def seed() -> None:
        events.append("seed")

    lifespan = build_lifespan(
        startup_self_check=lambda: events.append("startup"),
        seed_startup_data=seed,
        open_db_pool=lambda: events.append("open"),
        close_db_pool=lambda: events.append("close"),
    )

    async def exercise() -> None:
        async with lifespan(None):
            events.append("inside")

    asyncio.run(exercise())

    assert events == ["open", "startup", "seed", "inside", "close"]


def test_lifespan_closes_pool_when_startup_check_fails() -> None:
    events: list[str] = []

    def fail_startup() -> None:
        events.append("startup")
        raise RuntimeError("startup failed")

    async def seed() -> None:
        events.append("seed")

    lifespan = build_lifespan(
        startup_self_check=fail_startup,
        seed_startup_data=seed,
        open_db_pool=lambda: events.append("open"),
        close_db_pool=lambda: events.append("close"),
    )

    async def exercise() -> None:
        async with lifespan(None):
            events.append("inside")

    with pytest.raises(RuntimeError, match="startup failed"):
        asyncio.run(exercise())

    assert events == ["open", "startup", "close"]
