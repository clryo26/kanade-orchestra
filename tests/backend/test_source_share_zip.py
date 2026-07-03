from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "create-source-zip.py"
SPEC = importlib.util.spec_from_file_location("create_source_zip", MODULE_PATH)
assert SPEC and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def test_playwright_config_is_packaged() -> None:
    included_paths = MODULE.included_top_level_paths()
    assert (MODULE.ROOT / "playwright.config.js") in included_paths
    assert (MODULE.ROOT / "tests") in included_paths
    assert (MODULE.ROOT / ".github") in included_paths


def test_access_logs_router_file_is_not_excluded() -> None:
    router_file = MODULE.ROOT / "src" / "backend" / "routers" / "access_logs.py"
    assert router_file.exists()
    assert not MODULE.should_exclude(router_file)
