from __future__ import annotations

import pytest

from src.backend.services import meta_service


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


def test_index_html_static_asset_urls_append_revision_only_for_local_assets():
    html = """
    <html>
      <head>
        <link rel="stylesheet" href="/static/css/style.css?v=20260701-1">
        <link rel="stylesheet" href="/static/css/mobile_fixes.css">
        <script src="/static/js/main.js?v=20260630-6"></script>
        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
      </head>
    </html>
    """

    rewritten = meta_service.rewrite_index_html_static_asset_urls(html, "kanade-00042-abc")

    assert '/static/css/style.css?v=20260701-1&rev=kanade-00042-abc' in rewritten
    assert '/static/css/mobile_fixes.css?rev=kanade-00042-abc' in rewritten
    assert '/static/js/main.js?v=20260630-6&rev=kanade-00042-abc' in rewritten
    assert 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js' in rewritten


def test_index_html_static_asset_urls_do_not_change_without_revision():
    html = '<link rel="stylesheet" href="/static/css/style.css?v=20260701-1">'

    assert meta_service.rewrite_index_html_static_asset_urls(html, "") == html


def test_root_returns_html_and_revision_busts_static_assets(client, monkeypatch):
    monkeypatch.setenv("K_REVISION", "kanade-00042-abc")

    response = client.get("/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "&rev=kanade-00042-abc" in response.text
    assert "https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" in response.text


def test_root_without_revision_keeps_existing_html(client, monkeypatch):
    monkeypatch.delenv("K_REVISION", raising=False)
    monkeypatch.delenv("CLOUD_RUN_REVISION", raising=False)

    response = client.get("/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "&rev=" not in response.text
