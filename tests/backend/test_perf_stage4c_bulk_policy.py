"""Whole-album writes must stop before connection acquisition or callbacks."""
from copy import deepcopy

import pytest
from fastapi import HTTPException

from src.backend.repositories import db_json_repository as repo
from src.backend.repositories import db_row_repository as rows


def forbidden(*args, **kwargs):
    pytest.fail("Bulk refusal must precede SQL, readiness checks and callbacks")


class NoConnection:
    def __getattr__(self, name):
        forbidden(name)


@pytest.mark.parametrize("payload", [[], [{"id": 1, "photos": [{"id": 11}]}]])
@pytest.mark.parametrize("route", ["replace", "allow_bulk", "internal", "generic", "mutate", "children"])
def test_repository_rejects_before_any_database_access(monkeypatch, payload, route):
    monkeypatch.setattr(repo, "db_connection_string", forbidden)
    monkeypatch.setattr(repo.psycopg, "connect", forbidden)
    before = deepcopy(payload)
    actions = {
        "replace": lambda: repo.replace_collection("albums", payload),
        "allow_bulk": lambda: repo.replace_collection("albums", payload, allow_bulk=True),
        "internal": lambda: repo._replace_collection_in(NoConnection(), "albums", payload),
        "generic": lambda: repo.save_generic_json_collection("albums", payload),
        "mutate": lambda: repo.mutate_collection_locked("albums", forbidden),
        "children": lambda: rows.db_delete_collection_children(NoConnection(), "albums"),
    }
    with pytest.raises(HTTPException) as error:
        actions[route]()
    assert (error.value.status_code, error.value.detail) == (409, "albums requires the row-level API")
    assert payload == before


@pytest.mark.parametrize("route", ["core_save", "core_mutate", "gateway_save", "gateway_mutate", "storage", "legacy", "service", "base", "album"])
def test_compatibility_routes_cannot_use_injected_bulk_writers(backend_env, monkeypatch, route):
    from src.backend.core import compat_gateway, storage_gateway
    from src.backend.db import repository as legacy
    from src.backend.services import storage_service
    from src.backend.repositories.base_repository import BaseRepository
    from src.backend.repositories.album_repository import AlbumRepository

    monkeypatch.setattr(backend_env, "db_data_enabled", lambda: True)
    monkeypatch.setattr(backend_env, "db_expected", lambda: True)
    monkeypatch.setattr(backend_env, "local_json_fallback_enabled", lambda: False)
    for name in ("ensure_db_expected_is_ready", "db_replace_collection", "db_save_generic_json_collection", "db_mutate_collection_locked"):
        monkeypatch.setattr(backend_env, name, forbidden)
    payload = [{"id": 1}]
    actions = {
        "core_save": lambda: backend_env.save_json_data("albums", payload),
        "core_mutate": lambda: backend_env.mutate_json_data("albums", forbidden),
        "gateway_save": lambda: compat_gateway.save_json_data("albums", payload),
        "gateway_mutate": lambda: compat_gateway.mutate_json_data("albums", forbidden),
        "storage": lambda: storage_gateway.save_json_data("albums", payload),
        "legacy": lambda: legacy.save_json_data("albums", payload),
        "service": lambda: storage_service.save_json_data("albums", payload),
        "base": lambda: BaseRepository("albums").save_all(payload),
        "album": lambda: AlbumRepository().save_all(payload),
    }
    with pytest.raises(HTTPException) as error:
        actions[route]()
    assert error.value.status_code == 409
    assert payload == [{"id": 1}]


def test_explicit_local_json_save_mutate_and_row_updates_remain_available(backend_env):
    backend_env.save_json_data("albums", [{"id": 1, "event_name": "Before", "photos": [{"id": 11}]}])
    backend_env.mutate_json_data("albums", lambda items: [{**items[0], "event_name": "Mutated"}])
    saved = backend_env.row_store().update("albums", 1, lambda item: {**item, "event_name": "After"})
    assert saved["event_name"] == "After"
    assert saved["photos"][0]["id"] == 11
    assert backend_env.load_json_data("albums")[0] == saved


def test_other_collection_policy_is_not_expanded():
    from src.backend.services.collection_write_policy import reject_album_bulk_write

    for name in ("performances", "payments", "desired_pieces", "connection_settings"):
        assert reject_album_bulk_write(name) is None
