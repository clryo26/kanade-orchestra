from __future__ import annotations

from typing import Any

from fastapi import HTTPException, UploadFile

from .extra_collection_helpers import (
    assert_extra_collection_permission,
    collection_items,
    normalize_extra_payload,
    parse_extra_upsert_request,
)
from .desired_piece_asset_service import (
    delete_reference_score_file,
    delete_reference_score_files,
    reference_score_route,
    trim_reference_score_files,
    upload_reference_score_file,
)
from .concert_record_video_service import (
    append_concert_record_sort_order,
    clean_concert_record_title,
    performance_concert_record_videos,
)
from .image_asset_service import delete_stored_image, ensure_public_image_url, is_data_image, store_data_image, store_uploaded_image
from .storage_service import load_json_data, save_json_data
from .youtube_validation_service import fetch_youtube_metadata, validate_youtube_url
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


def _desired_piece_has_votes(item: dict[str, Any]) -> bool:
    return bool([vote for vote in (item.get("votes") or []) if vote is not None])


def _desired_piece_validate_title_lock(
    current: dict[str, Any],
    payload: dict[str, Any],
    device: dict[str, Any],
) -> None:
    if not current or not _desired_piece_has_votes(current):
        return

    permission = str(device.get("permission") or "")
    if permission in {"邂｡逅・・", "繧ｷ繧ｹ繝・Β邂｡逅・・"}:
        return

    owner_member_id = str(current.get("member_id") or "")
    owner_member_name = str(current.get("registered_by") or "")
    current_member_id = str(device.get("member_id") or "")
    current_member_name = str(device.get("member_name") or "")
    is_owner = bool(
        (owner_member_id and current_member_id and owner_member_id == current_member_id)
        or (owner_member_name and current_member_name and owner_member_name == current_member_name)
    )
    if not is_owner:
        return

    if str(payload.get("title") or "").strip() != str(current.get("title") or "").strip():
        raise HTTPException(status_code=403, detail="投票済みの希望曲は曲名を編集できません")


def _desired_piece_reference_audio_url(value: Any) -> str:
    return validate_youtube_url(str(value or ""))


def _desired_piece_reference_score_file(raw_body: dict[str, Any]) -> UploadFile | None:
    file_obj = raw_body.get("reference_score_file")
    if file_obj is not None and hasattr(file_obj, "read"):
        return file_obj
    return None


def _concert_record_performance_id(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _concert_record_performance_exists(performance_id: int) -> bool:
    if performance_id <= 0:
        return False
    return any(
        _concert_record_performance_id(performance.get("id")) == performance_id
        for performance in load_json_data("performances")
    )


def _concert_record_target_sort_order(payload: dict[str, Any], current: dict[str, Any] | None) -> int | None:
    raw_sort_order = payload.get("sort_order")
    if raw_sort_order in (None, ""):
        if current is None:
            return None
        try:
            return int(current.get("sort_order") or 0) or None
        except (TypeError, ValueError):
            return None
    try:
        return int(raw_sort_order)
    except (TypeError, ValueError):
        return None


def _concert_record_group(items: list[dict[str, Any]], performance_id: int) -> list[dict[str, Any]]:
    return performance_concert_record_videos(items, performance_id)


def _concert_record_resequence_group(
    items: list[dict[str, Any]],
    performance_id: int,
    current: dict[str, Any] | None = None,
    target_sort_order: int | None = None,
) -> None:
    group = _concert_record_group(items, performance_id)
    if not group:
        return

    if current is not None and current in group:
        group.remove(current)
        if target_sort_order is None:
            target_index = len(group)
        else:
            target_index = max(0, min(len(group), target_sort_order - 1))
        group.insert(target_index, current)

    for index, item in enumerate(group, start=1):
        item["sort_order"] = index


def _concert_record_validate_payload(
    payload: dict[str, Any],
    current: dict[str, Any] | None = None,
) -> dict[str, Any]:
    performance_id = _concert_record_performance_id(payload.get("performance_id"))
    if not _concert_record_performance_exists(performance_id):
        raise HTTPException(status_code=400, detail="演奏会を選択してください")

    metadata = fetch_youtube_metadata(str(payload.get("youtube_url") or ""))
    normalized = dict(payload)
    normalized["performance_id"] = performance_id
    normalized["youtube_url"] = metadata.canonical_url
    normalized["title"] = clean_concert_record_title(metadata.title)
    normalized["thumbnail_url"] = str(metadata.thumbnail_url or "")
    if current is not None:
        normalized["sort_order"] = _concert_record_target_sort_order(normalized, current)
    return normalized


def _prepare_desired_piece_payload(
    item_id: int,
    normalized_body: dict[str, Any],
    raw_body: dict[str, Any],
    current: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], str | None]:
    payload = dict(normalized_body)
    payload["reference_audio_url"] = _desired_piece_reference_audio_url(payload.get("reference_audio_url") or "")

    score_file = _desired_piece_reference_score_file(raw_body)
    existing_score_url = str((current or {}).get("reference_score_url") or "")
    if score_file is not None:
        payload["reference_score_url"] = reference_score_route(item_id)
        stored_name = upload_reference_score_file(score_file, item_id)
        return payload, stored_name

    if existing_score_url:
        payload["reference_score_url"] = reference_score_route(item_id)
    else:
        payload["reference_score_url"] = str(payload.get("reference_score_url") or "")
    return payload, None


def _rollback_desired_piece_reference_score(item_id: int, stored_name: str | None) -> None:
    if stored_name:
        delete_reference_score_file(item_id, stored_name)


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
    desired_piece_score_stored_name: str | None = None
    if name == "concert_record_videos":
        payload = _concert_record_validate_payload(payload, None)
        payload["sort_order"] = append_concert_record_sort_order(items, payload["performance_id"])
    if name == "desired_pieces":
        payload, desired_piece_score_stored_name = _prepare_desired_piece_payload(
            int(payload.get("id") or 0),
            payload,
            raw_body,
            None,
        )
    if name == "sns_settings":
        payload["youtube_url"] = str(payload.get("youtube_url") or "")
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
        if name == "concert_record_videos":
            _concert_record_resequence_group(items, int(payload.get("performance_id") or 0), payload)
        save_json_data(name, items)
        if name == "desired_pieces" and desired_piece_score_stored_name:
            trim_reference_score_files(int(payload.get("id") or 0), desired_piece_score_stored_name)
    except Exception:
        if uploaded_image_url and uploaded_image_url != image_source:
            _delete_collection_image(name, int(payload.get("id") or 0), uploaded_image_url)
        if name == "desired_pieces":
            _rollback_desired_piece_reference_score(int(payload.get("id") or 0), desired_piece_score_stored_name)
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
    desired_piece_score_stored_name: str | None = None
    concert_record_old_performance_id = _concert_record_performance_id(current.get("performance_id")) if name == "concert_record_videos" else 0
    if name == "desired_pieces":
        _desired_piece_validate_title_lock(current, payload, device)
        payload, desired_piece_score_stored_name = _prepare_desired_piece_payload(
            item_id,
            payload,
            raw_body,
            current,
        )
    if name == "concert_record_videos":
        payload = _concert_record_validate_payload(payload, current)
        target_performance_id = int(payload.get("performance_id") or 0)
        if target_performance_id == concert_record_old_performance_id:
            target_sort_order = _concert_record_target_sort_order(payload, current)
            payload["sort_order"] = target_sort_order or int(current.get("sort_order") or 0)
        else:
            payload["sort_order"] = append_concert_record_sort_order(
                [item for item in items if int(item.get("id") or 0) != item_id],
                target_performance_id,
            )
    if name == "sns_settings":
        payload["youtube_url"] = str(payload.get("youtube_url") or current.get("youtube_url") or "")
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
        if name == "concert_record_videos":
            if concert_record_old_performance_id and concert_record_old_performance_id != int(payload.get("performance_id") or 0):
                _concert_record_resequence_group(items, concert_record_old_performance_id)
            _concert_record_resequence_group(items, int(payload.get("performance_id") or 0), payload, _concert_record_target_sort_order(payload, current))
        if name == "desired_pieces" and desired_piece_score_stored_name:
            trim_reference_score_files(item_id, desired_piece_score_stored_name)
        save_json_data(name, items)
    except Exception:
        if uploaded_image_url and uploaded_image_url != old_image_url:
            _delete_collection_image(name, item_id, uploaded_image_url)
        if name == "desired_pieces":
            _rollback_desired_piece_reference_score(item_id, desired_piece_score_stored_name)
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
    if name == "desired_pieces":
        delete_reference_score_files(item_id)
    remaining_items = [item for item in items if item.get("id") != item_id]
    if name == "concert_record_videos":
        _concert_record_resequence_group(remaining_items, _concert_record_performance_id(current.get("performance_id")))
    save_json_data(name, remaining_items)
