from copy import deepcopy

import pytest

from src.backend.repositories.db_item_repository import apply_server_child_fields
from src.backend.services.album_service import _thumbnail_key


@pytest.mark.parametrize("uploaded", [None, "2026-10-23T00:00:00Z"])
@pytest.mark.parametrize("changed", [False, True])
def test_album_times_and_thumbnail_identity_are_stable(uploaded, changed):
    stored = {
        "id": 1,
        "filename": "before.jpg",
        "object_name": "albums/unit.jpg",
        "created_at": "2026-10-23T00:00:00Z",
        "updated_at": "2026-10-23T00:00:01Z",
        "uploaded_at": uploaded,
    }
    current = {"id": 1, "photos": [stored]}
    update = deepcopy(current)
    update["photos"][0]["updated_at"] = "client-forged"
    update["photos"][0]["uploaded_at"] = "client-forged"
    if changed:
        update["photos"][0]["filename"] = "after.jpg"
    apply_server_child_fields("albums", update, current, "2026-10-24T00:00:00Z")
    actual = update["photos"][0]
    assert actual["uploaded_at"] == uploaded
    assert actual["created_at"] == stored["created_at"]
    assert actual["updated_at"] == ("2026-10-24T00:00:00Z" if changed else stored["updated_at"])
    assert _thumbnail_key(actual) == _thumbnail_key(stored)
