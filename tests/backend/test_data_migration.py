from __future__ import annotations


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
