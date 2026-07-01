#!/usr/bin/env python3
from __future__ import annotations

import fnmatch
import os
import shutil
import sys
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST_DIR = ROOT / "dist" / "source-share"
TMP_DIR = DIST_DIR / ".tmp-source-share"

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
]

SAFETY_BANS = (
    ".env",
    ".git",
    "node_modules",
    ".venv",
    "__pycache__",
    ".wav",
    ".mp3",
    ".sqlite",
    "credentials",
    "service-account",
)

ALLOWED_DOT_ENV_FILES = {
    ".env.example",
}


@dataclass
class ZipStats:
    included_files: int = 0
    excluded_files: int = 0


def should_exclude(path: Path) -> bool:
    rel = path.relative_to(ROOT).as_posix()
    parts = path.relative_to(ROOT).parts
    name = path.name

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


def validate_zip(zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "r") as archive:
        for name in archive.namelist():
            lowered = name.lower()
            base_name = os.path.basename(lowered)
            parts = lowered.split("/")
            if any(part in {".git", "node_modules", ".venv", "__pycache__"} for part in parts):
                raise RuntimeError(f"Unsafe entry detected: {name}")
            if lowered.endswith((".wav", ".mp3", ".sqlite", ".db", ".sqlite3")):
                raise RuntimeError(f"Unsafe entry detected: {name}")
            if any(token in lowered for token in ("credentials", "service-account")):
                raise RuntimeError(f"Unsafe entry detected: {name}")
            if base_name == ".env":
                raise RuntimeError(f"Unsafe entry detected: {name}")
            if base_name.startswith(".env.") and base_name not in ALLOWED_DOT_ENV_FILES:
                raise RuntimeError(f"Unsafe entry detected: {name}")


def build_zip() -> tuple[Path, ZipStats]:
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    included_files, excluded_count = collect_files()
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
    print("ChatGPT情報源へアップロードしてください。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
