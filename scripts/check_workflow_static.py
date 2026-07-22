#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_DIR = ROOT / ".github" / "workflows"
VERIFY_DB_SCRIPT = ROOT / "scripts" / "verify_prod_test_db_connections.py"
BACKUP_SCRIPT = ROOT / "scripts" / "backup_test_environment_pre_sync.py"
MAINTENANCE_DEPLOY_GUARD_SCRIPT = ROOT / "scripts" / "check_test_maintenance_deploy.py"
MAINTENANCE_OPERATION_SCRIPT = ROOT / "scripts" / "manage_test_maintenance.py"
DB_DRAIN_CHECK_SCRIPT = ROOT / "scripts" / "check_test_db_connections_drained.py"
BACKUP_MANIFEST_CHECK_SCRIPT = ROOT / "scripts" / "check_backup_manifest.py"

TARGET_WORKFLOWS = {
    "test-maintenance.yml": {
        "required_tokens": [
            "workflow_dispatch",
            "github.workflow_sha",
            "cancel-in-progress: false",
            "manage_test_maintenance.py",
            'ACTION: ${{ inputs.action }}',
            'EXPECTED_REVISION: ${{ inputs.expected_revision }}',
            'CONFIRMATION: ${{ inputs.confirmation }}',
            '--project "kanade-orchestra"',
            '--region "asia-northeast2"',
            '--service "kanade-orchestra-test"',
            "--execute",
        ],
        "required_phrases": [
            "Exact current ready test revision",
            "Apply test maintenance transition",
        ],
    },
    "deploy-test.yml": {
        "required_tokens": [
            "TEST_CLOUD_RUN_SERVICE",
            "ARTIFACT_REGISTRY_REPOSITORY",
            "ARTIFACT_REGISTRY_IMAGE",
            "TEST_GCS_BUCKET",
            "DEPLOY_SERVICE_ACCOUNT",
            "WIF_PROVIDER",
            "PRODUCTION_OPERATION_EXECUTOR",
            "GITHUB_REPOSITORY",
            "MAINTENANCE_MODE=false",
            "check_test_maintenance_deploy.py",
        ],
        "required_phrases": [
            "docker build",
            "docker push",
            "gcloud run deploy",
            "IMAGE_DIGEST",
            "Block deploy while test maintenance is enabled",
        ],
    },
    "promote-production.yml": {
        "required_tokens": [
            "PROD_CLOUD_RUN_SERVICE",
            "TEST_CLOUD_RUN_SERVICE",
            "ARTIFACT_REGISTRY_REPOSITORY",
            "ARTIFACT_REGISTRY_IMAGE",
            "PROD_GCS_BUCKET",
            "DEPLOY_SERVICE_ACCOUNT",
            "WIF_PROVIDER",
        ],
        "required_phrases": [
            "tested_image_digest",
            "does not match current test Cloud Run image digest",
            "gcloud run deploy",
        ],
    },
    "sync-prod-to-test.yml": {
        "required_tokens": [
            "CLOUD_SQL_INSTANCE",
            "DB_NAME_PROD",
            "DB_NAME_TEST",
            "GCS_BUCKET_PROD",
            "GCS_BUCKET_TEST",
            "DEPLOY_SERVICE_ACCOUNT",
            "WIF_PROVIDER",
            "expected_test_revision",
            "maintenance_confirmation",
            "group: kanade-orchestra-test-maintenance",
            "cancel-in-progress: false",
            "check_backup_manifest.py",
            "manage_test_maintenance.py enable",
            "check_test_db_connections_drained.py",
            "sync_prod_to_test_preflight.py",
            "verify_prod_test_db_connections.py",
            "PROD_DB_USER",
            "TEST_DB_USER",
            "kanade-portal-db-password",
            "DB_CONNECT_TIMEOUT",
            "setup-python",
            "backup_test_environment_pre_sync.py",
            "google-cloud-storage==2.14.0",
            "postgresql-client-18",
            "TARGET_GIT_SHA",
            "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8",
            "github.workflow_sha",
            "TEST_CLOUD_RUN_SERVICE",
        ],
        "required_phrases": [
            "Allowed direction only: production -> test",
            "Reverse sync (test -> production) must not be implemented.",
            "gcloud sql instances describe",
            "gcloud storage buckets describe",
            "cloud-sql-proxy",
            "gcloud secrets versions access",
            "Template guard",
        ],
    },
}

EXPECTED_TEST_TARGETS = {
    "GCP_PROJECT_ID": "kanade-orchestra",
    "GCP_REGION": "asia-northeast2",
    "TEST_CLOUD_RUN_SERVICE": "kanade-orchestra-test",
}

FORBIDDEN_TOKENS = [
    "GAR_REPOSITORY",
    "WIF_SERVICE_ACCOUNT",
    "CLOUD_RUN_SERVICE_PROD",
]

# Secret names are allowed in env mapping (e.g. `${{ secrets.X }}`) but must not be echoed.
SECRET_ECHO_PATTERN = re.compile(r"^\s*echo\b.*secrets\.", re.IGNORECASE)
SENSITIVE_VALUE_ECHO_PATTERN = re.compile(
    r"^\s*echo\b.*\$\{(?:DB_PASSWORD|PROD_DB_USER|TEST_DB_USER)\}", re.IGNORECASE
)
WRITE_SQL_PATTERN = re.compile(
    r"\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b", re.IGNORECASE
)
SYNC_WRITE_PATTERN = re.compile(
    r"\b(?:psql|pg_dump|pg_restore|migrate_db\.py|backup_db\.py|restore_db\.py)\b"
    r"|\bgcloud\s+(?:sql\s+(?:export|import)|storage\s+(?:cp|mv|rm|rsync))\b"
    r"|\bgsutil\s+(?:cp|mv|rm|rsync)\b",
    re.IGNORECASE,
)

PG18_VALIDATION_LINE_PATTERNS = (
    re.compile(r'^\s*if \[ ! -x "/usr/lib/postgresql/18/bin/pg_(?:dump|restore)" \]; then\s*$'),
    re.compile(
        r'^\s*(?:dump|restore)_version="\$\(/usr/lib/postgresql/18/bin/'
        r'pg_(?:dump|restore) --version\)"\s*$'
    ),
    re.compile(r'^\s*"pg_(?:dump|restore) \(PostgreSQL\) 18"\|"pg_(?:dump|restore) '),
    re.compile(
        r'^\s*resolved_pg_(?:dump|restore)="\$\(command -v pg_(?:dump|restore)\)"\s*$'
    ),
    re.compile(
        r'^\s*if \[ "\$\{resolved_pg_(?:dump|restore)\}" != '
        r'"/usr/lib/postgresql/18/bin/pg_(?:dump|restore)" \]; then\s*$'
    ),
)


def fail(message: str) -> None:
    print(f"[FAIL] {message}")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception as exc:  # pragma: no cover - defensive IO error path
        raise RuntimeError(f"cannot read {path}: {exc}") from exc


def validate_basic_yaml_shape(content: str, file_name: str, errors: list[str]) -> None:
    for token in ["name:", "on:", "jobs:"]:
        if token not in content:
            errors.append(f"{file_name}: missing top-level token '{token}'")


def validate_forbidden_tokens(content: str, file_name: str, errors: list[str]) -> None:
    for token in FORBIDDEN_TOKENS:
        if token in content:
            errors.append(f"{file_name}: forbidden token remains: {token}")


def validate_required_tokens(content: str, file_name: str, errors: list[str]) -> None:
    required = TARGET_WORKFLOWS[file_name]["required_tokens"]
    for token in required:
        if token not in content:
            errors.append(f"{file_name}: required token missing: {token}")


def validate_required_phrases(content: str, file_name: str, errors: list[str]) -> None:
    phrases = TARGET_WORKFLOWS[file_name]["required_phrases"]
    for phrase in phrases:
        if phrase not in content:
            errors.append(f"{file_name}: required policy phrase missing: {phrase}")


def validate_test_target_guards(content: str, file_name: str, errors: list[str]) -> None:
    if file_name not in {"deploy-test.yml", "sync-prod-to-test.yml"}:
        return
    for variable, expected in EXPECTED_TEST_TARGETS.items():
        guard = f'if [ "${{{variable}}}" != "{expected}" ]; then'
        if guard not in content:
            errors.append(
                f"{file_name}: exact test target guard missing: {variable}={expected}"
            )


def validate_deploy_maintenance_guard(content: str, file_name: str, errors: list[str]) -> None:
    if file_name != "deploy-test.yml":
        return
    guard_start = content.find("- name: Block deploy while test maintenance is enabled")
    deploy_start = content.find("- name: Deploy tested image to test Cloud Run")
    if guard_start < 0 or deploy_start < 0 or guard_start >= deploy_start:
        errors.append(f"{file_name}: maintenance guard must run before deployment")
    if 'ENV_VARS="APP_ENV=test,MAINTENANCE_MODE=false,' not in content:
        errors.append(f"{file_name}: normal deployment must explicitly disable maintenance")
    if "always()" in content:
        errors.append(f"{file_name}: maintenance safety must not use always()")


def validate_maintenance_operation_workflow(content: str, file_name: str, errors: list[str]) -> None:
    if file_name != "test-maintenance.yml":
        return
    if "always()" in content:
        errors.append(f"{file_name}: maintenance transition must not use always()")
    if "schedule:" in content or "workflow_run:" in content:
        errors.append(f"{file_name}: maintenance transition must remain manual")


def validate_template_guard(content: str, file_name: str, errors: list[str]) -> None:
    if file_name == "sync-prod-to-test.yml":
        guard_marker = "- name: Template guard"
        guard_start = content.find(guard_marker)
        if guard_start < 0:
            errors.append(f"{file_name}: template guard step is missing")
        else:
            guard_block = content[guard_start:]
            next_step = guard_block.find("\n      - name:", len(guard_marker))
            if next_step >= 0:
                guard_block = guard_block[:next_step]
            if not re.search(r"^\s*exit 1\s*$", guard_block, re.MULTILINE):
                errors.append(f"{file_name}: template guard exists but exit 1 is missing")
    if file_name in {"deploy-test.yml", "promote-production.yml"} and "Template guard" in content:
        errors.append(f"{file_name}: template guard must be removed for active App Release Plan A")


def validate_no_secret_echo(content: str, file_name: str, errors: list[str]) -> None:
    for line in content.splitlines():
        secret_expression_echo = SECRET_ECHO_PATTERN.search(line)
        sensitive_value_echo = SENSITIVE_VALUE_ECHO_PATTERN.search(line)
        password_mask_registration = 'echo "::add-mask::${DB_PASSWORD}"' in line
        if secret_expression_echo or (sensitive_value_echo and not password_mask_registration):
            errors.append(f"{file_name}: echoing secret expression is forbidden: {line.strip()}")


def validate_no_direct_input_echo(content: str, file_name: str, errors: list[str]) -> None:
    pattern = re.compile(r"^\s*echo\b.*\$\{\{\s*inputs\.", re.IGNORECASE)
    for line in content.splitlines():
        if pattern.search(line):
            errors.append(
                f"{file_name}: workflow input must be passed through env before shell use"
            )


def validate_sync_workflow_has_no_write_commands(
    content: str, file_name: str, errors: list[str]
) -> None:
    if file_name != "sync-prod-to-test.yml":
        return
    sql_scan_content = "\n".join(
        line
        for line in content.splitlines()
        if not re.fullmatch(r"\s*sudo apt-get update\s*", line)
    )
    sync_scan_content = "\n".join(
        "" if any(pattern.match(line) for pattern in PG18_VALIDATION_LINE_PATTERNS) else line
        for line in content.splitlines()
    )
    if SYNC_WRITE_PATTERN.search(sync_scan_content) or WRITE_SQL_PATTERN.search(sql_scan_content):
        errors.append(f"{file_name}: DB/GCS write or sync command is forbidden in this phase")


def validate_sync_pg18_client_policy(content: str, file_name: str, errors: list[str]) -> None:
    if file_name != "sync-prod-to-test.yml":
        return
    install_marker = "- name: Install PostgreSQL 18 client from official PGDG repository"
    install_start = content.find(install_marker)
    install_end = content.find("\n      - name:", install_start + len(install_marker))
    install_block = (
        content[install_start : install_end if install_end >= 0 else len(content)]
        if install_start >= 0
        else ""
    )
    install_tokens = (
        'if [ ! -x "/usr/lib/postgresql/18/bin/pg_dump" ]; then',
        'if [ ! -x "/usr/lib/postgresql/18/bin/pg_restore" ]; then',
        'dump_version="$(/usr/lib/postgresql/18/bin/pg_dump --version)"',
        'restore_version="$(/usr/lib/postgresql/18/bin/pg_restore --version)"',
        '"pg_dump (PostgreSQL) 18"|"pg_dump (PostgreSQL) 18."*',
        '"pg_restore (PostgreSQL) 18"|"pg_restore (PostgreSQL) 18."*',
    )
    backup_marker = "- name: Run test pre-sync backup"
    backup_start = content.find(backup_marker)
    backup_end = content.find("\n      - name:", backup_start + len(backup_marker))
    backup_block = (
        content[backup_start : backup_end if backup_end >= 0 else len(content)]
        if backup_start >= 0
        else ""
    )
    backup_tokens = (
        'export PATH="/usr/lib/postgresql/18/bin:${PATH}"',
        'resolved_pg_dump="$(command -v pg_dump)"',
        'resolved_pg_restore="$(command -v pg_restore)"',
        'if [ "${resolved_pg_dump}" != "/usr/lib/postgresql/18/bin/pg_dump" ]; then',
        'if [ "${resolved_pg_restore}" != "/usr/lib/postgresql/18/bin/pg_restore" ]; then',
    )
    if install_start < 0 or backup_start < 0 or install_start >= backup_start:
        errors.append(f"{file_name}: PostgreSQL 18 setup must run before the backup step")
    for token in install_tokens:
        if token not in install_block:
            errors.append(f"{file_name}: PostgreSQL 18 PATH safety token missing: {token}")
    for token in backup_tokens:
        if token not in backup_block:
            errors.append(f"{file_name}: PostgreSQL 18 PATH safety token missing: {token}")
    install_order_tokens = (
        "sudo apt-get install --yes postgresql-client-18",
        install_tokens[0],
        install_tokens[1],
        install_tokens[2],
        install_tokens[3],
        install_tokens[4],
        install_tokens[5],
    )
    install_order = [install_block.find(token) for token in install_order_tokens]
    if any(index < 0 for index in install_order) or install_order != sorted(install_order):
        errors.append(
            f"{file_name}: PostgreSQL 18 absolute-path validation must follow installation"
        )

    fail_closed_conditions = (
        (install_block, install_tokens[0]),
        (install_block, install_tokens[1]),
        (backup_block, backup_tokens[3]),
        (backup_block, backup_tokens[4]),
    )
    for block, condition in fail_closed_conditions:
        condition_start = block.find(condition)
        branch_end = block.find("\n          fi", condition_start)
        branch = block[condition_start:branch_end] if branch_end >= 0 else ""
        if condition_start < 0 or not re.search(r"^\s*exit 1\s*$", branch, re.MULTILINE):
            errors.append(
                f"{file_name}: PostgreSQL 18 mismatch branch must fail closed: {condition}"
            )
    case_failures = (
        '*) echo "::error::PostgreSQL dump client major version is not 18"; exit 1 ;;',
        '*) echo "::error::PostgreSQL restore client major version is not 18"; exit 1 ;;',
    )
    for token in case_failures:
        if token not in install_block:
            errors.append(f"{file_name}: PostgreSQL 18 version mismatch must fail closed")

    backup_order = [backup_block.find(token) for token in backup_tokens]
    secret_access_index = backup_block.find("gcloud secrets versions access")
    invocation_index = backup_block.find(
        "python scripts/backup_test_environment_pre_sync.py --execute"
    )
    if (
        any(index < 0 for index in backup_order)
        or secret_access_index < 0
        or invocation_index < 0
        or backup_order != sorted(backup_order)
        or not (backup_order[-1] < secret_access_index < invocation_index)
    ):
        errors.append(
            f"{file_name}: PostgreSQL 18 PATH resolution must precede secret access and backup"
        )


def validate_sync_backup_invocation(content: str, file_name: str, errors: list[str]) -> None:
    if file_name != "sync-prod-to-test.yml":
        return
    invocation_pattern = re.compile(
        r"^\s*python scripts/backup_test_environment_pre_sync\.py --execute\s*$",
        re.MULTILINE,
    )
    invocations = list(invocation_pattern.finditer(content))
    script_mentions = re.findall(r"backup_test_environment_pre_sync\.py", content)
    if len(invocations) != 1 or len(script_mentions) != 1:
        errors.append(
            f"{file_name}: backup script must be invoked exactly once with --execute"
        )
        return

    invocation_start = invocations[0].start()
    step_start = content.rfind("\n      - name:", 0, invocation_start)
    step_end = content.find("\n      - name:", invocation_start)
    step_block = content[step_start : step_end if step_end >= 0 else len(content)]
    if "if: ${{ inputs.dry_run == 'false' }}" not in step_block:
        errors.append(f"{file_name}: backup step must require dry_run == 'false'")
    backup_step_tokens = (
        "OPERATION_ID: ${{ inputs.operation_id }}",
        "TARGET_GIT_SHA: ${{ inputs.target_git_sha }}",
        "DB_HOST: 127.0.0.1",
        'DB_PORT: "5432"',
        "DB_NAME_TEST: ${{ vars.TEST_DB_NAME }}",
        "DB_USER_TEST: ${{ secrets.TEST_DB_USER }}",
        "GCS_BUCKET_TEST: ${{ vars.TEST_GCS_BUCKET }}",
        "trap cleanup_proxy EXIT",
        "gcloud secrets versions access",
        'echo "::add-mask::${DB_PASSWORD}"',
    )
    for token in backup_step_tokens:
        if token not in step_block:
            errors.append(f"{file_name}: backup step safety token missing: {token}")
    if "GITHUB_ENV" in step_block:
        errors.append(f"{file_name}: backup step must not write DB password to GITHUB_ENV")

    verification_start = content.find("- name: Verify prod and test database read-only connections")
    guard_start = content.find("- name: Template guard")
    if (
        verification_start < 0
        or guard_start < 0
        or not (verification_start < invocation_start < guard_start)
    ):
        errors.append(
            f"{file_name}: backup must run after read-only DB verification and before template guard"
        )
    if "ref: ${{ inputs.target_git_sha }}" in content:
        errors.append(f"{file_name}: executable scripts must not be checked out from target_git_sha")


def validate_sync_restore_gates(content: str, file_name: str, errors: list[str]) -> None:
    if file_name != "sync-prod-to-test.yml":
        return

    ordered_markers = (
        "- name: Run test pre-sync backup",
        "- name: Validate test pre-sync backup manifest",
        "- name: Enable test maintenance and drain requests",
        "- name: Verify test database connections are drained",
        "- name: Template guard",
    )
    positions = [content.find(marker) for marker in ordered_markers]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        errors.append(
            f"{file_name}: backup, manifest, maintenance, drain check, and template guard order is invalid"
        )

    required_invocations = (
        "python scripts/check_backup_manifest.py",
        "python scripts/manage_test_maintenance.py enable",
        "python scripts/check_test_db_connections_drained.py",
    )
    for invocation in required_invocations:
        if content.count(invocation) != 1:
            errors.append(f"{file_name}: required gate must be invoked exactly once: {invocation}")
            continue
        invocation_start = content.find(invocation)
        step_start = content.rfind("\n      - name:", 0, invocation_start)
        step_end = content.find("\n      - name:", invocation_start)
        step_block = content[step_start : step_end if step_end >= 0 else len(content)]
        if "if: ${{ inputs.dry_run == 'false' }}" not in step_block:
            errors.append(f"{file_name}: restore gate must require dry_run == 'false': {invocation}")

    safety_tokens = (
        'EXPECTED_TEST_REVISION: ${{ inputs.expected_test_revision }}',
        'MAINTENANCE_CONFIRMATION: ${{ inputs.maintenance_confirmation }}',
        '--confirmation "${MAINTENANCE_CONFIRMATION}"',
        '--expected-revision "${EXPECTED_TEST_REVISION}"',
        "trap cleanup_proxy EXIT",
        "default_transaction_read_only=on",
    )
    combined = content + read_text(DB_DRAIN_CHECK_SCRIPT)
    for token in safety_tokens:
        if token not in combined:
            errors.append(f"{file_name}: restore gate safety token missing: {token}")


def validate_verification_script(path: Path, errors: list[str]) -> None:
    if not path.exists():
        errors.append(f"missing database verification script: {path.name}")
        return
    content = read_text(path)
    if "default_transaction_read_only=on" not in content:
        errors.append(f"{path.name}: read-only connection option is missing")
    match = WRITE_SQL_PATTERN.search(content)
    if match:
        errors.append(f"{path.name}: write SQL keyword is forbidden: {match.group(0)}")


def validate_backup_script(path: Path, errors: list[str]) -> None:
    if not path.exists():
        errors.append(f"missing test pre-sync backup script: {path.name}")
        return
    content = read_text(path)
    required_tokens = (
        "execute: bool = False",
        "if_generation_match=0",
        "source_generation=source_generation",
        "if_source_generation_match=source_generation",
        "manifest_blob.upload_from_string",
        "POSTGRES_REQUIRED_MAJOR_VERSION = 18",
    )
    for token in required_tokens:
        if token not in content:
            errors.append(f"{path.name}: required safety token missing: {token}")

    execute_start = content.find("def execute_backup(")
    execute_content = content[execute_start:] if execute_start >= 0 else ""
    write_order = [
        execute_content.find("database_blob.upload_from_filename"),
        execute_content.find("_copy_and_verify_gcs_object("),
        execute_content.find("manifest_blob.upload_from_string"),
    ]
    manifest_write = write_order[-1]
    write_after_manifest = any(
        execute_content.find(token, manifest_write + 1) >= 0
        for token in ("database_blob.upload_from_filename", "_copy_and_verify_gcs_object(")
    )
    if (
        any(index < 0 for index in write_order)
        or write_order != sorted(write_order)
        or write_after_manifest
        or execute_content.count("manifest_blob.upload_from_string") != 1
    ):
        errors.append(f"{path.name}: manifest must remain the final backup write")


def validate_maintenance_deploy_guard_script(path: Path, errors: list[str]) -> None:
    if not path.exists():
        errors.append(f"missing maintenance deploy guard script: {path.name}")
        return
    content = read_text(path)
    required_tokens = (
        "ensure_normal_deploy_allowed",
        '"valueFrom" in entry',
        "len(entries) > 1",
        "test maintenance is enabled",
        "return 1",
    )
    for token in required_tokens:
        if token not in content:
            errors.append(f"{path.name}: required fail-closed token missing: {token}")


def validate_maintenance_operation_script(path: Path, errors: list[str]) -> None:
    if not path.exists():
        errors.append(f"missing maintenance operation script: {path.name}")
        return
    content = read_text(path)
    for token in (
        'PROJECT = "kanade-orchestra"',
        'REGION = "asia-northeast2"',
        'SERVICE = "kanade-orchestra-test"',
        "DRAIN_SECONDS = 310",
        '"--no-traffic"',
        '"update-traffic"',
        'f"{revision}=100"',
        "current ready revision does not match the approved revision",
    ):
        if token not in content:
            errors.append(f"{path.name}: required fail-closed token missing: {token}")
    if "MAINTENANCE_MODE=false" in content:
        errors.append(f"{path.name}: automatic maintenance rollback is forbidden")


def run_checks(
    workflow_dir: Path = WORKFLOW_DIR,
    verify_db_script: Path = VERIFY_DB_SCRIPT,
    backup_script: Path | None = None,
    maintenance_deploy_guard_script: Path = MAINTENANCE_DEPLOY_GUARD_SCRIPT,
    maintenance_operation_script: Path = MAINTENANCE_OPERATION_SCRIPT,
) -> list[str]:
    errors: list[str] = []
    backup_script = backup_script or verify_db_script.with_name(BACKUP_SCRIPT.name)

    for file_name in TARGET_WORKFLOWS:
        file_path = workflow_dir / file_name
        if not file_path.exists():
            errors.append(f"missing workflow file: {file_name}")
            continue

        content = read_text(file_path)
        validate_basic_yaml_shape(content, file_name, errors)
        validate_forbidden_tokens(content, file_name, errors)
        validate_required_tokens(content, file_name, errors)
        validate_required_phrases(content, file_name, errors)
        validate_test_target_guards(content, file_name, errors)
        validate_deploy_maintenance_guard(content, file_name, errors)
        validate_maintenance_operation_workflow(content, file_name, errors)
        validate_template_guard(content, file_name, errors)
        validate_no_secret_echo(content, file_name, errors)
        validate_no_direct_input_echo(content, file_name, errors)
        validate_sync_workflow_has_no_write_commands(content, file_name, errors)
        validate_sync_pg18_client_policy(content, file_name, errors)
        validate_sync_backup_invocation(content, file_name, errors)
        validate_sync_restore_gates(content, file_name, errors)

    validate_verification_script(verify_db_script, errors)
    validate_backup_script(backup_script, errors)
    validate_maintenance_deploy_guard_script(maintenance_deploy_guard_script, errors)
    validate_maintenance_operation_script(maintenance_operation_script, errors)
    return errors


def main() -> int:
    errors = run_checks()

    if errors:
        for item in errors:
            fail(item)
        return 1

    print("[PASS] Workflow static checks passed")
    print("[PASS] Target workflows: deploy-test.yml, promote-production.yml, sync-prod-to-test.yml, test-maintenance.yml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
