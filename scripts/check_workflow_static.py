#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover - dependency guard
    yaml = None

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

SECRET_EXPRESSION_PATTERN = re.compile(r"\$\{\{\s*secrets\.", re.IGNORECASE)


def fail(message: str) -> None:
    print(f"[FAIL] {message}")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception as exc:  # pragma: no cover - defensive IO error path
        raise RuntimeError(f"cannot read {path}: {exc}") from exc


def parse_yaml(content: str, file_name: str, errors: list[str]) -> Any | None:
    if yaml is None:
        errors.append(f"{file_name}: PyYAML is required for workflow YAML parsing")
        return None
    try:
        parsed = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        errors.append(f"{file_name}: invalid YAML: {exc}")
        return None
    if not isinstance(parsed, dict):
        errors.append(f"{file_name}: top-level YAML document must be a mapping")
        return None
    return parsed


def validate_workflow_structure(parsed: Any, file_name: str, errors: list[str]) -> None:
    if not isinstance(parsed, dict):
        return
    # PyYAML follows YAML 1.1 and can parse the unquoted key `on` as True.
    has_on = "on" in parsed or True in parsed
    for key, present in (("name", "name" in parsed), ("on", has_on), ("jobs", "jobs" in parsed)):
        if not present:
            errors.append(f"{file_name}: missing top-level key '{key}'")
    if "jobs" in parsed and not isinstance(parsed["jobs"], dict):
        errors.append(f"{file_name}: top-level key 'jobs' must be a mapping")


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


def _walk_run_blocks(value: Any, path: str = "") -> list[tuple[str, str]]:
    blocks: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if key == "run" and isinstance(child, str):
                blocks.append((child_path, child))
            blocks.extend(_walk_run_blocks(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            blocks.extend(_walk_run_blocks(child, f"{path}[{index}]"))
    return blocks


def validate_no_secret_in_run_blocks(parsed: Any, file_name: str, errors: list[str]) -> None:
    if not isinstance(parsed, dict):
        return
    for path, run_block in _walk_run_blocks(parsed):
        if SECRET_EXPRESSION_PATTERN.search(run_block):
            errors.append(
                f"{file_name}: direct secret expression in run block is forbidden: {path}"
            )


def main() -> int:
    errors: list[str] = []

    for file_name in TARGET_WORKFLOWS:
        file_path = WORKFLOW_DIR / file_name
        if not file_path.exists():
            errors.append(f"missing workflow file: {file_name}")
            continue

        content = read_text(file_path)
        parsed = parse_yaml(content, file_name, errors)
        validate_workflow_structure(parsed, file_name, errors)
        validate_forbidden_tokens(content, file_name, errors)
        validate_required_tokens(content, file_name, errors)
        validate_required_phrases(content, file_name, errors)
        validate_template_guard(content, file_name, errors)
        validate_no_secret_in_run_blocks(parsed, file_name, errors)

    if errors:
        for item in errors:
            fail(item)
        return 1

    print("[PASS] Workflow static checks passed")
    print("[PASS] YAML syntax and required workflow policy checks passed")
    print("[PASS] Target workflows: deploy-test.yml, promote-production.yml, sync-prod-to-test.yml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
