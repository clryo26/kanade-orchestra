#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_DIR = ROOT / ".github" / "workflows"
VERIFY_DB_SCRIPT = ROOT / "scripts" / "verify_prod_test_db_connections.py"

TARGET_WORKFLOWS = {
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
        ],
        "required_phrases": [
            "docker build",
            "docker push",
            "gcloud run deploy",
            "IMAGE_DIGEST",
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
            "sync_prod_to_test_preflight.py",
            "verify_prod_test_db_connections.py",
            "PROD_DB_USER",
            "TEST_DB_USER",
            "kanade-portal-db-password",
            "DB_CONNECT_TIMEOUT",
            "setup-python",
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


def validate_sync_workflow_has_no_write_commands(
    content: str, file_name: str, errors: list[str]
) -> None:
    if file_name != "sync-prod-to-test.yml":
        return
    if SYNC_WRITE_PATTERN.search(content) or WRITE_SQL_PATTERN.search(content):
        errors.append(f"{file_name}: DB/GCS write or sync command is forbidden in this phase")


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


def run_checks(workflow_dir: Path = WORKFLOW_DIR, verify_db_script: Path = VERIFY_DB_SCRIPT) -> list[str]:
    errors: list[str] = []

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
        validate_template_guard(content, file_name, errors)
        validate_no_secret_echo(content, file_name, errors)
        validate_sync_workflow_has_no_write_commands(content, file_name, errors)

    validate_verification_script(verify_db_script, errors)
    return errors


def main() -> int:
    errors = run_checks()

    if errors:
        for item in errors:
            fail(item)
        return 1

    print("[PASS] Workflow static checks passed")
    print("[PASS] Target workflows: deploy-test.yml, promote-production.yml, sync-prod-to-test.yml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
