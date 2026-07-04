from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "check_deployment_readiness.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("deployment_readiness", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_runtime_data_is_rejected_but_source_router_is_allowed():
    module = _load_module()
    assert module.is_dangerous_entry("src/data/access_logs.json")
    assert module.is_dangerous_entry("data/auth_devices.json")
    assert module.is_dangerous_entry("src/data/connection_settings.json")
    assert not module.is_dangerous_entry("src/backend/routers/access_logs.py")


def test_root_test_spec_documents_are_required_in_source_share():
    module = _load_module()
    assert "OPERATION_TEST_SPEC.md" in module.REQUIRED_ZIP_ENTRIES
    assert "DESIGN_DOCS_NAVIGATION.md" in module.REQUIRED_ZIP_ENTRIES
