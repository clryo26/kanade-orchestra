"""Legacy reference migration (spec R06/C03; T11/T15/T23): evidence-based, never by candidate count."""
from __future__ import annotations

import pytest

from scripts import migrate_reference_assets as module
from src.backend.services import portal_file_asset_service as files


def _seed(backend_env):
    legacy_pdf = backend_env.UPLOAD_DIR / "desired_piece_reference_scores" / "1" / "20260101000000000000_score.pdf"
    legacy_pdf.parent.mkdir(parents=True, exist_ok=True)
    legacy_pdf.write_bytes(b"%PDF-1.4 legacy")
    icon = backend_env.UPLOAD_DIR / "org-settings" / "1" / "icon.png"
    icon.parent.mkdir(parents=True, exist_ok=True)
    icon.write_bytes(b"\x89PNG legacy")
    backend_env.save_json_data("desired_pieces", [{"id": 1, "title": "W", "reference_score_url": "/api/extra/desired_pieces/1/reference_score", "votes": []}])
    backend_env.save_json_data("org_settings", [{"id": 1, "organization_name": "O", "icon_url": "/api/extra/org_settings/1/icon?ext=png"}])


def test_plan_lists_candidates_unconfirmed(backend_env, monkeypatch):
    monkeypatch.setattr("src.backend.services.desired_piece_asset_service.UPLOAD_DIR", backend_env.UPLOAD_DIR)
    _seed(backend_env)
    manifest = module.plan("default")
    kinds = {entry["kind"]: entry for entry in manifest["entries"]}
    assert set(kinds) == {"desired_piece_reference_score", "org_icon"}
    assert all(entry["confirmed"] is False for entry in manifest["entries"])
    assert len(kinds["desired_piece_reference_score"]["candidates"]) == 1  # one candidate, still unconfirmed


def test_single_candidate_is_not_applied_without_confirmation(backend_env, monkeypatch):
    monkeypatch.setattr("src.backend.services.desired_piece_asset_service.UPLOAD_DIR", backend_env.UPLOAD_DIR)
    _seed(backend_env)
    report = module.apply("default", module.plan("default"), "run-1", execute=True)
    assert report["state"] == "incomplete" and report["unresolved"] == 2 and report["applied"] == []
    assert not files.has_active_asset("desired_piece_reference_score", 1)


def test_confirmed_entries_are_applied_once_and_served(backend_env, monkeypatch):
    monkeypatch.setattr("src.backend.services.desired_piece_asset_service.UPLOAD_DIR", backend_env.UPLOAD_DIR)
    _seed(backend_env)
    manifest = module.plan("default")
    for entry in manifest["entries"]:
        entry.update(confirmed=True, chosen_object=entry["candidates"][0]["object_name"], chosen_generation=None, evidence="ticket #1 upload log")
    report = module.apply("default", manifest, "run-1", execute=True)
    assert report["state"] == "completed" and len(report["applied"]) == 2
    assert files.deliver("desired_piece_reference_score", 1, None).body == b"%PDF-1.4 legacy"
    assert files.deliver("org_icon", 1, None).body == b"\x89PNG legacy"
    again = module.apply("default", manifest, "run-1", execute=True)
    assert again["state"] == "incomplete" and all(error["status"] == 409 for error in again["errors"])


def test_apply_stops_when_the_row_changed_after_planning(backend_env, monkeypatch):
    monkeypatch.setattr("src.backend.services.desired_piece_asset_service.UPLOAD_DIR", backend_env.UPLOAD_DIR)
    _seed(backend_env)
    manifest = module.plan("default")
    for entry in manifest["entries"]:
        entry.update(confirmed=True, chosen_object=entry["candidates"][0]["object_name"], evidence="e")
    backend_env.save_json_data("org_settings", [{"id": 1, "organization_name": "O", "icon_url": ""}])
    report = module.apply("default", manifest, "run-1", execute=True)
    assert any(error["kind"] == "org_icon" and error["status"] == 409 for error in report["errors"])
    assert report["state"] == "incomplete"


def test_chosen_object_must_be_a_listed_candidate(backend_env, monkeypatch):
    monkeypatch.setattr("src.backend.services.desired_piece_asset_service.UPLOAD_DIR", backend_env.UPLOAD_DIR)
    _seed(backend_env)
    manifest = module.plan("default")
    manifest["entries"][0].update(confirmed=True, chosen_object="other/tenant/file.pdf", evidence="e")
    report = module.apply("default", manifest, "run-1", execute=False)
    assert report["errors"][0]["detail"] == "chosen object is not a listed candidate"


def _missing_manifest(backend_env, monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("CLOUD_RUN_SERVICE", "kanade-orchestra-test")
    backend_env.save_json_data("members", [
        {"id": i, "name": "member", "photo_url": f"/api/members/{i}/photo?ext=png"} for i in (1, 2, 3)
    ])
    manifest = module.plan("default")
    manifest["test_missing_reference_acceptance"] = {
        "scope": module.TEST_MISSING_SCOPE, "approved": True, "approval_reference": "user-approval-test"
    }
    for entry in manifest["entries"]:
        entry.update(accepted_missing=True, object_name=f"member-images/{entry['owner_id']}/photo.png",
                     preexisting_http_status=404, noncurrent_versions=0, soft_deleted_versions=0)
    return manifest


def test_approved_test_missing_photos_preserve_rows_and_create_no_assets(backend_env, monkeypatch):
    manifest = _missing_manifest(backend_env, monkeypatch)
    before = backend_env.load_json_data("members")
    report = module.apply("default", manifest, "missing-test", True, accept_test_missing_photos=True)
    assert report["state"] == "completed" and len(report["accepted_missing"]) == 3
    assert report["applied"] == [] and report["unresolved"] == 0
    assert backend_env.load_json_data("members") == before
    assert not any(files.has_active_asset("member_photo", i) for i in (1, 2, 3))


@pytest.mark.parametrize("changed", ["production", "no_flag", "changed_row", "object_restored", "extra_reference"])
def test_test_missing_exception_stops_on_scope_or_evidence_changes(backend_env, monkeypatch, changed):
    manifest = _missing_manifest(backend_env, monkeypatch)
    if changed == "production":
        monkeypatch.setenv("APP_ENV", "production")
    elif changed == "changed_row":
        members = backend_env.load_json_data("members")
        members[0]["photo_url"] = ""
        backend_env.save_json_data("members", members)
    elif changed == "object_restored":
        path = backend_env.UPLOAD_DIR / "member-images/1/photo.png"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"restored")
    elif changed == "extra_reference":
        backend_env.save_json_data("org_settings", [{"id": 1, "icon_url": "/api/extra/org_settings/1/icon?ext=png"}])
    with pytest.raises(SystemExit):
        module.apply("default", manifest, "missing-test", True, accept_test_missing_photos=changed != "no_flag")
