from __future__ import annotations

import importlib.util
import sys
import zipfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "create-source-zip.py"


def _load_source_zip_module():
    spec = importlib.util.spec_from_file_location("source_zip_builder_design_docs", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_source_share_includes_all_root_markdown_documents(tmp_path):
    """A fresh source-share extraction retains the full root design baseline."""
    module = _load_source_zip_module()
    expected = {path.name for path in PROJECT_ROOT.glob("*.md") if path.is_file()}
    included = {
        path.name for path in module.included_top_level_paths() if path.is_file()
    }
    assert expected <= included

    module.DIST_DIR = tmp_path / "source-share"
    module.TMP_DIR = module.DIST_DIR / ".tmp-source-share"
    zip_path, _ = module.build_zip()
    with zipfile.ZipFile(zip_path) as archive:
        assert expected <= set(archive.namelist())
