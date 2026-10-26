from __future__ import annotations


def test_main_app_import_succeeds():
    from src.backend.main import app

    assert app is not None
    # Included routers may be represented lazily by FastAPI. Check the public
    # API schema instead of relying on every internal route having a .path.
    # This smoke check covers schema-visible endpoints; hidden routes need HTTP tests.
    paths = app.openapi()["paths"]
    assert "/api/system/access-logs" in paths
