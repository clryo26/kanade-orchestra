from __future__ import annotations


def test_config_status_endpoint_exposes_effective_mode_and_masked_values(client, monkeypatch):
    monkeypatch.setenv("DIAGNOSTIC_CONFIG_ENABLED", "true")
    monkeypatch.setenv("DIAGNOSTIC_CONFIG_REQUIRE_ADMIN", "false")
    monkeypatch.setenv("APP_ENV", "dev")
    monkeypatch.setenv("DATA_BACKEND", "db")
    monkeypatch.setenv("CORS_ORIGINS", "https://a.example, https://b.example")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_URL", "postgresql://orchestra:secret@localhost:5432/orchestra")
    monkeypatch.setenv("GCS_BUCKET", "kanade-bucket")
    monkeypatch.setenv("K_REVISION", "kanade-00042-abc")

    response = client.get("/api/diagnostic/config-status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["profile"] == "db"
    assert payload["corsConfigured"] is True
    assert payload["corsOriginCount"] == 2
    assert payload["cloudRunDetected"] is True
    assert payload["databaseHostMasked"] != "127.0.0.1"
    assert payload["gcsBucketMasked"] != "kanade-bucket"
    assert payload["cloudRunRevisionMasked"] != "kanade-00042-abc"
    assert "dbHost" not in payload
    assert "dbName" not in payload
    assert "dbUrlMasked" not in payload
    assert "corsOrigins" not in payload


def test_config_status_uses_default_values_when_env_missing(client, monkeypatch):
    monkeypatch.setenv("DIAGNOSTIC_CONFIG_ENABLED", "true")
    monkeypatch.setenv("DIAGNOSTIC_CONFIG_REQUIRE_ADMIN", "false")
    monkeypatch.setenv("APP_ENV", "dev")
    monkeypatch.delenv("DATA_BACKEND", raising=False)
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    monkeypatch.delenv("K_REVISION", raising=False)
    monkeypatch.delenv("CLOUD_RUN_REVISION", raising=False)

    response = client.get("/api/diagnostic/config-status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["profile"] == "db"
    assert payload["corsConfigured"] is False
    assert payload["corsOriginCount"] == 0
