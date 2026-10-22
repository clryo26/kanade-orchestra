"""DB clocks are always read in the same snapshot as the response."""
from __future__ import annotations

from collections import OrderedDict
from threading import Lock

from ..core.read_context import ClockAnomaly

_observed: OrderedDict[tuple, int] = OrderedDict()
_observation_lock = Lock()


def load_versions(frame, collections):
    requested = set(collections)
    try:
        with frame.borrow() as conn, conn.cursor() as cur:
            cur.execute("SELECT g.generation,v.collection_name,v.version "
                        "FROM public.portal_data_generation g LEFT JOIN public.portal_collection_versions v "
                        "ON v.organization_id=%s AND v.collection_name=ANY(%s) WHERE g.singleton=1",
                        (frame.tenant, sorted(requested)))
            rows = cur.fetchall()
    except Exception as exc:
        # Do not leak raw SQL/connection details or revive process-cache validators.
        from fastapi import HTTPException
        from psycopg.errors import QueryCanceled, LockNotAvailable
        if isinstance(exc, (HTTPException, QueryCanceled, LockNotAvailable)):
            raise
        raise ClockAnomaly("Clock metadata unavailable") from exc
    versions = {name: int(version) for _, name, version in rows if name is not None and version is not None}
    if not rows or set(versions) != requested or any(v <= 0 for v in versions.values()):
        raise ClockAnomaly("Missing collection version")
    generation = str(rows[0][0])
    # Compare successive snapshots on the same backend, never completion order
    # across concurrent RR connections (an older snapshot may finish later).
    with _observation_lock:
        for name, version in versions.items():
            key = (generation, frame.tenant, name, frame.raw.info.backend_pid)
            previous = _observed.get(key)
            if previous is not None and version < previous:
                raise ClockAnomaly("Collection version moved backwards")
            _observed[key] = version
            _observed.move_to_end(key)
        while len(_observed) > 4096:
            _observed.popitem(last=False)
    frame.generation, frame.versions = generation, versions
    return generation, versions
