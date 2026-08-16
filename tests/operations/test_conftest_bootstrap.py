from __future__ import annotations

from pathlib import Path


def test_conftest_defers_application_imports_until_fixture_use():
    source = Path("tests/conftest.py").read_text(encoding="utf-8")

    prefix = source.split("@pytest.fixture", 1)[0]
    assert "from fastapi.testclient import TestClient" not in prefix
    assert "from src.backend import main as backend" not in prefix
    assert "from src.backend.services import album_service" not in prefix

    assert (
        "def backend_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):\n"
        "    from src.backend import main as backend\n"
        "    from src.backend.services import album_service\n"
    ) in source
    assert (
        "def client(backend_env):\n"
        "    from fastapi.testclient import TestClient\n"
    ) in source
