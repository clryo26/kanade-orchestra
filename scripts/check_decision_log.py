#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADR_FILE = ROOT / "docs" / "ARCHITECTURE_DECISIONS.md"
GUIDE_FILE = ROOT / "docs" / "DECISION_LOG_GUIDE.md"


ADR_SECTION_PATTERN = re.compile(r"^##\s+ADR-\d{3}:\s+.+$", re.MULTILINE)
REQUIRED_FIELDS = ["- Status:", "- Context:", "- Decision:", "- Consequence:", "- Related:"]


def fail(message: str) -> None:
    print(f"[FAIL] {message}")
    raise SystemExit(1)


def main() -> int:
    if not ADR_FILE.exists():
        fail("Missing docs/ARCHITECTURE_DECISIONS.md")
    if not GUIDE_FILE.exists():
        fail("Missing docs/DECISION_LOG_GUIDE.md")

    adr_text = ADR_FILE.read_text(encoding="utf-8")
    guide_text = GUIDE_FILE.read_text(encoding="utf-8")

    sections = ADR_SECTION_PATTERN.findall(adr_text)
    if not sections:
        fail("No ADR sections found in architecture decisions log")

    for field in REQUIRED_FIELDS:
        if field not in adr_text:
            fail(f"Missing required ADR field in architecture decisions log: {field}")

    if "記録フォーマット" not in guide_text:
        fail("Decision log guide is missing the recording format section")
    if "ARCHITECTURE_DECISIONS.md" not in guide_text:
        fail("Decision log guide is missing architecture decisions reference")

    print(f"[PASS] Decision log checks passed ({len(sections)} ADR sections found)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
