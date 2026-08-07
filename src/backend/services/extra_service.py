from __future__ import annotations

from typing import Any

from fastapi import UploadFile

from .extra_collection_helpers import (
    assert_extra_collection_permission,
    collection_items,
    normalize_extra_payload,
    parse_extra_upsert_request,
)
from .image_asset_service import delete_stored_image, ensure_public_image_url, is_data_image, store_data_image, store_uploaded_image
from .storage_service import load_json_data, save_json_data
from .timetable_payload_helpers import normalize_extra_for_collection
from ..utils.concurrency import ensure_expected_updated_at
from ..utils.collection_utils import find_item, next_id
from ..utils.datetime_utils import next_updated_at


def _promotion_route(promotion_id: int) -> str:
    return f"/api/extra/promotions/{promotion_id}/image"


def _promotion_object_prefix(promotion_id: int) -> str:
    return f"promotion-images/{promotion_id}/image"


def _org_setting_route(setting_id: int) -> str:
    return f"/api/extra/org_settings/{setting_id}/icon"


def _org_setting_object_prefix(setting_id: int) -> str:
    return f"org-settings/{setting_id}/icon"


def _image_field_name(name: str) -> str:
    if name == "promotions":
        return "image_url"
    if name == "org_settings":
        return "icon_url"
    return ""


def _image_route(name: str, item_id: int) -> str:
    if name == "promotions":
        return _promotion_route(item_id)
    if name == "org_settings":
        return _org_setting_route(item_id)
    return ""


def _image_object_prefix(name: str, item_id: int) -> str:
    if name == "promotions":
        return _promotion_object_prefix(item_id)
    if name == "org_settings":
        return _org_setting_object_prefix(item_id)
    return ""


async def _persist_collection_image(
    name: str,
    item_id: int,
    image_url: str,
    image_file: UploadFile | None = None,
) -> str:
    field_name = _image_field_name(name)
    if not field_name:
        return str(image_url or "")
    if image_file is not None:
        return await store_uploaded_image(
            image_file,
            object_prefix=_image_object_prefix(name, item_id),
            route_path=_image_route(name, item_id),
        )
    return store_data_image(
        image_url,
        object_prefix=_image_object_prefix(name, item_id),
        route_path=_image_route(name, item_id),
    )


def _delete_promotion_image(promotion_id: int, image_url: str) -> None:
    delete_stored_image(image_url, object_prefix=_promotion_object_prefix(promotion_id))


def _delete_collection_image(name: str, item_id: int, image_url: str) -> None:
    field_name = _image_field_name(name)
    if not field_name:
        return
    delete_stored_image(image_url, object_prefix=_image_object_prefix(name, item_id))


def _public_promotion_item(item: dict[str, Any]) -> dict[str, Any]:
    payload = dict(item)
    promotion_id = int(payload.get("id") or 0)
    if promotion_id:
        payload["image_url"] = ensure_public_image_url(
            payload.get("image_url") or "",
            route_path=_promotion_route(promotion_id),
        )
    return payload


def _public_org_setting_item(item: dict[str, Any]) -> dict[str, Any]:
    payload = dict(item)
    setting_id = int(payload.get("id") or 0)
    if setting_id:
        payload["icon_url"] = ensure_public_image_url(
            payload.get("icon_url") or "",
            route_path=_org_setting_route(setting_id),
        )
    return payload


def list_items(name: str) -> list[dict[str, Any]]:
    items = collection_items(name, load_json_data)
    if name == "promotions":
        return [_public_promotion_item(item) for item in items]
    if name == "org_settings":
        return [_public_org_setting_item(item) for item in items]
    return items


def get_item_raw(name: str, item_id: int) -> dict[str, Any]:
    items = collection_items(name, load_json_data)
    _, item = find_item(items, item_id)
    return item


async def create_item(name: str, raw_body: dict[str, Any], device: dict[str, Any]) -> dict[str, Any]:
    items = collection_items(name, load_json_data)
    upsert = parse_extra_upsert_request(raw_body)
    normalized_body = normalize_extra_for_collection(name, upsert.payload)
    assert_extra_collection_permission(name, device, payload=normalized_body)
    if (
        name in {"desired_pieces", "promotions"}
        and str(device.get("permission") or "") not in {"管理者", "システム管理者"}
    ):
        normalized_body["member_id"] = device.get("member_id") or ""
        normalized_body["registered_by"] = device.get("member_name") or ""
    payload = normalize_extra_payload(
        normalized_body,
        next_updated_at_func=next_updated_at,
        item_id=next_id(items),
    )
    image_field = _image_field_name(name)
    image_source = str(payload.get(image_field) or "") if image_field else ""
    uploaded_image_url = ""
    if image_field and (is_data_image(image_source) or str(raw_body.get(image_field) or "") or raw_body.get(f"{image_field}_file")):
        payload[image_field] = ""
    items.append(payload)
    try:
        if image_field:
            image_file = raw_body.get(f"{image_field}_file")
            uploaded_image_url = await _persist_collection_image(
                name,
                int(payload.get("id") or 0),
                image_source,
                image_file if image_file and hasattr(image_file, "read") else None,
            )
            payload[image_field] = uploaded_image_url
        save_json_data(name, items)
    except Exception:
        if uploaded_image_url and uploaded_image_url != image_source:
            _delete_collection_image(name, int(payload.get("id") or 0), uploaded_image_url)
        raise
    if name == "promotions":
        return _public_promotion_item(payload)
    if name == "org_settings":
        return _public_org_setting_item(payload)
    return payload


async def update_item(name: str, item_id: int, raw_body: dict[str, Any], device: dict[str, Any]) -> dict[str, Any]:
    items = collection_items(name, load_json_data)
    index, current = find_item(items, item_id)
    upsert = parse_extra_upsert_request(raw_body)
    ensure_expected_updated_at(current, upsert.expected_updated_at)
    normalized_body = normalize_extra_for_collection(name, upsert.payload)
    assert_extra_collection_permission(name, device, payload=normalized_body, current=current)
    if (
        name in {"desired_pieces", "promotions"}
        and str(device.get("permission") or "") not in {"管理者", "システム管理者"}
    ):
        normalized_body["member_id"] = current.get("member_id") or device.get("member_id") or ""
        normalized_body["registered_by"] = current.get("registered_by") or device.get("member_name") or ""
    payload = normalize_extra_payload(
        normalized_body,
        next_updated_at_func=next_updated_at,
        item_id=item_id,
        current=current,
    )
    image_field = _image_field_name(name)
    image_source = str(payload.get(image_field) or "") if image_field else ""
    old_image_url = str(current.get(image_field) or "") if image_field else ""
    uploaded_image_url = ""
    if image_field and (is_data_image(image_source) or raw_body.get(image_field) or raw_body.get(f"{image_field}_file")):
        payload[image_field] = ""
    items[index] = payload
    try:
        if image_field:
            image_file = raw_body.get(f"{image_field}_file")
            uploaded_image_url = await _persist_collection_image(
                name,
                item_id,
                image_source,
                image_file if image_file and hasattr(image_file, "read") else None,
            )
            payload[image_field] = uploaded_image_url
            items[index] = payload
        save_json_data(name, items)
    except Exception:
        if uploaded_image_url and uploaded_image_url != old_image_url:
            _delete_collection_image(name, item_id, uploaded_image_url)
        raise
    if image_field and old_image_url and old_image_url != str(payload.get(image_field) or ""):
        _delete_collection_image(name, item_id, old_image_url)
    if name == "promotions":
        return _public_promotion_item(payload)
    if name == "org_settings":
        return _public_org_setting_item(payload)
    return payload


def delete_item(name: str, item_id: int, device: dict[str, Any]) -> None:
    items = collection_items(name, load_json_data)
    _, current = find_item(items, item_id)
    assert_extra_collection_permission(name, device, current=current)
    if name in {"promotions", "org_settings"}:
        _delete_collection_image(name, item_id, str(current.get(_image_field_name(name)) or ""))
    save_json_data(name, [item for item in items if item.get("id") != item_id])
