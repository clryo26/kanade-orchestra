from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path


def _load_module():
    path = Path("scripts/check_workflow_static.py")
    spec = importlib.util.spec_from_file_location("check_workflow_static_for_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _copy_fixture(tmp_path):
    workflow_dir = tmp_path / "workflows"
    workflow_dir.mkdir()
    for name in ("deploy-test.yml", "promote-production.yml", "sync-prod-to-test.yml"):
        shutil.copyfile(Path(".github/workflows") / name, workflow_dir / name)
    verify_script = tmp_path / "verify_prod_test_db_connections.py"
    shutil.copyfile(Path("scripts/verify_prod_test_db_connections.py"), verify_script)
    backup_script = tmp_path / "backup_test_environment_pre_sync.py"
    shutil.copyfile(Path("scripts/backup_test_environment_pre_sync.py"), backup_script)
    return workflow_dir, verify_script


def _replace(path, old, new=""):
    content = path.read_text(encoding="utf-8")
    assert old in content
    path.write_text(content.replace(old, new), encoding="utf-8")


def test_valid_workflow_group_passes(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)

    assert module.run_checks(workflow_dir, verify_script) == []


def test_missing_stage_3_2_required_token_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(workflow_dir / "sync-prod-to-test.yml", "DB_CONNECT_TIMEOUT", "DB_TIMEOUT")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("required token missing: DB_CONNECT_TIMEOUT" in error for error in errors)


def test_missing_cloud_sql_proxy_description_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(workflow_dir / "sync-prod-to-test.yml", "cloud-sql-proxy", "sql-auth-helper")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("cloud-sql-proxy" in error for error in errors)


def test_missing_secret_access_description_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "gcloud secrets versions access",
        "gcloud secrets versions describe",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("gcloud secrets versions access" in error for error in errors)


def test_missing_template_guard_or_exit_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    guard_exit = "          exit 1\n"
    before, separator, after = content.rpartition(guard_exit)
    assert separator
    sync_path.write_text(before + after, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("exit 1 is missing" in error for error in errors)


def test_direct_secret_expression_echo_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    content += '\n          echo "${{ secrets.PROD_DB_USER }}"\n'
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("echoing secret expression is forbidden" in error for error in errors)


def test_direct_database_password_echo_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    content += '\n          echo "${DB_PASSWORD}"\n'
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("echoing secret expression is forbidden" in error for error in errors)


def test_missing_read_only_option_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(verify_script, "default_transaction_read_only=on", "application_name=check")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("read-only connection option is missing" in error for error in errors)


def test_write_sql_keyword_in_verification_script_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    content = verify_script.read_text(encoding="utf-8")
    verify_script.write_text(content + '\nWRITE_EXAMPLE = "DELETE FROM members"\n', encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("write SQL keyword is forbidden: DELETE" in error for error in errors)


def test_psql_write_command_in_workflow_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    content += '\n          psql -c "DELETE FROM members"\n'
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("DB/GCS write or sync command is forbidden" in error for error in errors)


def test_missing_backup_invocation_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "          python scripts/backup_test_environment_pre_sync.py --execute\n",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("backup script must be invoked exactly once" in error for error in errors)


def test_duplicate_backup_invocation_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    content += "\n          python scripts/backup_test_environment_pre_sync.py --execute\n"
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("backup script must be invoked exactly once" in error for error in errors)


def test_alternate_spelling_duplicate_backup_invocation_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    content += "\n          python ./scripts/backup_test_environment_pre_sync.py --execute\n"
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("backup script must be invoked exactly once" in error for error in errors)


def test_backup_invocation_without_execute_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "python scripts/backup_test_environment_pre_sync.py --execute",
        "python scripts/backup_test_environment_pre_sync.py",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("backup script must be invoked exactly once with --execute" in error for error in errors)


def test_backup_step_without_dry_run_false_condition_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "      - name: Run test pre-sync backup\n        if: ${{ inputs.dry_run == 'false' }}",
        "      - name: Run test pre-sync backup\n        if: ${{ inputs.dry_run == 'true' }}",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("backup step must require dry_run == 'false'" in error for error in errors)


def test_missing_read_only_verification_step_marker_fails_backup_order(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "- name: Verify prod and test database read-only connections",
        "- name: Renamed connection step",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("backup must run after read-only DB verification" in error for error in errors)


def test_missing_template_guard_marker_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "- name: Template guard",
        "- name: Disabled final step",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("template guard step is missing" in error for error in errors)


def test_direct_gcs_copy_command_in_workflow_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    content += "\n          gcloud storage cp source destination\n"
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("DB/GCS write or sync command is forbidden" in error for error in errors)


def test_backup_script_safety_token_missing_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    backup_script = tmp_path / "backup_test_environment_pre_sync.py"
    _replace(backup_script, "if_source_generation_match=source_generation", "")

    errors = module.run_checks(workflow_dir, verify_script, backup_script)

    assert any("required safety token missing" in error for error in errors)


def test_direct_workflow_input_echo_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    content += '\n          echo "${{ inputs.operation_id }}"\n'
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("workflow input must be passed through env" in error for error in errors)


def test_checkout_from_target_git_sha_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "ref: ${{ github.workflow_sha }}",
        "ref: ${{ inputs.target_git_sha }}",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("must not be checked out from target_git_sha" in error for error in errors)
