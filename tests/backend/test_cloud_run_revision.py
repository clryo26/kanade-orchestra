from __future__ import annotations

import pytest


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
    monkeypatch.setenv("APP_ENV", " TeSt ")
    monkeypatch.setenv(
        "OTHER_ENVIRONMENT_URL",
        "https://kanade-orchestra-apmcj4meeq-dt.a.run.app",
    )

    response = client.get("/api/revision")

    assert response.status_code == 200
    assert response.json()["cloudRunRevision"] == "kanade-orchestra-00060-hsf"
    assert response.json()["appEnv"] == "test"
    assert response.json()["otherEnvironmentUrl"] == "https://kanade-orchestra-apmcj4meeq-dt.a.run.app"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "configured_url",
    [
        "",
        "not-a-url",
        "http://kanade-orchestra.example",
        "https://user:password@kanade-orchestra.example",
    ],
)
def test_revision_endpoint_hides_missing_or_invalid_other_environment_url(client, monkeypatch, configured_url):
    monkeypatch.setenv("OTHER_ENVIRONMENT_URL", configured_url)

    response = client.get("/api/revision")

    assert response.status_code == 200
    assert response.json()["otherEnvironmentUrl"] == ""


def test_manifest_endpoint_uses_organization_short_name(client, backend_env, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    backend_env.save_json_data(
        "org_settings",
        [{"id": 1, "name": "奏オーケストラ", "short_name": "奏オケ"}],
    )

    response = client.get("/manifest.webmanifest")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/manifest+json")
    payload = response.json()
    assert payload["name"] == "奏オケポータル"
    assert payload["short_name"] == "奏オケポータル"
    assert response.headers["cache-control"] == "no-store, no-cache, must-revalidate, max-age=0"


@pytest.mark.parametrize(
    ("app_env", "expected_title"),
    [
        ("production", "奏オケポータル"),
        ("test", "奏オケポータル(テスト環境)"),
        ("dev", "奏オケポータル"),
    ],
)
def test_manifest_endpoint_uses_environment_title(client, backend_env, monkeypatch, app_env, expected_title):
    monkeypatch.setenv("APP_ENV", app_env)
    backend_env.save_json_data(
        "org_settings",
        [{"id": 1, "name": "奏オーケストラ", "short_name": "奏オケ"}],
    )

    response = client.get("/manifest.webmanifest")

    assert response.status_code == 200
    assert response.json()["name"] == expected_title
    assert response.json()["short_name"] == expected_title
