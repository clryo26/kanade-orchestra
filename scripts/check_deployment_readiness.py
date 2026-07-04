#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist" / "source-share"

REQUIRED_DOCS = [
    ROOT / "docs" / "PRODUCTION_RELEASE_CHECKLIST.md",
    ROOT / "docs" / "MANUAL_DEVICE_QA_CHECKLIST.md",
    ROOT / "docs" / "CLOUD_RUN_GCS_DB_CHECK.md",
    ROOT / "docs" / "ARCHITECTURE_DECISIONS.md",
    ROOT / "docs" / "DECISION_LOG_GUIDE.md",
]

REQUIRED_ROOT_DOCUMENT_ENTRIES = {
    path.name
    for path in ROOT.glob("*.md")
    if path.is_file()
}

REQUIRED_ZIP_ENTRIES = {
    "playwright.config.js",
    "docs/MANUAL_DEVICE_QA_CHECKLIST.md",
    "docs/CLOUD_RUN_GCS_DB_CHECK.md",
    "docs/ARCHITECTURE_DECISIONS.md",
    "docs/DECISION_LOG_GUIDE.md",
    "tests/e2e/ui_css_reliability.spec.js",
    "UNIT_TEST_SPEC.md",
    "INTEGRATION_TEST_SPEC.md",
    "INTEGRATION_TEST_SPEC_BACKEND.md",
    "INTEGRATION_TEST_SPEC_FRONTEND.md",
    "INTEGRATION_TEST_SPEC_CI.md",
    "OPERATION_TEST_SPEC.md",
    "DESIGN_DOCS_NAVIGATION.md",
} | REQUIRED_ROOT_DOCUMENT_ENTRIES

# Only persisted runtime data must be excluded. Source modules such as
# src/backend/routers/access_logs.py are safe and required in a source archive.
DANGER_PATTERNS = [
    re.compile(r"(^|/)\.env($|\.)", re.IGNORECASE),
    re.compile(r"(^|/)\.git/", re.IGNORECASE),
    re.compile(r"(^|/)node_modules/", re.IGNORECASE),
    re.compile(r"(^|/)\.venv/", re.IGNORECASE),
    re.compile(r"(^|/)src/data/.*\.json$", re.IGNORECASE),
    re.compile(r"(^|/)data/.*\.json$", re.IGNORECASE),
    re.compile(r"(^|/)(?:src/)?data/access_logs[^/]*$", re.IGNORECASE),
    re.compile(r"(^|/)(?:src/)?data/auth_devices[^/]*$", re.IGNORECASE),
    re.compile(r"(^|/)(?:src/)?data/connection_settings[^/]*$", re.IGNORECASE),
    re.compile(r"\.(wav|mp3|m4a|flac)$", re.IGNORECASE),
    re.compile(r"\.(db|sqlite|sqlite3)$", re.IGNORECASE),
    re.compile(r"credentials", re.IGNORECASE),
    re.compile(r"service-account", re.IGNORECASE),
]

ALLOWED_DANGER_EXCEPTIONS = {
    ".env.example",
    "access_logs.example.json",
    "auth_devices.example.json",
    "connection_settings.example.json",
}


def is_dangerous_entry(name: str) -> bool:
    """Return whether an archive member is a prohibited runtime/private artifact."""
    normalized = name.replace("\\", "/").strip("/")
    base_name = normalized.rsplit("/", 1)[-1]
    if base_name in ALLOWED_DANGER_EXCEPTIONS:
        return False
    return any(pattern.search(normalized) for pattern in DANGER_PATTERNS)


def fail(msg: str) -> None:
    print(f"[FAIL] {msg}")
    raise SystemExit(1)


def main() -> int:
    for doc in REQUIRED_DOCS:
        if not doc.exists():
            fail(f"Required document not found: {doc.relative_to(ROOT).as_posix()}")

    zip_files = sorted(DIST.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not zip_files:
        fail("No source-share zip found under dist/source-share")

    latest = zip_files[0]
    print(f"Latest ZIP: {latest.name}")

    with zipfile.ZipFile(latest, "r") as archive:
        names = [name.replace('\\', '/') for name in archive.namelist()]
        name_set = set(names)

        missing = sorted(REQUIRED_ZIP_ENTRIES - name_set)
        if missing:
            fail(f"ZIP missing required entries: {', '.join(missing)}")

        if not any(name.startswith("tests/e2e/") for name in names):
            fail("ZIP missing tests/e2e/ entries")

        danger_hits: list[str] = []
        for name in names:
            if is_dangerous_entry(name):
                danger_hits.append(name)

        if danger_hits:
            fail(f"Dangerous entries found: {', '.join(sorted(set(danger_hits))[:10])}")

    print("[PASS] Required docs present")
    print("[PASS] ZIP includes required QA artifacts")
    print("[PASS] Dangerous file scan")
    return 0


if __name__ == "__main__":
    sys.exit(main())
