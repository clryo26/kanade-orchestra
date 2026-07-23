from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

import pytest


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
    for name in ("deploy-test.yml", "promote-production.yml", "sync-prod-to-test.yml", "test-maintenance.yml"):
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


def test_maintenance_workflow_cannot_be_automatic(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    path = workflow_dir / "test-maintenance.yml"
    path.write_text(path.read_text(encoding="utf-8") + "\n  schedule:\n", encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("must remain manual" in error for error in errors)


def test_maintenance_workflow_cannot_use_always(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    path = workflow_dir / "test-maintenance.yml"
    path.write_text(path.read_text(encoding="utf-8") + "\n        if: ${{ always() }}\n", encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("must not use always" in error for error in errors)


@pytest.mark.parametrize(
    ("file_name", "guard"),
    [
        ("deploy-test.yml", 'if [ "${GCP_PROJECT_ID}" != "kanade-orchestra" ]; then'),
        ("deploy-test.yml", 'if [ "${GCP_REGION}" != "asia-northeast2" ]; then'),
        (
            "deploy-test.yml",
            'if [ "${TEST_CLOUD_RUN_SERVICE}" != "kanade-orchestra-test" ]; then',
        ),
        ("sync-prod-to-test.yml", 'if [ "${GCP_PROJECT_ID}" != "kanade-orchestra" ]; then'),
        ("sync-prod-to-test.yml", 'if [ "${GCP_REGION}" != "asia-northeast2" ]; then'),
        (
            "sync-prod-to-test.yml",
            'if [ "${TEST_CLOUD_RUN_SERVICE}" != "kanade-orchestra-test" ]; then',
        ),
    ],
)
def test_missing_exact_test_target_guard_fails(tmp_path, file_name, guard):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(workflow_dir / file_name, guard, "removed-target-guard")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("exact test target guard missing" in error for error in errors)


def test_deploy_maintenance_guard_after_deployment_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    deploy_path = workflow_dir / "deploy-test.yml"
    content = deploy_path.read_text(encoding="utf-8")
    guard = "- name: Block deploy while test maintenance is enabled"
    content = content.replace(guard, "- name: Temporary guard marker", 1)
    content += f"\n      {guard}\n"
    deploy_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("maintenance guard must run before deployment" in error for error in errors)


def test_normal_deploy_without_explicit_maintenance_false_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "deploy-test.yml",
        'ENV_VARS="APP_ENV=test,MAINTENANCE_MODE=false,',
        'ENV_VARS="APP_ENV=test,',
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("normal deployment must explicitly disable maintenance" in error for error in errors)


def test_deploy_maintenance_safety_with_always_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    deploy_path = workflow_dir / "deploy-test.yml"
    content = deploy_path.read_text(encoding="utf-8")
    content += "\n        if: ${{ always() }}\n"
    deploy_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("maintenance safety must not use always()" in error for error in errors)


def test_missing_maintenance_deploy_guard_invocation_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "deploy-test.yml",
        "python scripts/check_test_maintenance_deploy.py",
        "python scripts/unapproved_guard.py",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("required token missing: check_test_maintenance_deploy.py" in error for error in errors)


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


def test_missing_integrated_completion_marker_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "- name: Integrated synchronization completed",
        "- name: Disabled final step",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("integrated completion step is missing" in error for error in errors)


def test_template_guard_remaining_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    content += "\n      - name: Template guard\n        run: exit 1\n"
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("template guard must be removed" in error for error in errors)


def test_maintenance_disable_with_always_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "if: ${{ inputs.dry_run == 'false' && success() }}",
        "if: ${{ always() }}",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("maintenance must remain enabled after synchronization failure" in error for error in errors)


def test_maintenance_disable_without_enabled_revision_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "ENABLED_MAINTENANCE_REVISION: ${{ steps.enable_maintenance.outputs.revision }}",
        "ENABLED_MAINTENANCE_REVISION: unsafe-current-revision",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("maintenance disable safety token missing" in error for error in errors)


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


@pytest.mark.parametrize(
    "token",
    [
        'if [ ! -x "/usr/lib/postgresql/18/bin/pg_dump" ]; then',
        'restore_version="$(/usr/lib/postgresql/18/bin/pg_restore --version)"',
        '"pg_dump (PostgreSQL) 18"|"pg_dump (PostgreSQL) 18."*',
        'export PATH="/usr/lib/postgresql/18/bin:${PATH}"',
        'resolved_pg_dump="$(command -v pg_dump)"',
        'if [ "${resolved_pg_restore}" != "/usr/lib/postgresql/18/bin/pg_restore" ]; then',
    ],
)
def test_missing_postgresql_18_path_safety_token_fails(tmp_path, token):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(workflow_dir / "sync-prod-to-test.yml", token, "removed-pg18-safety-token")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("PostgreSQL 18 PATH safety token missing" in error for error in errors)


def test_postgresql_18_path_setup_after_backup_invocation_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    path_line = '          export PATH="/usr/lib/postgresql/18/bin:${PATH}"\n'
    assert path_line in content
    content = content.replace(path_line, "", 1)
    invocation = "          python scripts/backup_test_environment_pre_sync.py --execute\n"
    assert invocation in content
    content = content.replace(invocation, invocation + path_line, 1)
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("PATH resolution must precede" in error for error in errors)


def test_unapproved_direct_pg_dump_command_still_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    content += "\n          /usr/lib/postgresql/18/bin/pg_dump --file unsafe.dump\n"
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("DB/GCS write or sync command is forbidden" in error for error in errors)


def test_sync_restore_gates_are_accepted_in_safe_order(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)

    errors = module.run_checks(workflow_dir, verify_script)

    assert errors == []


def test_db_sync_invocation_missing_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "python scripts/sync_prod_to_test_db.py",
        "python scripts/disabled_db_sync.py",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("DB sync script must be invoked exactly once" in error for error in errors)


def test_db_sync_without_false_condition_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    marker = (
        "      - name: Synchronize approved production database tables to test\n"
        "        if: ${{ inputs.dry_run == 'false' }}"
    )
    _replace(sync_path, marker, marker.replace("false", "true"))

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("DB sync step safety token missing" in error for error in errors)


def test_db_sync_before_drain_verification_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    drain = "- name: Verify test database connections are drained"
    db_sync = "- name: Synchronize approved production database tables to test"
    content = content.replace(drain, "- name: TEMP drain step")
    content = content.replace(db_sync, drain)
    content = content.replace("- name: TEMP drain step", db_sync)
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("order is invalid" in error for error in errors)


def test_gcs_sync_invocation_missing_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "python -m scripts.sync_prod_to_test_gcs --execute",
        "python -m scripts.disabled_gcs_sync --execute",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("GCS sync script must be invoked exactly once" in error for error in errors)


def test_gcs_sync_direct_script_invocation_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "python -m scripts.sync_prod_to_test_gcs --execute",
        "python scripts/sync_prod_to_test_gcs.py --execute",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any(
        "GCS sync script must be invoked exactly once as a module with --execute" in error
        for error in errors
    )


def test_gcs_sync_without_execute_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(
        workflow_dir / "sync-prod-to-test.yml",
        "python -m scripts.sync_prod_to_test_gcs --execute",
        "python -m scripts.sync_prod_to_test_gcs",
    )

    errors = module.run_checks(workflow_dir, verify_script)

    assert any(
        "GCS sync script must be invoked exactly once as a module with --execute" in error
        for error in errors
    )


def test_gcs_sync_without_false_condition_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    marker = (
        "      - name: Synchronize approved production GCS objects to test\n"
        "        if: ${{ inputs.dry_run == 'false' }}"
    )
    _replace(sync_path, marker, marker.replace("false", "true"))

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("GCS sync step safety token missing" in error for error in errors)


def test_gcs_sync_before_db_sync_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    db_sync = "- name: Synchronize approved production database tables to test"
    gcs_sync = "- name: Synchronize approved production GCS objects to test"
    content = content.replace(db_sync, "- name: TEMP DB sync step")
    content = content.replace(gcs_sync, db_sync)
    content = content.replace("- name: TEMP DB sync step", gcs_sync)
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any(
        "GCS sync must run after DB sync" in error or "order is invalid" in error
        for error in errors
    )


def test_sync_restore_gate_order_change_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    manifest = "- name: Validate test pre-sync backup manifest"
    maintenance = "- name: Enable test maintenance and drain requests"
    content = content.replace(manifest, "- name: TEMP restore gate")
    content = content.replace(maintenance, manifest)
    content = content.replace("- name: TEMP restore gate", maintenance)
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("order is invalid" in error for error in errors)


def test_sync_restore_gate_without_false_condition_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    marker = "      - name: Validate test pre-sync backup manifest\n        if: ${{ inputs.dry_run == 'false' }}"
    assert marker in content
    content = content.replace(
        marker,
        "      - name: Validate test pre-sync backup manifest\n        if: ${{ inputs.dry_run == 'true' }}",
        1,
    )
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("restore gate must require dry_run == 'false'" in error for error in errors)


def test_sync_restore_gate_duplicate_invocation_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    invocation = "          python scripts/check_backup_manifest.py\n"
    assert invocation in content
    content = content.replace(invocation, invocation * 2, 1)
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("required gate must be invoked exactly once" in error for error in errors)


@pytest.mark.parametrize(
    ("old", "new"),
    [
        (
            'echo "::error::PostgreSQL 18 dump executable is unavailable"\n            exit 1',
            'echo "::error::PostgreSQL 18 dump executable is unavailable"\n            exit 0',
        ),
        (
            'echo "::error::Dump executable did not resolve to the PostgreSQL 18 client"\n'
            "            exit 1",
            'echo "::error::Dump executable did not resolve to the PostgreSQL 18 client"\n'
            "            exit 0",
        ),
        (
            '*) echo "::error::PostgreSQL restore client major version is not 18"; exit 1 ;;',
            '*) echo "::error::PostgreSQL restore client major version is not 18"; exit 0 ;;',
        ),
    ],
)
def test_postgresql_18_mismatch_branch_must_fail_closed(tmp_path, old, new):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    _replace(workflow_dir / "sync-prod-to-test.yml", old, new)

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("must fail closed" in error for error in errors)


def test_postgresql_18_absolute_version_check_before_install_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    version_line = '          dump_version="$(/usr/lib/postgresql/18/bin/pg_dump --version)"\n'
    install_line = "          sudo apt-get install --yes postgresql-client-18\n"
    assert version_line in content and install_line in content
    content = content.replace(version_line, "", 1)
    content = content.replace(install_line, version_line + install_line, 1)
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("absolute-path validation must follow installation" in error for error in errors)


def test_postgresql_18_path_check_after_secret_access_fails(tmp_path):
    module = _load_module()
    workflow_dir, verify_script = _copy_fixture(tmp_path)
    sync_path = workflow_dir / "sync-prod-to-test.yml"
    content = sync_path.read_text(encoding="utf-8")
    export_line = '          export PATH="/usr/lib/postgresql/18/bin:${PATH}"\n'
    assert export_line in content
    content = content.replace(export_line, "", 1)
    secret_index = content.rfind('          DB_PASSWORD="$(gcloud secrets versions access latest')
    assert secret_index >= 0
    secret_line_end = content.find("\n", secret_index) + 1
    content = content[:secret_line_end] + export_line + content[secret_line_end:]
    sync_path.write_text(content, encoding="utf-8")

    errors = module.run_checks(workflow_dir, verify_script)

    assert any("PATH resolution must precede secret access" in error for error in errors)
