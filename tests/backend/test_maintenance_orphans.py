from __future__ import annotations


def test_maintenance_orphans_ignores_type_mismatch_for_foreign_keys(client, backend_env, seed_device_fn):
    """FK が文字列でも親IDが存在すれば孤立扱いしない。"""
    seed_device_fn(device_id="dev-admin", permission="管理者")

    backend_env.save_json_data(
        "performances",
        [{"id": 1, "title": "Perf-1", "date": "2026-07-01"}],
    )
    backend_env.save_json_data(
        "piece_infos",
        [{"id": 10, "performance_id": "1", "piece": "Symphony", "description": "alive"}],
    )

    response = client.get("/api/maintenance/orphans", headers={"X-Device-Id": "dev-admin"})
    assert response.status_code == 200

    payload = response.json()
    assert payload["total"] == 0
    assert "piece_infos" not in payload["orphans"]


def test_maintenance_orphans_detects_missing_performance_reference(client, backend_env, seed_device_fn):
    """親演奏会が無い piece_infos は孤立として検出する。"""
    seed_device_fn(device_id="dev-admin", permission="管理者")

    backend_env.save_json_data("performances", [{"id": 1, "title": "Perf-1", "date": "2026-07-01"}])
    backend_env.save_json_data(
        "piece_infos",
        [
            {"id": 11, "performance_id": "999", "piece": "Orphan", "description": "orphan"},
            {"id": 12, "performance_id": "1", "piece": "Alive", "description": "alive"},
        ],
    )

    response = client.get("/api/maintenance/orphans", headers={"X-Device-Id": "dev-admin"})
    assert response.status_code == 200

    payload = response.json()
    assert payload["summary"].get("piece_infos") == 1
    orphan_ids = {item.get("id") for item in payload["orphans"].get("piece_infos", [])}
    assert orphan_ids == {11}
