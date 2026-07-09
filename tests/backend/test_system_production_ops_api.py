from __future__ import annotations

from importlib import reload


def _seed(client, *, device_id: str, permission: str, hidden_user: bool = False):
    payload = {
        "id": 1,
        "device_id": device_id,
        "member_id": 1,
        "member_name": "Tester",
        "member_part": "System",
        "permission": permission,
        "hidden_user": hidden_user,
        "authenticated_at": "2026-07-07T00:00:00",
        "last_seen_at": "2026-07-07T00:00:00",
    }
    from src.backend import main as backend

    devices = backend.load_json_data("auth_devices")
    payload["id"] = backend.next_id(devices)
    devices.append(payload)
    backend.save_json_data("auth_devices", devices)


def _promote(
    client,
    headers: dict[str, str],
    target_sha: str = "abc123def456",
    image_digest: str = "sha256:testdigest",
):
    return client.post(
        "/api/system/release/promote",
        headers=headers,
        json={"target_git_sha": target_sha, "target_image_digest": image_digest},
    )


def _sync(client, headers: dict[str, str], target_sha: str = "abc123def456"):
    return client.post(
        "/api/system/sync/prod-to-test",
        headers=headers,
        json={"target_git_sha": target_sha},
    )


def test_general_member_direct_api_calls_are_forbidden(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    _seed(client, device_id="dev-member", permission="一般")
    headers = {"X-Device-Id": "dev-member"}

    assert _promote(client, headers).status_code == 403
    assert _sync(client, headers).status_code == 403


def test_admin_direct_api_calls_are_forbidden(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    _seed(client, device_id="dev-admin", permission="管理者")
    headers = {"X-Device-Id": "dev-admin"}

    assert _promote(client, headers).status_code == 403
    assert _sync(client, headers).status_code == 403


def test_hidden_system_admin_direct_api_calls_are_forbidden(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    _seed(client, device_id="dev-hidden", permission="システム管理者", hidden_user=True)
    headers = {"X-Device-Id": "dev-hidden"}

    assert _promote(client, headers).status_code == 403
    assert _sync(client, headers).status_code == 403


def test_environment_status_requires_test_env(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    _seed(client, device_id="dev-system", permission="システム管理者")

    response = client.get("/api/system/environment/status", headers={"X-Device-Id": "dev-system"})
    assert response.status_code == 403


def test_environment_status_rejects_hidden_admin(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    _seed(client, device_id="dev-hidden", permission="システム管理者", hidden_user=True)

    response = client.get("/api/system/environment/status", headers={"X-Device-Id": "dev-hidden"})
    assert response.status_code == 403
    assert response.json().get("detail") == "隠しシステム管理者では本番リリース・本番同期を実行できません"


def test_environment_status_accepts_normal_system_admin_in_test(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    _seed(client, device_id="dev-system", permission="システム管理者")

    response = client.get("/api/system/environment/status", headers={"X-Device-Id": "dev-system"})
    assert response.status_code == 200
    payload = response.json()
    assert payload.get("app_env") == "test"
    assert payload.get("can_manage_operations") is True


def test_environment_status_rejects_when_app_env_unset(client, monkeypatch):
    monkeypatch.delenv("APP_ENV", raising=False)
    _seed(client, device_id="dev-system", permission="システム管理者")

    response = client.get("/api/system/environment/status", headers={"X-Device-Id": "dev-system"})
    assert response.status_code == 403


def test_environment_status_rejects_when_app_env_empty(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "")
    _seed(client, device_id="dev-system", permission="システム管理者")

    response = client.get("/api/system/environment/status", headers={"X-Device-Id": "dev-system"})
    assert response.status_code == 403


def test_environment_status_rejects_when_app_env_unknown(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "dev")
    _seed(client, device_id="dev-system", permission="システム管理者")

    response = client.get("/api/system/environment/status", headers={"X-Device-Id": "dev-system"})
    assert response.status_code == 403


def test_environment_status_accepts_app_env_with_spaces(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", " test ")
    _seed(client, device_id="dev-system", permission="システム管理者")
    headers = {"X-Device-Id": "dev-system"}

    response = client.get("/api/system/environment/status", headers=headers)
    assert response.status_code == 200
    assert response.json().get("app_env") == "test"

    # test env is allowed, but the executor must still be configured explicitly.
    assert _promote(client, headers).status_code == 503


def test_promote_and_sync_fail_without_executor_and_record_history(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.delenv("PRODUCTION_OPERATION_EXECUTOR", raising=False)
    _seed(client, device_id="dev-system", permission="システム管理者")
    headers = {"X-Device-Id": "dev-system"}

    promote = _promote(client, headers)
    assert promote.status_code == 503

    release_history = client.get("/api/system/release/history", headers=headers)
    assert release_history.status_code == 200
    release_items = release_history.json().get("items") or []
    assert release_items
    assert release_items[0].get("execution_status") == "not_configured"
    assert release_items[0].get("failure_reason")
    assert release_items[0].get("target_git_sha") == "abc123def456"

    sync = _sync(client, headers)
    assert sync.status_code == 503

    sync_history = client.get("/api/system/sync/history", headers=headers)
    assert sync_history.status_code == 200
    sync_items = sync_history.json().get("items") or []
    assert sync_items
    assert sync_items[0].get("execution_status") == "not_configured"


def test_promote_and_sync_do_not_queue_without_github_dispatch_config(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("PRODUCTION_OPERATION_EXECUTOR", "github-actions")
    _seed(client, device_id="dev-system", permission="システム管理者")
    headers = {"X-Device-Id": "dev-system"}

    promote = _promote(client, headers, "sha-executor-only")
    sync = _sync(client, headers, "sha-executor-only")
    assert promote.status_code == 503
    assert sync.status_code == 503

    release_items = client.get("/api/system/release/history", headers=headers).json().get(
        "items"
    ) or []
    sync_items = client.get("/api/system/sync/history", headers=headers).json().get("items") or []
    assert release_items[0].get("execution_status") == "dispatch_failed"
    assert sync_items[0].get("execution_status") == "not_configured"


def test_promote_queues_github_actions_dispatch(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("PRODUCTION_OPERATION_EXECUTOR", "github-actions")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setenv("GITHUB_ACTIONS_TOKEN", "token-for-test")
    monkeypatch.setenv("PROMOTE_PRODUCTION_WORKFLOW", "promote-production.yml")
    monkeypatch.setenv("PROMOTE_PRODUCTION_REF", "main")
    _seed(client, device_id="dev-system", permission="システム管理者")
    headers = {"X-Device-Id": "dev-system"}

    from src.backend.services import production_ops_service as service

    dispatched: dict[str, str] = {}

    def fake_dispatch(*, git_sha: str, image_digest: str) -> str:
        dispatched["git_sha"] = git_sha
        dispatched["image_digest"] = image_digest
        return "promote-production.yml"

    monkeypatch.setattr(service, "_dispatch_github_workflow", fake_dispatch)
    response = _promote(client, headers, "queued-sha", "sha256:queued")

    assert response.status_code == 200
    payload = response.json()
    assert payload.get("accepted") is True
    assert payload.get("execution_status") == "queued"
    assert dispatched == {"git_sha": "queued-sha", "image_digest": "sha256:queued"}


def test_promote_rejects_empty_image_digest(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    _seed(client, device_id="dev-system", permission="システム管理者")
    headers = {"X-Device-Id": "dev-system"}

    response = _promote(client, headers, "sha-without-digest", "")

    assert response.status_code == 503


def test_history_persists_after_service_reload(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("IMAGE_DIGEST", "sha256:persisted")
    _seed(client, device_id="dev-system", permission="システム管理者")
    headers = {"X-Device-Id": "dev-system"}
    assert _promote(client, headers, "persist-release-sha").status_code == 503
    assert _sync(client, headers, "persist-sync-sha").status_code == 503

    from src.backend.services import production_ops_service as service

    reloaded = reload(service)
    release = reloaded.list_release_history()
    sync = reloaded.list_sync_history()
    assert any(
        item.get("target_git_sha") == "persist-release-sha" for item in release.get("items") or []
    )
    assert any(item.get("target_git_sha") == "persist-sync-sha" for item in sync.get("items") or [])


def test_sync_exclusion_contains_operation_history_collection(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    _seed(client, device_id="dev-system", permission="システム管理者")

    response = client.get("/api/system/environment/status", headers={"X-Device-Id": "dev-system"})
    assert response.status_code == 200
    status = response.json()
    excluded = status.get("sync_rules", {}).get("db_sync_excluded") or []
    assert "production_operation_histories" in excluded


def test_operation_history_collection_is_not_exposed_via_extra_api(client):
    response = client.get("/api/extra/production_operation_histories")
    assert response.status_code == 404
