from uuid import uuid4

import pytest

from src.backend.repositories.db_row_repository import db_row_to_json, db_child_rows_for_collection
from src.backend.services.album_asset_fields import ALBUM_PHOTO_INTERNAL_COLUMNS
from scripts.sync_prod_to_test_db import _table_spec, _assert_album_sync_unbound


def test_photo_json_hides_only_private_binding_columns():
    row = {"id": 1, "filename": "fixture.jpg", **{key: uuid4() for key in ALBUM_PHOTO_INTERNAL_COLUMNS}}
    before = dict(row)
    assert db_row_to_json(row, "album_photos") == {"id": 1, "filename": "fixture.jpg"}
    assert row == before
    assert db_row_to_json(row, "other_collection")["original_asset_id"] == row["original_asset_id"]


def test_client_bindings_are_not_in_generated_child_rows():
    rows = db_child_rows_for_collection("albums", [{"id": 1, "photos": [{"id": 11, "filename": "fixture", **dict.fromkeys(ALBUM_PHOTO_INTERNAL_COLUMNS, "forged")}]}])
    assert not set(rows["album_photos"][0]) & ALBUM_PHOTO_INTERNAL_COLUMNS


class Metadata:
    def __init__(self, private):
        self.private = private
        self.index = 0

    def execute(self, *args):
        self.index += 1

    def fetchall(self):
        if self.index == 1:
            return [("id", "NEVER", "integer"), ("filename", "NEVER", "text"), *self.private]
        return [("id",)] if self.index == 2 else []

    def fetchone(self):
        return (None,)


def test_sync_metadata_excludes_all_four_columns_but_marks_local_refs():
    private = [(name, "NEVER", "uuid" if name.endswith("_id") else "text") for name in ALBUM_PHOTO_INTERNAL_COLUMNS]
    spec = _table_spec(Metadata(private), "album_photos")
    assert spec.columns == ("id", "filename")
    assert spec.local_only_columns == ("original_asset_id", "thumbnail_asset_id")
    assert _table_spec(Metadata([]), "album_photos").local_only_columns == ()


@pytest.mark.parametrize("private", [[("original_asset_id", "NEVER", "uuid")], [(key, "NEVER", "text") for key in ALBUM_PHOTO_INTERNAL_COLUMNS]])
def test_partial_or_wrong_typed_schema_stops_sync(private):
    with pytest.raises(RuntimeError, match="private album photo schema"):
        _table_spec(Metadata(private), "album_photos")


def test_old_schema_adds_no_sync_queries():
    spec = _table_spec(Metadata([]), "album_photos")
    _assert_album_sync_unbound(object(), spec)
