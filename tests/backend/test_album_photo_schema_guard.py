"""The runtime guard must diagnose a missing tenant column without leaking IDs."""
from types import SimpleNamespace
import logging

import pytest


@pytest.mark.parametrize("missing_table", ["albums", "album_photos"])
def test_missing_organization_column_is_logged_before_photo_select(monkeypatch, caplog, missing_table):
    from src.backend.repositories import album_repository as repository

    def no_select(*args, **kwargs):
        pytest.fail("Missing tenant columns must stop before the photo SELECT")

    ctx = SimpleNamespace(conn=object(), cur=SimpleNamespace(execute=no_select), tenant_id="private-tenant-fixture")
    monkeypatch.setattr(repository, "table_has_organization_id", lambda conn, table: table != missing_table)
    with caplog.at_level(logging.ERROR, logger=repository.__name__):
        with pytest.raises(RuntimeError, match="Album photo lookup requires organization columns"):
            repository.AlbumRepository._select_photo(ctx, 91234, 95678)
    messages = [record.getMessage() for record in caplog.records if record.name == repository.__name__]
    assert len(messages) == 1
    assert f"{missing_table}.organization_id is missing" in messages[0]
    assert "PERF-R13" in messages[0] and "deployment schema prerequisite not met" in messages[0]
    assert "private-tenant-fixture" not in messages[0]
    assert "91234" not in messages[0] and "95678" not in messages[0]
