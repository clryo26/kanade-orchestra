"""Operations ordering/failure guards, without running a restore or workflow."""
from pathlib import Path
import subprocess

import pytest

from scripts import restore_db


@pytest.mark.parametrize("failure", ["missing", "finalizer", None])
def test_restore_requires_post_restore_clock_finalization(monkeypatch, tmp_path, capsys, failure):
    backup = tmp_path / "synthetic.dump"
    backup.write_bytes(b"fixture")
    monkeypatch.setattr(restore_db.sys, "argv", ["restore_db", str(backup)])
    monkeypatch.setattr(restore_db, "db_url", lambda: "secret-fixture-dsn")
    states = iter([(True, "fixture-db"), (failure != "missing", "fixture-db")])
    monkeypatch.setattr(restore_db, "clock_state", lambda _: next(states))
    calls = []
    def run(args, **kwargs):
        calls.append((args, kwargs))
        if len(calls) == 2 and failure == "finalizer":
            raise subprocess.CalledProcessError(1, "clock finalizer")
    monkeypatch.setattr(restore_db.subprocess, "run", run)
    if failure:
        with pytest.raises((RuntimeError, subprocess.CalledProcessError)):
            restore_db.main()
    else:
        restore_db.main()
    assert calls[0][0][0] == "pg_restore"
    assert "--disable-triggers" not in calls[0][0]
    assert len(calls) == (1 if failure == "missing" else 2)
    if len(calls) == 2:
        assert "finalize" in calls[1][0] and "--execute" in calls[1][0]
        assert "secret-fixture-dsn" not in calls[1][0]
        assert calls[1][1]["env"]["RESTORE_CLOCK_DB_URL"] == "secret-fixture-dsn"
    output = capsys.readouterr().out
    assert "secret-fixture-dsn" not in output
    assert ("restore completed" in output) == (not failure)


def test_sync_orders_finalizer_after_gcs_before_release():
    source = Path(".github/workflows/sync-prod-to-test.yml").read_text(encoding="utf-8")
    gcs = source.index("- name: Synchronize approved production GCS")
    finalize = source.index("- name: Finalize TEST collection clocks")
    release = source.index("- name: Disable test maintenance")
    assert gcs < finalize < release
    assert "inputs.dry_run == 'false' && success()" in source[finalize:release]
    assert "sync_scope" not in source[finalize:release]  # includes gcs_only
