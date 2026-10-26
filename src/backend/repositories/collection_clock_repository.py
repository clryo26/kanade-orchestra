"""DB clocks are always read in the same snapshot as the response."""
from __future__ import annotations

from collections import OrderedDict
from threading import Lock
from psycopg import sql

from ..core.read_context import ClockAnomaly
from ..core.collection_clock_schema import CLOCK_COLLECTIONS, table_dependencies

_observed: OrderedDict[tuple, int] = OrderedDict()
_observation_lock = Lock()


def load_versions(frame, collections):
    requested = set(collections)
    if not requested or not requested <= set(CLOCK_COLLECTIONS):
        raise ClockAnomaly("Unknown clock dependency")
    try:
        with frame.borrow() as conn, conn.cursor() as cur:
            cur.execute("SELECT g.generation,v.collection_name,v.version "
                        "FROM public.portal_data_generation g LEFT JOIN public.portal_collection_versions v "
                        "ON v.organization_id=%s AND v.collection_name=ANY(%s) WHERE g.singleton=1",
                        (frame.tenant, sorted(requested)))
            rows = cur.fetchall()
            if not rows:
                raise ClockAnomaly("Missing environment generation")
            versions = {name: int(version) for _, name, version in rows
                        if name is not None and version is not None}
            if any(v <= 0 for v in versions.values()):
                raise ClockAnomaly("Invalid stored collection version")
            missing = requested - versions.keys()
            if missing:
                # An unregistered/unused tenant is a normal public empty list.
                # Prove emptiness in this same RR snapshot before assigning 0;
                # a lost clock alongside real data must still fail closed.
                checks, params = [], []
                for table, collection in table_dependencies().items():
                    if collection in missing:
                        checks.append(sql.SQL("SELECT %s WHERE EXISTS(SELECT 1 FROM public.{} "
                                              "WHERE organization_id=%s)").format(sql.Identifier(table)))
                        params.extend((collection, frame.tenant))
                cur.execute(sql.SQL(" UNION ALL ").join(checks), params)
                if cur.fetchone() is not None:
                    raise ClockAnomaly("Collection data exists without its version")
                versions.update(dict.fromkeys(missing, 0))
    except Exception as exc:
        # Do not leak raw SQL/connection details or revive process-cache validators.
        from fastapi import HTTPException
        from psycopg.errors import QueryCanceled, LockNotAvailable
        if isinstance(exc, (ClockAnomaly, HTTPException, QueryCanceled, LockNotAvailable)):
            raise
        raise ClockAnomaly("Clock metadata unavailable") from exc
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
