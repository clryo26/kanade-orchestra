from __future__ import annotations

from pathlib import Path


def test_conftest_preserves_normal_import_order_with_fastapi_guard():
    source = Path("tests/conftest.py").read_text(encoding="utf-8")

    prefix = source.split("@pytest.fixture", 1)[0]
    assert 'if importlib.util.find_spec("fastapi") is not None:' in prefix
    assert "from fastapi.testclient import TestClient" in prefix
    assert "from src.backend import main as backend" in prefix
    assert "from src.backend.services import album_service" in prefix
    assert "TestClient = None" in prefix
    assert "backend = None" in prefix
    assert "album_service = None" in prefix

    backend_import = prefix.index("from src.backend import main as backend")
    first_fixture = source.index("@pytest.fixture")
    assert backend_import < first_fixture


def test_conftest_fixtures_fail_clearly_without_application_dependencies():
    source = Path("tests/conftest.py").read_text(encoding="utf-8")

    assert (
        "if backend is None or album_service is None:\n"
        '        pytest.fail("backend test dependencies are unavailable")\n'
    ) in source
    assert (
        "if TestClient is None:\n"
        '        pytest.fail("FastAPI test client is unavailable")\n'
    ) in source
