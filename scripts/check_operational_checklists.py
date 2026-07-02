#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REQUIRED_DOC_RULES = {
    "docs/PRODUCTION_RELEASE_CHECKLIST.md": [
        "Cloud Run",
        "PostgreSQL / DB",
        "iPhone / PWA",
        "本番反映前最終確認",
    ],
    "docs/MANUAL_DEVICE_QA_CHECKLIST.md": [
        "iPhone Safari",
        "PWA",
        "団員導線",
        "管理導線",
    ],
    "docs/CLOUD_RUN_GCS_DB_CHECK.md": [
        "Cloud Run 環境変数チェック",
        "DATABASE_URL / DB 接続",
        "GCS_BUCKET / 権限",
        "ロールバック確認",
    ],
}



def fail(message: str) -> None:
    print(f"[FAIL] {message}")
    raise SystemExit(1)


def main() -> int:
    for rel_path, required_phrases in REQUIRED_DOC_RULES.items():
        path = ROOT / rel_path
        if not path.exists():
            fail(f"Missing required document: {rel_path}")
        text = path.read_text(encoding="utf-8")

        if "- [ ]" not in text:
            fail(f"Checklist format not found in {rel_path}")

        missing = [phrase for phrase in required_phrases if phrase not in text]
        if missing:
            fail(f"Missing required sections in {rel_path}: {', '.join(missing)}")

    print("[PASS] Operational checklists are present and contain required sections")
    return 0


if __name__ == "__main__":
    sys.exit(main())
