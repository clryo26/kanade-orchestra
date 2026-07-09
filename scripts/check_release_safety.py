#!/usr/bin/env python3
from __future__ import annotations

import ast
import json
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES_FILE = ROOT / "scripts" / "source_zip_safety_rules.json"

REQUIRED_PATHS = [
    ROOT / "playwright.config.js",
    ROOT / "tests" / "e2e",
    ROOT / "scripts" / "run-local-qa.ps1",
    ROOT / "docs" / "MANUAL_DEVICE_QA_CHECKLIST.md",
    ROOT / "docs" / "PRODUCTION_RELEASE_CHECKLIST.md",
    ROOT / "docs" / "CLOUD_RUN_GCS_DB_CHECK.md",
    ROOT / "docs" / "APP_CORE_COMPAT_POLICY.md",
    ROOT / "src" / "data" / ".gitkeep",
    ROOT / "src" / "data" / "access_logs.example.json",
    ROOT / "src" / "data" / "auth_devices.example.json",
    ROOT / "src" / "data" / "connection_settings.example.json",
]

ALLOWED_APP_CORE_IMPORTS = {
    "src/backend/main.py",
    "src/backend/core/compat_gateway.py",
    "src/backend/app_core.py",
}

ALLOWED_CANDIDATE_EXCEPTIONS = {
    ".env.example",
}

APP_JS_MAX_LINES = 140
APP_JS_MARKER = "Deprecated compatibility entrypoint."

# These markers belong to the removed incomplete flyer-place prototype. Keep the
# guard narrow so the current flyer distribution implementation remains allowed.
INCOMPLETE_FLYER_FEATURE_MARKERS = (
    "renderFlyerPlacesAdmin",
    "flyerDistributionSelectedPerformanceId",
    "flyer_places",
    "flyerPlaces",
)
INCOMPLETE_FLYER_SCAN_ROOTS = (
    ROOT / "src" / "static" / "js",
    ROOT / "src" / "backend",
    ROOT / "src" / "index.html",
)

def _load_zip_module():
    script_path = ROOT / "scripts" / "create-source-zip.py"
    spec = importlib.util.spec_from_file_location("create_source_zip", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load create-source-zip.py")
    module = importlib.util.module_from_spec(spec)
    # dataclass processing expects the defining module to be present in sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _load_candidate_exceptions() -> set[str]:
    if not RULES_FILE.exists():
        return set(ALLOWED_CANDIDATE_EXCEPTIONS)
    data = json.loads(RULES_FILE.read_text(encoding="utf-8"))
    candidates = data.get("allowedCandidateExceptions")
    if not isinstance(candidates, list):
        return set(ALLOWED_CANDIDATE_EXCEPTIONS)
    return {str(item) for item in candidates}


def _print_step(ok: bool, message: str) -> None:
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {message}")


def _check_required_paths() -> bool:
    missing = [path for path in REQUIRED_PATHS if not path.exists()]
    if missing:
        for path in missing:
            _print_step(False, f"Required file missing: {path.relative_to(ROOT).as_posix()}")
        return False

    package_json = ROOT / "package.json"
    text = package_json.read_text(encoding="utf-8")
    if '"test:e2e"' not in text:
        _print_step(False, "package.json missing test:e2e script")
        return False

    return True


def _check_candidate_safety() -> bool:
    module = _load_zip_module()
    included_files, _ = module.collect_files()
    allowed_exceptions = _load_candidate_exceptions()

    violations: list[str] = []
    for file_path in included_files:
        rel = file_path.relative_to(ROOT).as_posix()
        if rel in allowed_exceptions:
            continue
        issues = module._scan_entry_name(rel)
        for issue in issues:
            violations.append(f"{rel} ({issue})")

    if violations:
        _print_step(False, "Forbidden files detected in source-share candidates")
        for item in sorted(set(violations))[:50]:
            print(f"  - {item}")
        return False

    return True


def _imports_app_core(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "src.backend.app_core" or alias.name.endswith(".app_core"):
                    return True
        elif isinstance(node, ast.ImportFrom):
            if node.module in {"app_core", "src.backend.app_core"}:
                return True
            if node.module == "src.backend" and any(alias.name == "app_core" for alias in node.names):
                return True
            if node.module is None and any(alias.name == "app_core" for alias in node.names):
                return True
            if node.module and node.module.endswith(".app_core"):
                return True
    return False


def _check_app_core_import_boundary() -> bool:
    backend_root = ROOT / "src" / "backend"
    offenders: list[str] = []

    for path in backend_root.rglob("*.py"):
        rel = path.relative_to(ROOT).as_posix()
        if rel in ALLOWED_APP_CORE_IMPORTS:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        if _imports_app_core(tree):
            offenders.append(rel)

    if offenders:
        _print_step(False, "app_core direct import boundary violated")
        for item in sorted(offenders):
            print(f"  - {item}")
        return False
    return True


def _check_frontend_policy() -> bool:
    app_js = ROOT / "src" / "static" / "js" / "app.js"
    text = app_js.read_text(encoding="utf-8")
    line_count = len(text.splitlines())

    ok = True
    if APP_JS_MARKER not in text:
        _print_step(False, "app.js compatibility marker missing")
        ok = False
    if line_count > APP_JS_MAX_LINES:
        _print_step(False, f"app.js appears to have grown ({line_count} lines > {APP_JS_MAX_LINES})")
        ok = False

    return ok


def _check_no_incomplete_flyer_feature_residue() -> bool:
    """Reject partial remnants of the removed flyer-place prototype."""
    offenders: list[str] = []

    for scan_root in INCOMPLETE_FLYER_SCAN_ROOTS:
        candidates = [scan_root] if scan_root.is_file() else scan_root.rglob("*")
        for path in candidates:
            if not path.is_file():
                continue
            if path.suffix not in {".js", ".mjs", ".py", ".html"}:
                continue
            text = path.read_text(encoding="utf-8-sig")
            for marker in INCOMPLETE_FLYER_FEATURE_MARKERS:
                if marker in text:
                    offenders.append(f"{path.relative_to(ROOT).as_posix()} ({marker})")

    if offenders:
        _print_step(False, "Incomplete flyer feature residue detected")
        for item in sorted(set(offenders)):
            print(f"  - {item}")
        return False
    return True


def _check_app_core_size() -> bool:
    app_core_path = ROOT / "src" / "backend" / "app_core.py"
    line_count = len(app_core_path.read_text(encoding="utf-8").splitlines())
    max_lines = 520
    if line_count > max_lines:
        _print_step(False, f"app_core line budget exceeded ({line_count} > {max_lines})")
        return False
    return True


def main() -> int:
    ok = True

    required_ok = _check_required_paths()
    _print_step(required_ok, "Required release files and QA topology")
    ok = ok and required_ok

    candidate_ok = _check_candidate_safety()
    _print_step(candidate_ok, "Source-share candidate safety scan")
    ok = ok and candidate_ok

    boundary_ok = _check_app_core_import_boundary()
    _print_step(boundary_ok, "app_core import boundary")
    ok = ok and boundary_ok

    frontend_ok = _check_frontend_policy()
    _print_step(frontend_ok, "Frontend safety policy")
    ok = ok and frontend_ok

    flyer_residue_ok = _check_no_incomplete_flyer_feature_residue()
    _print_step(flyer_residue_ok, "Incomplete flyer feature residue")
    ok = ok and flyer_residue_ok

    app_core_size_ok = _check_app_core_size()
    _print_step(app_core_size_ok, "app_core line budget")
    ok = ok and app_core_size_ok

    if not ok:
        return 1

    print("[PASS] Release safety checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
