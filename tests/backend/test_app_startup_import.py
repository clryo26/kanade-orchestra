from __future__ import annotations


def test_main_app_import_succeeds():
    from src.backend.main import app

    assert app is not None
    paths = {route.path for route in app.routes}
    assert "/api/system/access-logs" in paths
