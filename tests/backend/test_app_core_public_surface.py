from __future__ import annotations

import importlib.util
from pathlib import Path

from src.backend import app_core


def test_app_core_public_surface_is_explicit_and_stable() -> None:
    exported = app_core.__all__

    assert exported == sorted(exported)
    assert len(exported) == len(set(exported))
    assert all(not name.startswith("_") for name in exported)

    for required_name in (
        "app",
        "load_json_data",
        "run_db_startup_self_check",
        "save_json_data",
        "seed_cloud_data_from_local",
    ):
        assert required_name in exported
        assert hasattr(app_core, required_name)


def test_app_core_public_surface_matches_inventory_script() -> None:
    project_root = Path(__file__).resolve().parents[2]
    script_path = project_root / "scripts" / "analyze_app_core_exports.py"
    app_core_path = project_root / "src" / "backend" / "app_core.py"

    spec = importlib.util.spec_from_file_location("analyze_app_core_exports", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    discovered = module.collect_app_core_exports(app_core_path)
    assert set(app_core.__all__) == discovered
