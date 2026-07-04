from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "create-source-zip.py"
REQUIRED_ROOT_SPECS = {
    "UNIT_TEST_SPEC.md",
    "INTEGRATION_TEST_SPEC.md",
    "INTEGRATION_TEST_SPEC_BACKEND.md",
    "INTEGRATION_TEST_SPEC_FRONTEND.md",
    "INTEGRATION_TEST_SPEC_CI.md",
    "OPERATION_TEST_SPEC.md",
    "DESIGN_DOCS_NAVIGATION.md",
}


def _load_source_zip_module():
    spec = importlib.util.spec_from_file_location("source_zip_builder", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves postponed annotations via sys.modules during import.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_source_share_includes_root_test_specs():
    """A source-share extraction must still satisfy operation-document checks."""
    module = _load_source_zip_module()
    included_names = {path.name for path in module.included_top_level_paths()}
    missing = REQUIRED_ROOT_SPECS - included_names
    assert not missing, f"Source-share archive would omit required root specs: {sorted(missing)}"


def test_built_source_share_retains_root_test_specs(tmp_path):
    """Regression check: the actual archive, not only its manifest, keeps QA docs."""
    module = _load_source_zip_module()
    module.DIST_DIR = tmp_path / "source-share"
    module.TMP_DIR = module.DIST_DIR / ".tmp-source-share"
    zip_path, _ = module.build_zip()

    import zipfile

    with zipfile.ZipFile(zip_path) as archive:
        archived_names = set(archive.namelist())
    missing = REQUIRED_ROOT_SPECS - archived_names
    assert not missing, f"Built source-share archive omitted required root specs: {sorted(missing)}"
