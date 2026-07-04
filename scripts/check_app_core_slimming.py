#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "src" / "backend" / "app_core.py"


def main() -> int:
    max_lines = int(str(os.getenv("APP_CORE_MAX_LINES", "520") or "520"))
    source = TARGET.read_text(encoding="utf-8")
    line_count = len(source.splitlines())

    if line_count > max_lines:
        print(f"[FAIL] app_core line budget exceeded: {line_count} > {max_lines}")
        return 1

    print(f"[PASS] app_core line budget: {line_count} <= {max_lines}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
