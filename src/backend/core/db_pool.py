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


def open_db_pool() -> None:
    """Open the process-local synchronous database pool for application runtime."""
    global _pool, _pool_dsn

    if local_json_fallback_enabled():
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
            open=False,
        )
        try:
            pool.open(wait=True)
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
    **kwargs: Any,
) -> Iterator[Any]:
    """Return a pooled application connection, or preserve direct-connect fallback semantics."""
    pool = _pool
    pool_dsn = _pool_dsn

    if pool is None or conninfo != pool_dsn or kwargs:
        if _real_psycopg is None:
            raise RuntimeError("psycopg is not installed")

        direct_kwargs = dict(kwargs)
        direct_kwargs["autocommit"] = autocommit
        if connect_timeout is not None:
            direct_kwargs["connect_timeout"] = connect_timeout

        with _real_psycopg.connect(conninfo, **direct_kwargs) as conn:
            yield conn
        return

    timeout = float(connect_timeout) if connect_timeout is not None else None
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


pooled_psycopg = _PooledPsycopgAdapter() if _real_psycopg is not None else None


__all__ = [
    "DB_POOL_MAX_SIZE",
    "DB_POOL_MIN_SIZE",
    "close_db_pool",
    "db_connection",
    "open_db_pool",
    "pooled_psycopg",
]
