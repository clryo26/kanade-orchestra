from __future__ import annotations

from contextlib import contextmanager
from threading import Lock
from typing import Any, Iterator

try:
    import psycopg as _real_psycopg
except Exception:  # pragma: no cover - optional dependency guard
    _real_psycopg = None

try:
    from psycopg_pool import ConnectionPool
except Exception:  # pragma: no cover - optional dependency guard
    ConnectionPool = None

from .db_config import db_connection_string
from .db_runtime import local_json_fallback_enabled


DB_POOL_MIN_SIZE = 1
DB_POOL_MAX_SIZE = 5

_pool: Any | None = None
_pool_dsn: str | None = None
_pool_lock = Lock()
_web_runtime_count = 0


@contextmanager
def web_database_runtime():
    """The lifespan, not importing main, makes pool-only access mandatory."""
    global _web_runtime_count
    with _pool_lock:
        _web_runtime_count += 1
    try:
        yield
    finally:
        with _pool_lock:
            _web_runtime_count -= 1


def open_db_pool() -> None:
    """Open the process-local synchronous database pool for application runtime."""
    global _pool, _pool_dsn

    from .collection_clock_schema import configured_paths
    reads, clocks = configured_paths()
    if local_json_fallback_enabled():
        if reads:
            raise ValueError("Snapshot reads require DB mode")
        return
    if _real_psycopg is None:
        raise RuntimeError("psycopg is not installed")
    if ConnectionPool is None:
        raise RuntimeError("psycopg-pool is not installed")

    dsn = db_connection_string()
    with _pool_lock:
        if _pool is not None:
            return

        pool = ConnectionPool(
            conninfo=dsn,
            min_size=DB_POOL_MIN_SIZE,
            max_size=DB_POOL_MAX_SIZE,
            kwargs={"autocommit": False},
            check=ConnectionPool.check_connection,
            open=False,
        )
        try:
            pool.open(wait=True)
            if clocks:
                from ..services.collection_clock_maintenance import verify_schema
                with pool.connection() as conn:
                    verify_schema(conn, require_application_role=True)
        except Exception:
            pool.close()
            raise

        _pool = pool
        _pool_dsn = dsn


def close_db_pool() -> None:
    """Close the process-local pool during application shutdown."""
    global _pool, _pool_dsn

    with _pool_lock:
        pool = _pool
        _pool = None
        _pool_dsn = None

    if pool is not None:
        pool.close()


@contextmanager
def db_connection(
    conninfo: str = "",
    *,
    autocommit: bool = False,
    connect_timeout: int | float | None = None,
    _require_pool: bool = False,
    **kwargs: Any,
) -> Iterator[Any]:
    """Web/read scopes require the pool; standalone maintenance may connect."""
    from .read_context import current_read_context

    if current_read_context() is not None:
        raise RuntimeError("Nested DB checkout in read context")
    pool = _pool
    pool_dsn = _pool_dsn

    if pool is None or conninfo != pool_dsn or kwargs:
        if _web_runtime_count or _require_pool:
            raise RuntimeError("Application database pool is unavailable or connection options do not match")
        if _real_psycopg is None:
            raise RuntimeError("psycopg is not installed")

        direct_kwargs = dict(kwargs)
        direct_kwargs["autocommit"] = autocommit
        if connect_timeout is not None:
            direct_kwargs["connect_timeout"] = connect_timeout

        with _real_psycopg.connect(conninfo, **direct_kwargs) as conn:
            yield conn
        return

    # Snapshot admission passes its remaining <=2s explicitly. Preserve the
    # existing pool/default wait for unrelated writes and dedicated APIs.
    timeout = float(connect_timeout) if connect_timeout is not None else None
    if timeout is not None and timeout <= 0:
        raise TimeoutError("Database pool wait budget expired")
    conn = pool.getconn(timeout=timeout)
    original_autocommit = conn.autocommit

    try:
        conn.autocommit = autocommit
        yield conn
        if not autocommit:
            conn.commit()
    except BaseException:
        if not autocommit:
            try:
                conn.rollback()
            except Exception:
                pass
        raise
    finally:
        try:
            conn.autocommit = original_autocommit
        finally:
            pool.putconn(conn)


class _PooledPsycopgAdapter:
    def connect(self, conninfo: str = "", **kwargs: Any):
        return db_connection(conninfo, **kwargs)

    def __getattr__(self, name: str) -> Any:
        if _real_psycopg is None:
            raise AttributeError(name)
        return getattr(_real_psycopg, name)


pooled_psycopg = _PooledPsycopgAdapter()


__all__ = [
    "DB_POOL_MAX_SIZE",
    "DB_POOL_MIN_SIZE",
    "close_db_pool",
    "db_connection",
    "open_db_pool",
    "pooled_psycopg",
]
