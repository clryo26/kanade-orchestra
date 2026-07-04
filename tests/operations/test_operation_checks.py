from __future__ import annotations

from pathlib import Path


def _seed_member(
    backend_env,
    *,
    member_id: int,
    name: str,
    part: str,
    permission: str,
    password: str,
):
    members = backend_env.load_json_data("members")
    members.append(
        {
            "id": member_id,
            "name": name,
            "part": part,
            "permission": permission,
            "password": password,
        }
    )
    backend_env.save_json_data("members", members)


def _portal_login(client, *, name: str, part: str, password: str, device_id: str):
    return client.post(
        "/api/auth/portal-login",
        json={
            "name": name,
            "part": part,
            "password": password,
            "device_id": device_id,
            "device_name": "operation-test-device",
            "user_agent": "pytest-operation",
        },
    )


def _performance_payload(title: str):
    return {
        "title": title,
        "date": "2026-06-18",
        "open_time": "17:00",
        "start_time": "18:00",
        "venue": "v",
        "conductor": "c",
        "pieces": [],
    }


def test_op_api_001_bootstrap_lite_smoke(client):
    response = client.get("/api/bootstrap-lite")
    assert response.status_code == 200
    assert response.headers.get("etag") or response.headers.get("ETag")


def test_op_api_002_mutation_requires_device_header(client):
    response = client.post("/api/performances", json=_performance_payload("op-no-header"))
    assert response.status_code == 401


def test_op_api_003_admin_login_to_crud_smoke(client, backend_env):
    _seed_member(
        backend_env,
        member_id=1,
        name="op-admin",
        part="Vn",
        permission="管理者",
        password="op-admin-pass",
    )
    login = _portal_login(
        client,
        name="op-admin",
        part="Vn",
        password="op-admin-pass",
        device_id="op-dev-admin",
    )
    assert login.status_code == 200
    assert login.json().get("authenticated") is True

    created = client.post(
        "/api/performances",
        headers={"X-Device-Id": "op-dev-admin"},
        json=_performance_payload("op-admin-created"),
    )
    assert created.status_code == 200


def test_op_api_004_etag_reuse_returns_304(client):
    first = client.get("/api/bootstrap-lite")
    etag = first.headers.get("etag") or first.headers.get("ETag")
    assert etag

    second = client.get("/api/bootstrap-lite", headers={"If-None-Match": etag})
    assert second.status_code == 304


def test_op_api_005_orphan_integrity_gate(client, backend_env):
    _seed_member(
        backend_env,
        member_id=1,
        name="op-admin",
        part="Vn",
        permission="管理者",
        password="op-admin-pass",
    )
    login = _portal_login(
        client,
        name="op-admin",
        part="Vn",
        password="op-admin-pass",
        device_id="op-dev-admin",
    )
    assert login.status_code == 200

    response = client.get("/api/maintenance/orphans", headers={"X-Device-Id": "op-dev-admin"})
    assert response.status_code == 200

    payload = response.json()
    assert payload.get("total") == 0


def test_op_ci_001_required_jobs_exist_in_ci_yaml():
    ci_path = Path(".github/workflows/ci.yml")
    text = ci_path.read_text(encoding="utf-8")
    assert "backend-tests:" in text
    assert "frontend-tests:" in text
    assert "coverage-summary:" in text


def test_op_ci_002_sticky_comment_action_exists():
    ci_path = Path(".github/workflows/ci.yml")
    text = ci_path.read_text(encoding="utf-8")
    assert "marocchino/sticky-pull-request-comment@v2" in text


def test_op_ci_003_frontend_syntax_gate_exists():
    ci_path = Path(".github/workflows/ci.yml")
    text = ci_path.read_text(encoding="utf-8")
    assert "Run frontend syntax check" in text
    assert "npm run check:frontend:syntax" in text


def test_op_doc_001_required_specs_exist():
    required = [
        Path("UNIT_TEST_SPEC.md"),
        Path("INTEGRATION_TEST_SPEC.md"),
        Path("INTEGRATION_TEST_SPEC_BACKEND.md"),
        Path("INTEGRATION_TEST_SPEC_FRONTEND.md"),
        Path("INTEGRATION_TEST_SPEC_CI.md"),
        Path("OPERATION_TEST_SPEC.md"),
    ]
    missing = [str(path) for path in required if not path.exists()]
    assert not missing, f"Missing spec files: {missing}"


def test_op_doc_002_navigation_has_operation_spec_reference():
    nav_path = Path("DESIGN_DOCS_NAVIGATION.md")
    text = nav_path.read_text(encoding="utf-8")
    assert "OPERATION_TEST_SPEC.md" in text


def test_op_release_001_incomplete_flyer_distribution_residue_is_rejected(monkeypatch):
    import importlib.util
    import sys

    script_path = Path("scripts/check_release_safety.py")
    spec = importlib.util.spec_from_file_location("release_safety_for_test", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    # The released source must have no remnants of the removed feature.
    assert module._check_no_incomplete_flyer_feature_residue() is True
    state_text = Path("src/static/js/store/app_state.js").read_text(encoding="utf-8")
    assert "flyerDistributionSelectedPerformanceId" not in state_text

    # Also prove that the guard fails when a prohibited runtime marker is present.
    monkeypatch.setattr(module, "INCOMPLETE_FLYER_FEATURE_MARKERS", ("Deprecated compatibility entrypoint.",))
    assert module._check_no_incomplete_flyer_feature_residue() is False
