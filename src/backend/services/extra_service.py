from __future__ import annotations

from typing import Any

from .extra_collection_helpers import (
    assert_extra_collection_permission,
    collection_items,
    normalize_extra_payload,
    parse_extra_upsert_request,
)
from .storage_service import load_json_data, save_json_data
from .timetable_payload_helpers import normalize_extra_for_collection
from ..utils.concurrency import ensure_expected_updated_at
from ..utils.collection_utils import find_item, next_id
from ..utils.datetime_utils import next_updated_at


def list_items(name: str) -> list[dict[str, Any]]:
    return collection_items(name, load_json_data)


def create_item(name: str, raw_body: dict[str, Any], device: dict[str, Any]) -> dict[str, Any]:
    items = collection_items(name, load_json_data)
    upsert = parse_extra_upsert_request(raw_body)
    normalized_body = normalize_extra_for_collection(name, upsert.payload)
    assert_extra_collection_permission(name, device, payload=normalized_body)
    payload = normalize_extra_payload(normalized_body, next_updated_at_func=next_updated_at, item_id=next_id(items))
    items.append(payload)
    save_json_data(name, items)
    return payload


def update_item(name: str, item_id: int, raw_body: dict[str, Any], device: dict[str, Any]) -> dict[str, Any]:
    items = collection_items(name, load_json_data)
    index, current = find_item(items, item_id)
    upsert = parse_extra_upsert_request(raw_body)
    ensure_expected_updated_at(current, upsert.expected_updated_at)
    normalized_body = normalize_extra_for_collection(name, upsert.payload)
    assert_extra_collection_permission(name, device, payload=normalized_body, current=current)
    payload = normalize_extra_payload(normalized_body, next_updated_at_func=next_updated_at, item_id=item_id, current=current)
    items[index] = payload
    save_json_data(name, items)
    return payload


def delete_item(name: str, item_id: int, device: dict[str, Any]) -> None:
    items = collection_items(name, load_json_data)
    _, current = find_item(items, item_id)
    assert_extra_collection_permission(name, device, current=current)
    save_json_data(name, [item for item in items if item.get("id") != item_id])
