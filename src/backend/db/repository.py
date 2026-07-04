from __future__ import annotations

from ..core.storage_gateway import load_json_data, save_json_data
from ..services.extra_collection_helpers import collection_items as _collection_items


def collection_items(name: str):
	return _collection_items(name, load_json_data)

__all__ = ["collection_items", "load_json_data", "save_json_data"]
