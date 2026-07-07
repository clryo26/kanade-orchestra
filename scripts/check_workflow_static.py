#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_DIR = ROOT / ".github" / "workflows"

TARGET_WORKFLOWS = {
    "deploy-test.yml": {
        "required_tokens": [
            "TEST_CLOUD_RUN_SERVICE",
            "ARTIFACT_REGISTRY_REPOSITORY",
            "DEPLOY_SERVICE_ACCOUNT",
            "WIF_PROVIDER",
        ],
        "required_phrases": [
            "Template guard",
            "latest tag only",
        ],
    },
    "promote-production.yml": {
        "required_tokens": [
            "PROD_CLOUD_RUN_SERVICE",
            "ARTIFACT_REGISTRY_REPOSITORY",
            "DEPLOY_SERVICE_ACCOUNT",
            "WIF_PROVIDER",
        ],
        "required_phrases": [
            "Template guard",
            "latest tag only",
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
        ],
        "required_phrases": [
            "Allowed direction only: production -> test",
            "Reverse sync (test -> production) must not be implemented.",
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
    if "Template guard" in content and "exit 1" not in content:
        errors.append(f"{file_name}: template guard exists but exit 1 is missing")


def validate_no_secret_echo(content: str, file_name: str, errors: list[str]) -> None:
    for line in content.splitlines():
        if SECRET_ECHO_PATTERN.search(line):
            errors.append(f"{file_name}: echoing secret expression is forbidden: {line.strip()}")


def main() -> int:
    errors: list[str] = []

    for file_name in TARGET_WORKFLOWS:
        file_path = WORKFLOW_DIR / file_name
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

    if errors:
        for item in errors:
            fail(item)
        return 1

    print("[PASS] Workflow static checks passed")
    print("[PASS] Target workflows: deploy-test.yml, promote-production.yml, sync-prod-to-test.yml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
