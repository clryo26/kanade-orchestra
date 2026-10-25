"""Protocol opt-in must add no SQL to default or unrelated requests."""
from types import SimpleNamespace

import pytest

from src.backend.repositories.db_item_repository import ItemContext, _prepare_album_write


@pytest.mark.parametrize("flag", [None, "", "false", "0", "off", "invalid"])
def test_default_or_disabled_never_touches_connection(monkeypatch, flag):
    if flag is None:
        monkeypatch.delenv("PORTAL_ALBUM_WRITE_PROTOCOL_V2", raising=False)
    else:
        monkeypatch.setenv("PORTAL_ALBUM_WRITE_PROTOCOL_V2", flag)
    _prepare_album_write(object(), "albums")


@pytest.mark.parametrize("flag", ["1", "true", "yes", " ON "])
def test_enabled_sets_fixed_local_marker_once_per_context(monkeypatch, flag):
    monkeypatch.setenv("PORTAL_ALBUM_WRITE_PROTOCOL_V2", flag)
    statements = []
    ctx = ItemContext(SimpleNamespace(autocommit=False), SimpleNamespace(execute=statements.append), "synthetic")
    _prepare_album_write(ctx, "albums")
    _prepare_album_write(ctx, "albums")
    assert statements == ["SET LOCAL app.album_delete_protocol = 'v2'"]
    assert ctx.album_protocol_set


def test_other_collection_never_sets_marker(monkeypatch):
    monkeypatch.setenv("PORTAL_ALBUM_WRITE_PROTOCOL_V2", "true")
    _prepare_album_write(object(), "members")


def test_autocommit_is_rejected_before_setting_marker(monkeypatch):
    monkeypatch.setenv("PORTAL_ALBUM_WRITE_PROTOCOL_V2", "true")
    ctx = ItemContext(SimpleNamespace(autocommit=True), object(), "synthetic")
    with pytest.raises(RuntimeError, match="explicit transaction"):
        _prepare_album_write(ctx, "albums")
    assert not ctx.album_protocol_set


def test_failed_set_is_not_marked_as_success(monkeypatch):
    monkeypatch.setenv("PORTAL_ALBUM_WRITE_PROTOCOL_V2", "true")

    def fail(_sql):
        raise TimeoutError("synthetic")

    ctx = ItemContext(SimpleNamespace(autocommit=False), SimpleNamespace(execute=fail), "synthetic")
    with pytest.raises(TimeoutError):
        _prepare_album_write(ctx, "albums")
    assert not ctx.album_protocol_set
