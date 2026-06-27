from __future__ import annotations

import subprocess


def test_data_migration_dry_run_uses_available_script_and_snapshot(client, backend_env, seed_device_fn):
    seed_device_fn(device_id="dev-system", permission="システム管理者")
    backend_env.save_json_data(
        "performances",
        [{"id": 1, "title": "Migration Dry Run", "date": "2026-07-01", "pieces": []}],
    )

    response = client.post(
        "/api/system/data-migration",
        json={"dry_run": True, "truncate": False},
        headers={"X-Device-Id": "dev-system"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["dry_run"] is True
    assert "Migration row counts:" in payload["output"]
    assert "Dry-run mode: no DB changes applied." in payload["output"]


def test_data_migration_execute_deletes_json_files_after_matched_migration(
    client,
    backend_env,
    seed_device_fn,
    monkeypatch,
):
    seed_device_fn(device_id="dev-system", permission="システム管理者")
    backend_env.save_json_data(
        "performances",
        [{"id": 1, "title": "Migrated", "date": "2026-07-01", "pieces": []}],
    )
    assert backend_env.data_file("performances").exists()
    monkeypatch.setenv("DB_URL", "postgresql://example")

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="Migration completed successfully.\nRECONCILIATION_RESULT: MATCHED\n",
            stderr="",
        )

    monkeypatch.setattr(backend_env.subprocess, "run", fake_run)

    response = client.post(
        "/api/system/data-migration",
        json={"dry_run": False, "truncate": True},
        headers={"X-Device-Id": "dev-system"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["reconciliation_match"] is True
    assert "performances.json" in payload["migration_cleanup"]["local_files"]
    assert not backend_env.data_file("performances").exists()
    assert backend_env.load_json_data("performances") == []
