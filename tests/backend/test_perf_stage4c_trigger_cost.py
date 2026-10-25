"""DB-only trigger cost samples; not HTTP/Cloud Run latency or pool capacity."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
from threading import Barrier
from time import perf_counter

import psycopg
from psycopg import sql
import pytest

from test_perf_stage4c_refs_postgres import environment as base_environment
from test_perf_stage4_postgres import isolated_db as isolated_db  # noqa: F401
from test_perf_stage3a_postgres import TENANT


SAMPLES = []
FUNCTIONS = ("album_require_write_protocol", "album_detach_changed_photo_asset")
TRIGGERS = (("albums", "album_write_protocol"), ("albums", "album_truncate_protocol"), ("album_photos", "album_photo_write_protocol"), ("album_photos", "album_photo_truncate_protocol"), ("album_photos", "album_photo_detach_asset"))


@pytest.fixture(scope="module", autouse=True)
def report_samples():
    yield
    target = os.getenv("PORTAL_STAGE4C_REF_COST_REPORT", "")
    if target:
        path = Path(target).resolve()
        assert path.parent == (Path.cwd() / "docs/perf_stage4").resolve()
        assert path.name in {"STAGE4C_REF_COST_PG16.json", "STAGE4C_REF_COST_PG18.json"}
        with path.open("x", encoding="utf-8") as out:
            json.dump({"samples": SAMPLES, "limits": "Synthetic owned loopback DB, raw SQL excludes parent writes/auth/audit/pool limits. Concurrent wave holds eight distinct-photo transactions at a barrier. Timing excludes connect/barrier/commit, is hardware/load sensitive, and is not production latency."}, out, indent=2)
            out.write("\n")


@pytest.fixture
def environment(monkeypatch, request):
    yield from base_environment.__wrapped__(monkeypatch, request)


def counters(conn):
    values = {name: 0 for name in FUNCTIONS}
    values.update(conn.execute("SELECT funcname,calls FROM pg_stat_xact_user_functions WHERE funcname=ANY(%s)", (list(FUNCTIONS),)).fetchall())
    return values


def timed_statement(conn, query, params):
    before = counters(conn)
    started = perf_counter()
    cursor = conn.execute(query, params)
    elapsed = (perf_counter() - started) * 1000
    after = counters(conn)
    return {"sql_ms": elapsed, "affected_rows": cursor.rowcount, "function_calls": {key: after[key] - before[key] for key in FUNCTIONS}}


@pytest.mark.parametrize("environment", [1], indirect=True)
def test_batch_and_parallel_overhead_with_disabled_control_row(environment):
    dsn = environment["dsn"]
    with psycopg.connect(dsn, connect_timeout=5, autocommit=True) as conn:
        for name in ("024_album_asset_ledger_foundation.sql", "025_album_write_protocol.sql", "026_album_photo_asset_references.sql"):
            with conn.transaction():
                conn.execute((Path("db/migrations") / name).read_text(encoding="utf-8"))
        conn.execute("INSERT INTO album_asset_gc_control(environment_uuid,bucket) VALUES (gen_random_uuid(),'synthetic-album-fixture')")
        conn.execute("SET track_functions='pl'")
        operations = {
            "insert_25": "INSERT INTO album_photos(id,organization_id,album_id,filename,object_name,created_at,updated_at) SELECT 50000+i,%s,1,'sample.jpg','albums/synthetic/'||i,clock_timestamp(),clock_timestamp() FROM generate_series(1,25) i",
            "delete_25": "DELETE FROM album_photos WHERE organization_id=%s AND id BETWEEN 1 AND 25",
        }
        for enabled in (False, True):
            for table, trigger in TRIGGERS:
                conn.execute(sql.SQL("ALTER TABLE {} {} TRIGGER {}").format(sql.Identifier(table), sql.SQL("ENABLE" if enabled else "DISABLE"), sql.Identifier(trigger)))
            for case, query in operations.items():
                rows = []
                for _ in range(5):
                    with conn.transaction(force_rollback=True):
                        row = timed_statement(conn, query, (TENANT,))
                        assert row["affected_rows"] == 25
                        assert row["function_calls"] == {FUNCTIONS[0]: 25 if enabled else 0, FUNCTIONS[1]: 0}
                        rows.append(row)
                SAMPLES.append({"case": case, "user_triggers_enabled": enabled, "control_present": True, "guard_enabled": False, "samples": rows})

            start, finish = Barrier(8, timeout=15), Barrier(8, timeout=15)

            def writer(index):
                with psycopg.connect(dsn, connect_timeout=5, autocommit=True) as other:
                    other.execute("SET track_functions='pl'")
                    other.execute("SET statement_timeout='15s'")
                    with other.transaction(force_rollback=True):
                        start.wait()
                        row = timed_statement(other, "UPDATE album_photos SET filename='concurrent-fixture.jpg' WHERE organization_id=%s AND id=%s", (TENANT, index * 25 + 1))
                        assert row["affected_rows"] == 1
                        assert row["function_calls"] == {FUNCTIONS[0]: 1 if enabled else 0, FUNCTIONS[1]: 1 if enabled else 0}
                        # All eight writes complete before any transaction ends:
                        # this catches an accidental exclusive control-row lock.
                        finish.wait()
                        return row

            with ThreadPoolExecutor(max_workers=8) as executor:
                rows = list(executor.map(writer, range(8)))
            SAMPLES.append({"case": "eight_parallel_distinct_photos", "user_triggers_enabled": enabled, "control_present": True, "guard_enabled": False, "samples": rows})
        assert conn.execute("SELECT count(*) FROM album_photos").fetchone() == (500,)
