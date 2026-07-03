#!/usr/bin/env python3
from __future__ import annotations

import fnmatch
import json
import os
import shutil
import sys
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
DIST_DIR = ROOT / "dist" / "source-share"
TMP_DIR = DIST_DIR / ".tmp-source-share"
RULES_FILE = ROOT / "scripts" / "source_zip_safety_rules.json"

INCLUDE_DIRS = [
    "src",
    "tests",
    "scripts",
    "docs",
    "infra",
    ".github",
]

INCLUDE_FILES = [
    "README.md",
    "AGENTS.md",
    "playwright.config.js",
    "package.json",
    "package-lock.json",
    "pyproject.toml",
    ".env.example",
    ".gitignore",
    ".dockerignore",
    "Dockerfile",
]

INCLUDE_GLOBS = [
    "requirements*.txt",
    "docker-compose*",
    "cloudbuild*.yaml",
    "cloudbuild*.yml",
]

EXCLUDE_DIR_NAMES = {
    ".git",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    ".cache",
    "coverage",
    "htmlcov",
}

EXCLUDE_DIR_PREFIXES = [
    ".uv-cache",
    ".ruff-cache",
]

EXCLUDE_FILE_PATTERNS = [
    ".env",
    ".env.*",
    "*.pyc",
    "*.pyo",
    "*.tmp",
    "*.bak",
    "*.log",
    "Thumbs.db",
    ".DS_Store",
    "*.wav",
    "*.mp3",
    "*.m4a",
    "*.flac",
    "*.db",
    "*.sqlite",
    "*.sqlite3",
    "*.zip",
    "*service-account*.json",
    "*credentials*.json",
    "src/data/*.json",
    "src/data/**/*.json",
    "data/*.json",
    "data/**/*.json",
    "src/data/access_logs*",
    "src/data/auth_devices*",
    "src/data/connection_settings*",
    "data/access_logs*",
    "data/auth_devices*",
    "data/connection_settings*",
]

SAFETY_BANNED_NAME_PATTERNS = [
    re.compile(r"(^|/)src/data/.*\.json$", re.IGNORECASE),
    re.compile(r"(^|/)data/.*\.json$", re.IGNORECASE),
    re.compile(r"(^|/)src/data/access_logs[^/]*$", re.IGNORECASE),
    re.compile(r"(^|/)src/data/auth_devices[^/]*$", re.IGNORECASE),
    re.compile(r"(^|/)src/data/connection_settings[^/]*$", re.IGNORECASE),
    re.compile(r"(^|/)data/access_logs[^/]*$", re.IGNORECASE),
    re.compile(r"(^|/)data/auth_devices[^/]*$", re.IGNORECASE),
    re.compile(r"(^|/)data/connection_settings[^/]*$", re.IGNORECASE),
    re.compile(r"(^|/)\.env($|\.)", re.IGNORECASE),
    re.compile(r"(^|/)\.git/", re.IGNORECASE),
    re.compile(r"(^|/)\.venv/", re.IGNORECASE),
    re.compile(r"(^|/)node_modules/", re.IGNORECASE),
    re.compile(r"\.(sqlite|db|log|wav|mp3|m4a|flac)$", re.IGNORECASE),
    re.compile(r"credentials", re.IGNORECASE),
    re.compile(r"service-account", re.IGNORECASE),
]

SAFETY_BANNED_CONTENT_PATTERNS = [
    re.compile(r"\bdevice_id\b", re.IGNORECASE),
    re.compile(r"credentials", re.IGNORECASE),
    re.compile(r"service-account", re.IGNORECASE),
]

CONTENT_SCAN_TARGET_PATTERNS = [
    re.compile(r"(^|/)src/data/", re.IGNORECASE),
    re.compile(r"(^|/)data/", re.IGNORECASE),
    re.compile(r"access_logs", re.IGNORECASE),
    re.compile(r"auth_devices", re.IGNORECASE),
    re.compile(r"connection_settings", re.IGNORECASE),
]

ALLOWED_DOT_ENV_FILES = {
    ".env.example",
}

ALLOWED_DATA_TEMPLATE_FILES = {
    "src/data/.gitkeep",
}


def _load_rules() -> None:
    if not RULES_FILE.exists():
        return

    data = json.loads(RULES_FILE.read_text(encoding="utf-8"))

    exclude_patterns = data.get("excludeFilePatterns")
    if isinstance(exclude_patterns, list) and exclude_patterns:
        EXCLUDE_FILE_PATTERNS.clear()
        EXCLUDE_FILE_PATTERNS.extend(str(item) for item in exclude_patterns)

    banned_name = data.get("safetyBannedNamePatterns")
    if isinstance(banned_name, list) and banned_name:
        SAFETY_BANNED_NAME_PATTERNS.clear()
        SAFETY_BANNED_NAME_PATTERNS.extend(re.compile(str(item), re.IGNORECASE) for item in banned_name)

    banned_content = data.get("safetyBannedContentPatterns")
    if isinstance(banned_content, list) and banned_content:
        SAFETY_BANNED_CONTENT_PATTERNS.clear()
        SAFETY_BANNED_CONTENT_PATTERNS.extend(re.compile(str(item), re.IGNORECASE) for item in banned_content)

    content_targets = data.get("contentScanTargetPatterns")
    if isinstance(content_targets, list) and content_targets:
        CONTENT_SCAN_TARGET_PATTERNS.clear()
        CONTENT_SCAN_TARGET_PATTERNS.extend(re.compile(str(item), re.IGNORECASE) for item in content_targets)

    allowed_env = data.get("allowedDotEnvFiles")
    if isinstance(allowed_env, list) and allowed_env:
        ALLOWED_DOT_ENV_FILES.clear()
        ALLOWED_DOT_ENV_FILES.update(str(item) for item in allowed_env)

    allowed_templates = data.get("allowedDataTemplateFiles")
    if isinstance(allowed_templates, list) and allowed_templates:
        ALLOWED_DATA_TEMPLATE_FILES.clear()
        ALLOWED_DATA_TEMPLATE_FILES.update(str(item) for item in allowed_templates)


_load_rules()


@dataclass
class ZipStats:
    included_files: int = 0
    excluded_files: int = 0


def should_exclude(path: Path) -> bool:
    rel = path.relative_to(ROOT).as_posix()
    parts = path.relative_to(ROOT).parts
    name = path.name

    if rel in ALLOWED_DATA_TEMPLATE_FILES:
        return False

    if rel.startswith("src/data/"):
        if name.endswith(".example.json") or name == ".gitkeep":
            return False
        if rel.endswith(".json"):
            return True

    if rel.startswith("data/"):
        if name.endswith(".example.json"):
            return False
        if rel.endswith(".json"):
            return True

    if name in ALLOWED_DOT_ENV_FILES:
        return False

    if rel.startswith("dist/source-share/"):
        return True

    if rel == ".vscode/settings.json":
        return True

    for part in parts[:-1]:
        if part in EXCLUDE_DIR_NAMES:
            return True
        if any(part.startswith(prefix) for prefix in EXCLUDE_DIR_PREFIXES):
            return True

    if "src/uploads/" in f"{rel}/" or rel.startswith("uploads/"):
        return True

    return any(fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(rel, pattern) for pattern in EXCLUDE_FILE_PATTERNS)


def included_top_level_paths() -> list[Path]:
    paths: list[Path] = []
    for directory in INCLUDE_DIRS:
        target = ROOT / directory
        if target.exists():
            paths.append(target)
    for file_name in INCLUDE_FILES:
        target = ROOT / file_name
        if target.exists():
            paths.append(target)
    for pattern in INCLUDE_GLOBS:
        for target in ROOT.glob(pattern):
            if target.exists() and target not in paths:
                paths.append(target)
    return paths


def collect_files() -> tuple[list[Path], int]:
    include_paths = included_top_level_paths()
    included: list[Path] = []
    excluded_count = 0
    seen: set[Path] = set()

    for include_path in include_paths:
        if include_path.is_file():
            if should_exclude(include_path):
                excluded_count += 1
            elif include_path not in seen:
                included.append(include_path)
                seen.add(include_path)
            continue

        for candidate in include_path.rglob("*"):
            if not candidate.is_file():
                continue
            if should_exclude(candidate):
                excluded_count += 1
                continue
            if candidate in seen:
                continue
            included.append(candidate)
            seen.add(candidate)

    included.sort(key=lambda p: p.relative_to(ROOT).as_posix())
    return included, excluded_count


def _is_allowed_data_template_entry(name: str) -> bool:
    lowered = name.lower()
    if lowered in ALLOWED_DATA_TEMPLATE_FILES:
        return True
    return lowered.endswith(".example.json")


def _scan_entry_name(name: str) -> list[str]:
    lowered = name.replace("\\", "/").lower().strip("/")
    base_name = os.path.basename(lowered)
    issues: list[str] = []

    if base_name in ALLOWED_DOT_ENV_FILES:
        return issues

    if base_name == ".env":
        issues.append(".env file is forbidden")
    if base_name.startswith(".env.") and base_name not in ALLOWED_DOT_ENV_FILES:
        issues.append(".env.* file is forbidden")

    if _is_allowed_data_template_entry(lowered):
        return issues

    for pattern in SAFETY_BANNED_NAME_PATTERNS:
        if pattern.search(lowered):
            issues.append(f"forbidden path pattern: {pattern.pattern}")
    return issues


def validate_candidates(candidates: list[Path]) -> None:
    violations: list[str] = []
    for file_path in candidates:
        rel = file_path.relative_to(ROOT).as_posix()
        issues = _scan_entry_name(rel)
        for issue in issues:
            violations.append(f"{rel} ({issue})")
    if violations:
        preview = "\n".join(f"- {item}" for item in sorted(set(violations))[:50])
        raise RuntimeError(f"Pre-zip safety check failed.\n{preview}")


def _should_scan_content(name: str) -> bool:
    normalized = name.replace("\\", "/").lower()
    return any(pattern.search(normalized) for pattern in CONTENT_SCAN_TARGET_PATTERNS)


def validate_zip(zip_path: Path) -> None:
    violations: list[str] = []
    with zipfile.ZipFile(zip_path, "r") as archive:
        for entry in archive.infolist():
            name = entry.filename.replace("\\", "/").strip("/")
            issues = _scan_entry_name(name)
            for issue in issues:
                violations.append(f"{name} ({issue})")

            if not _should_scan_content(name):
                continue
            if entry.is_dir():
                continue

            lower_name = name.lower()
            if not (lower_name.endswith(".json") or lower_name.endswith(".txt") or lower_name.endswith(".env")):
                continue

            try:
                raw = archive.read(entry)
                text = raw.decode("utf-8", errors="ignore")
            except Exception:
                continue

            for pattern in SAFETY_BANNED_CONTENT_PATTERNS:
                if pattern.search(text):
                    violations.append(f"{name} (forbidden content: {pattern.pattern})")

    if violations:
        preview = "\n".join(f"- {item}" for item in sorted(set(violations))[:100])
        raise RuntimeError(f"Post-zip safety check failed.\n{preview}")


def build_zip() -> tuple[Path, ZipStats]:
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    included_files, excluded_count = collect_files()
    validate_candidates(included_files)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    zip_path = DIST_DIR / f"oke-portal-source-{timestamp}.zip"

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in included_files:
            archive.write(file_path, arcname=file_path.relative_to(ROOT).as_posix())

    try:
        validate_zip(zip_path)
    except Exception:
        zip_path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(TMP_DIR, ignore_errors=True)

    return zip_path, ZipStats(included_files=len(included_files), excluded_files=excluded_count)


def format_size(size_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    size = float(size_bytes)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.2f} {unit}"
        size /= 1024
    return f"{size_bytes} B"


def main() -> int:
    try:
        zip_path, stats = build_zip()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    size_text = format_size(zip_path.stat().st_size)
    print(f"ZIP保存先: {zip_path}")
    print(f"ZIPサイズ: {size_text}")
    print(f"ファイル数: {stats.included_files}")
    print(f"除外ファイル数: {stats.excluded_files}")
    print("安全検査: PASS")
    print("ChatGPT情報源へアップロードしてください。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
