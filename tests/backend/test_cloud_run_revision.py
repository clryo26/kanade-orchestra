from __future__ import annotations


def test_cloud_run_revision_prefers_k_revision(backend_env, monkeypatch):
    monkeypatch.setenv("K_REVISION", "kanade-orchestra-00060-hsf")
    monkeypatch.setenv("CLOUD_RUN_REVISION", "legacy-revision")

    assert backend_env.cloud_run_revision() == "kanade-orchestra-00060-hsf"


def test_cloud_run_revision_falls_back_to_legacy_env(backend_env, monkeypatch):
    monkeypatch.delenv("K_REVISION", raising=False)
    monkeypatch.setenv("CLOUD_RUN_REVISION", "legacy-revision")

    assert backend_env.cloud_run_revision() == "legacy-revision"


def test_revision_endpoint_returns_uncached_cloud_run_revision(client, monkeypatch):
    monkeypatch.setenv("K_REVISION", "kanade-orchestra-00060-hsf")

    response = client.get("/api/revision")

    assert response.status_code == 200
    assert response.json()["cloudRunRevision"] == "kanade-orchestra-00060-hsf"
    assert response.headers["cache-control"] == "no-store"
