from __future__ import annotations

from datetime import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from ..repositories.db_item_repository import ListRowStore, PostgresRowStore

from fastapi import HTTPException

from ..utils.datetime_utils import require_input_dates
from .extra_collection_helpers import (
    EXTRA_COLLECTIONS,
    EXTRA_INPUT_DATE_FIELDS,
    assert_extra_collection_permission,
    collection_items,
    desired_piece_merged_votes,
    is_admin_device,
    normalize_extra_payload,
    parse_extra_upsert_request,
)
from .concert_record_video_service import (
    clean_concert_record_title,
    performance_concert_record_videos,
)
from . import portal_file_asset_service as file_assets
from .image_asset_service import ensure_public_image_url
from .storage_service import load_json_data
from .notification_service import data_changed, emit
from .youtube_validation_service import fetch_youtube_metadata, validate_youtube_url
from .timetable_payload_helpers import normalize_extra_for_collection
from ..utils.collection_utils import find_item
from ..utils.concurrency import ensure_expected_updated_at

T = TypeVar("T")

ATTENDANCE_STATUSES = {"present", "absent", "late", "leave_early"}
ADMIN_PERMISSIONS = {"管理者", "システム管理者"}


def _store() -> PostgresRowStore | ListRowStore:
    # Resolved per call so tests and the local JSON mode can swap the backend.
    from ..core.compat_gateway import row_store

    return row_store()


def _validate_absence_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate the attendance values shared by the member schedule UI and API."""
    normalized = dict(payload)
    status = str(normalized.get("status") or "").strip()
    if status not in ATTENDANCE_STATUSES:
        raise HTTPException(status_code=422, detail="Invalid attendance status")

    if not str(normalized.get("schedule_id") or "").strip():
        raise HTTPException(status_code=422, detail="schedule_id is required")
    if not (
        str(normalized.get("member_id") or "").strip()
        or str(normalized.get("name") or "").strip()
    ):
        raise HTTPException(status_code=422, detail="member_id or name is required")

    planned_time = str(normalized.get("planned_time") or "").strip()
    if status in {"late", "leave_early"} and not planned_time:
        raise HTTPException(status_code=422, detail="planned_time is required for late or leave_early")
    if planned_time and status in {"late", "leave_early"}:
        try:
            time.fromisoformat(planned_time)
        except ValueError as error:
            raise HTTPException(status_code=422, detail="planned_time must be a valid time") from error
    # A time on present/absent would be misleading, so normalize it away.
    normalized["planned_time"] = planned_time if status in {"late", "leave_early"} else ""
    normalized["status"] = status
    return normalized


def _matching_absence_index(items: list[dict[str, Any]], payload: dict[str, Any]) -> int | None:
    """Return an existing response for the same member and practice, if any."""
    schedule_id = str(payload.get("schedule_id") or "")
    member_id = str(payload.get("member_id") or "")
    name = str(payload.get("name") or "")
    schedule_items = [
        (index, item)
        for index, item in enumerate(items)
        if str(item.get("schedule_id") or "") == schedule_id
    ]
    for index, item in schedule_items:
        if member_id and str(item.get("member_id") or "") == member_id:
            return index

    # Never use a display name to overwrite a response already owned by another
    # member ID. Legacy name-only records are updated only when they are the one
    # unambiguous candidate for the authenticated member's ID.
    if not member_id or not name:
        return None
    matching_named_items = [
        (index, item)
        for index, item in schedule_items
        if str(item.get("name") or "") == name
    ]
    legacy_matches = [
        (index, item)
        for index, item in matching_named_items
        if not str(item.get("member_id") or "")
    ]
    has_other_member_with_name = any(
        str(item.get("member_id") or "")
        and str(item.get("member_id") or "") != member_id
        for _, item in matching_named_items
    )
    if len(legacy_matches) == 1 and not has_other_member_with_name:
        return legacy_matches[0][0]
    return None


def _absence_lock_key(payload: dict[str, Any]) -> str:
    # One writer per member/practice so the idempotent POST cannot create
    # duplicates when two requests race (row-level replacement of the old
    # whole-list check).
    return f"absence:{payload.get('schedule_id') or ''}:{payload.get('member_id') or payload.get('name') or ''}"


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
    if permission in {"邂｡逅・・", "繧ｷ繧ｹ繝・Β邂｡逅・・"}:
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
    raw_sort_order: Any = payload.get("sort_order")
    if raw_sort_order in (None, ""):
        if current is None:
            return None
        current_sort_order: Any = current.get("sort_order")
        if current_sort_order in (None, ""):
            return None
        try:
            return int(current_sort_order) or None
        except (TypeError, ValueError):
            return None
    try:
        return int(raw_sort_order)
    except (TypeError, ValueError):
        return None


def _concert_record_resequence_group(
    items: list[dict[str, Any]],
    performance_id: int,
    current: dict[str, Any] | None = None,
    target_sort_order: int | None = None,
) -> None:
    group = performance_concert_record_videos(items, performance_id)
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


def _concert_record_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    """Network I/O (YouTube) happens before any DB lock is taken."""
    performance_id = _concert_record_performance_id(payload.get("performance_id"))
    if not _concert_record_performance_exists(performance_id):
        raise HTTPException(status_code=400, detail="演奏会を選択してください")
    metadata = fetch_youtube_metadata(str(payload.get("youtube_url") or ""))
    return {
        "performance_id": performance_id,
        "youtube_url": metadata.canonical_url,
        "title": clean_concert_record_title(metadata.title),
        "thumbnail_url": str(metadata.thumbnail_url or ""),
    }


def _concert_group_orders(
    rows: list[dict[str, Any]],
    item: dict[str, Any] | None,
    *,
    old_performance_id: int,
    new_performance_id: int,
    target_sort_order: int | None,
    remove_item: bool = False,
) -> dict[int, dict[str, Any]]:
    """Final ``sort_order`` (and ``performance_id``) per row, using the existing rules."""
    copies = [dict(row) for row in rows if not (item is not None and row.get("id") == item.get("id"))]
    moved = None
    if item is not None and not remove_item:
        moved = dict(item)
        if old_performance_id != new_performance_id:
            # Same rule as before: a moved video is appended to the new group.
            moved["performance_id"] = new_performance_id
            moved["sort_order"] = max(
                (int(row.get("sort_order") or 0) for row in copies if _concert_record_performance_id(row.get("performance_id")) == new_performance_id),
                default=0,
            ) + 1
        copies.append(moved)
    if old_performance_id and old_performance_id != new_performance_id:
        _concert_record_resequence_group(copies, old_performance_id)
    if new_performance_id:
        _concert_record_resequence_group(copies, new_performance_id, moved, target_sort_order)
    original = {row.get("id"): row for row in rows}
    result: dict[int, dict[str, Any]] = {}
    for row in copies:
        row_id = row.get("id")
        before = original.get(row_id) or {}
        values = {"sort_order": int(row.get("sort_order") or 0)}
        if moved is not None and row is moved:
            values["performance_id"] = new_performance_id
        if row_id is not None and any(before.get(key) != value for key, value in values.items()):
            result[int(row_id)] = values
    return result


def _image_field_name(name: str) -> str:
    if name == "org_settings":
        return "icon_url"
    return ""


def _public_org_setting_item(item: dict[str, Any]) -> dict[str, Any]:
    payload = dict(item)
    setting_id = int(payload.get("id") or 0)
    if setting_id:
        payload["icon_url"] = ensure_public_image_url(
            payload.get("icon_url") or "",
            route_path=f"/api/extra/org_settings/{setting_id}/icon",
        )
    return payload


def _public_promotion_item(item: dict[str, Any]) -> dict[str, Any]:
    payload = dict(item)
    promotion_id = int(payload.get("id") or 0)
    if promotion_id:
        payload["image_url"] = ensure_public_image_url(
            payload.get("image_url") or "",
            route_path=f"/api/extra/promotions/{promotion_id}/image",
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


def _guard_dedicated_apis(name: str) -> None:
    if name == "promotions":
        raise HTTPException(status_code=409, detail="Use the promotion API with an operation key")
    if name == "sheet_library":
        # The generic collection API would save the whole list; sheets have
        # their own row-level, idempotent API (/api/sheets).
        raise HTTPException(status_code=409, detail="Use the sheet API with an operation key")
    if name not in EXTRA_COLLECTIONS:
        raise HTTPException(status_code=404, detail="Collection not found")


def _public(name: str, item: dict[str, Any]) -> dict[str, Any]:
    if name == "org_settings":
        return _public_org_setting_item(item)
    return item


def _owner_fields(name: str, body: dict[str, Any], device: dict[str, Any], current: dict[str, Any] | None) -> None:
    if name not in {"desired_pieces", "promotions"} or is_admin_device(device):
        return
    if current is None:
        body["member_id"] = device.get("member_id") or ""
        body["registered_by"] = device.get("member_name") or ""
    else:
        body["member_id"] = current.get("member_id") or device.get("member_id") or ""
        body["registered_by"] = current.get("registered_by") or device.get("member_name") or ""


def build_create_payload(name: str, upsert_payload: dict[str, Any], device: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Validation that needs no current row (and the network-bound metadata)."""
    normalized_body = normalize_extra_for_collection(name, upsert_payload)
    require_input_dates(normalized_body, EXTRA_INPUT_DATE_FIELDS.get(name, ()))
    if name == "absences":
        normalized_body = _validate_absence_payload(normalized_body)
    assert_extra_collection_permission(name, device, payload=normalized_body)
    _owner_fields(name, normalized_body, device, None)
    metadata = _concert_record_metadata(normalized_body) if name == "concert_record_videos" else None
    if name == "desired_pieces":
        normalized_body["reference_audio_url"] = validate_youtube_url(str(normalized_body.get("reference_audio_url") or ""))
    if name == "sns_settings":
        normalized_body["youtube_url"] = str(normalized_body.get("youtube_url") or "")
    return normalized_body, metadata


def create_row(name: str, normalized_body: dict[str, Any], metadata: dict[str, Any] | None, *, ctx: Any = None, extra: dict[str, Any] | Callable[[int], dict[str, Any]] | None = None) -> dict[str, Any]:
    """Insert one item (with its group rules) in a row-level transaction."""
    store = _store()

    def build(new_id: int) -> dict[str, Any]:
        payload = normalize_extra_payload(normalized_body, item_id=new_id)
        if metadata is not None:
            payload.update(metadata)
        # File references are server managed: set only by a confirmed asset.
        if name == "desired_pieces":
            payload["reference_score_url"] = ""
        image_field = _image_field_name(name)
        if image_field:
            payload[image_field] = ""
        if extra:
            payload.update(extra(new_id) if callable(extra) else extra)
        return payload

    if name == "concert_record_videos":
        performance_id = int((metadata or {}).get("performance_id") or 0)

        def work(c: Any) -> dict[str, Any]:
            store.lock(c, name, [f"group:performance:{performance_id}"])
            rows = performance_concert_record_videos(store.list(name, ctx=c), performance_id)
            orders = _concert_group_orders(rows, None, old_performance_id=0, new_performance_id=performance_id, target_sort_order=None)
            if orders:
                store.update_many(name, orders, ctx=c, unique_two_phase="sort_order")
            created_build = build

            def with_order(new_id: int) -> dict[str, Any]:
                payload = created_build(new_id)
                payload["sort_order"] = len(rows) + 1
                return payload

            return store.insert(name, with_order, ctx=c)

        return _in_transaction(store, ctx, work)
    return store.insert(name, build, ctx=ctx)


def _in_transaction(store: Any, ctx: Any, work: Callable[[Any], T]) -> T:
    if ctx is not None:
        return work(ctx)
    with store.transaction() as own:
        return work(own)


def build_update_mutate(
    name: str,
    item_id: int,
    upsert_payload: dict[str, Any],
    device: dict[str, Any],
    metadata: dict[str, Any] | None,
    *,
    extra: Any = None,
) -> Callable[[dict[str, Any]], dict[str, Any]]:
    """Return a pure mutate(current) for the row-level update (no I/O inside)."""
    normalized_body = normalize_extra_for_collection(name, upsert_payload)
    require_input_dates(normalized_body, EXTRA_INPUT_DATE_FIELDS.get(name, ()))
    if name == "absences":
        normalized_body = _validate_absence_payload(normalized_body)
    if name == "desired_pieces":
        normalized_body["reference_audio_url"] = validate_youtube_url(str(normalized_body.get("reference_audio_url") or ""))

    def mutate(current: dict[str, Any]) -> dict[str, Any]:
        body = dict(normalized_body)
        if name == "desired_pieces" and not is_admin_device(device) and not _is_desired_piece_owner(current, device):
            # Vote-only update by another member: apply the actor's vote to the
            # *current* votes so concurrent votes of others are kept (spec 1.6).
            merged = desired_piece_merged_votes(body, current, device)
            if merged is None:
                raise HTTPException(status_code=403, detail="Only owner can modify desired piece details")
            return {**current, "votes": merged}
        assert_extra_collection_permission(name, device, payload=body, current=current)
        _owner_fields(name, body, device, current)
        payload = normalize_extra_payload(body, item_id=item_id, current=current)
        if name == "desired_pieces":
            _desired_piece_validate_title_lock(current, payload, device)
            payload["votes"] = desired_piece_merged_votes(payload, current, device, owner=True) or []
            # The reference changes only through the file-operation protocol.
            payload["reference_score_url"] = str(current.get("reference_score_url") or "")
        if metadata is not None:
            payload.update(metadata)
        if name == "sns_settings":
            payload["youtube_url"] = str(payload.get("youtube_url") or current.get("youtube_url") or "")
        image_field = _image_field_name(name)
        if image_field:
            # The icon reference changes only through the file-operation API.
            payload[image_field] = current.get(image_field) or ""
        if extra is not None:
            payload.update(extra(current, payload) if callable(extra) else extra)
        return payload

    return mutate


def _is_desired_piece_owner(current: dict[str, Any], device: dict[str, Any]) -> bool:
    member_id = str(device.get("member_id") or "")
    member_name = str(device.get("member_name") or "")
    owner_id = str(current.get("member_id") or "")
    owner_name = str(current.get("registered_by") or "")
    return bool((member_id and owner_id and member_id == owner_id) or (member_name and owner_name and member_name == owner_name))


def update_row(
    name: str,
    item_id: int,
    mutate: Any,
    *,
    expected_updated_at: str | None,
    metadata: dict[str, Any] | None,
    target_sort_order: int | None = None,
    ctx: Any = None,
) -> dict[str, Any]:
    store = _store()
    if name != "concert_record_videos":
        return store.update(name, item_id, mutate, expected_updated_at=expected_updated_at, ctx=ctx)

    def work(c: Any) -> dict[str, Any]:
        peek = store.get(name, item_id, ctx=c)
        if peek is None:
            raise HTTPException(status_code=404, detail="Data not found")
        old_performance_id = _concert_record_performance_id(peek.get("performance_id"))
        new_performance_id = int((metadata or {}).get("performance_id") or old_performance_id)
        store.lock(c, name, sorted({f"group:performance:{old_performance_id}", f"group:performance:{new_performance_id}"}))
        current = store.get(name, item_id, ctx=c, lock=True)
        if current is None:
            raise HTTPException(status_code=404, detail="Data not found")
        if _concert_record_performance_id(current.get("performance_id")) != old_performance_id:
            raise HTTPException(status_code=409, detail="Data has been updated by another user")
        # Version check before the re-sequencing touches this row.
        ensure_expected_updated_at(current, expected_updated_at)
        candidate = mutate(dict(current))
        rows = [
            row
            for row in store.list(name, ctx=c)
            if _concert_record_performance_id(row.get("performance_id")) in {old_performance_id, new_performance_id}
        ]
        if new_performance_id == old_performance_id:
            target = target_sort_order or int(current.get("sort_order") or 0) or None
        else:
            target = None
        orders = _concert_group_orders(
            rows,
            current,
            old_performance_id=old_performance_id,
            new_performance_id=new_performance_id,
            target_sort_order=target,
        )
        if orders:
            store.update_many(name, orders, ctx=c, unique_two_phase="sort_order")
        final = orders.get(int(current["id"]), {"sort_order": int(current.get("sort_order") or 0)})
        return store.update(
            name,
            item_id,
            lambda latest: {**candidate, "performance_id": new_performance_id, "sort_order": final["sort_order"]},
            ctx=c,
        )

    return _in_transaction(store, ctx, work)


async def create_item(name: str, raw_body: dict[str, Any], device: dict[str, Any], *, idempotency_key: str | None = None) -> Any:
    _guard_dedicated_apis(name)
    upsert = parse_extra_upsert_request(raw_body)
    if _is_file_operation(name, "POST", raw_body, idempotency_key):
        return await _run_file_operation(name, "POST", None, raw_body, device, idempotency_key)
    normalized_body, metadata = build_create_payload(name, upsert.payload, device)
    store = _store()
    if name == "absences":
        def work(c: Any) -> dict[str, Any]:
            store.lock(c, name, [_absence_lock_key(normalized_body)])
            items = store.list(name, ctx=c)
            existing_index = _matching_absence_index(items, normalized_body)
            if existing_index is not None and int(items[existing_index].get("id") or 0):
                # The generic extra endpoint predates attendance. Keep its URL
                # while making POST idempotent per member/practice.
                mutate = build_update_mutate(name, int(items[existing_index]["id"]), upsert.payload, device, None)
                return store.update(name, int(items[existing_index]["id"]), mutate, expected_updated_at=upsert.expected_updated_at, ctx=c)
            return store.insert(name, lambda new_id: normalize_extra_payload(normalized_body, item_id=new_id), ctx=c)

        saved = _in_transaction(store, None, work)
    else:
        saved = create_row(name, normalized_body, metadata)
    # Notifications only after the row-level transaction committed.
    if name in {"piece_infos", "practice_instructions"}:
        emit(name, saved)
    return _public(name, saved)


async def update_item(name: str, item_id: int, raw_body: dict[str, Any], device: dict[str, Any], *, idempotency_key: str | None = None) -> Any:
    _guard_dedicated_apis(name)
    upsert = parse_extra_upsert_request(raw_body)
    if _is_file_operation(name, "PUT", raw_body, idempotency_key, item_id=item_id):
        return await _run_file_operation(name, "PUT", item_id, raw_body, device, idempotency_key)
    metadata = _concert_record_metadata(normalize_extra_for_collection(name, upsert.payload)) if name == "concert_record_videos" else None
    mutate = build_update_mutate(name, item_id, upsert.payload, device, metadata)
    before: dict[str, Any] = {}

    def capturing(current: dict[str, Any]) -> dict[str, Any]:
        before.clear()
        before.update(current)
        return mutate(current)

    saved = update_row(
        name,
        item_id,
        capturing,
        expected_updated_at=upsert.expected_updated_at,
        metadata=metadata,
        target_sort_order=_concert_record_target_sort_order(upsert.payload, None) if name == "concert_record_videos" else None,
    )
    if name in {"piece_infos", "practice_instructions"} and data_changed(before, saved, name):
        emit(name, saved, "updated")
    return _public(name, saved)


async def delete_item(name: str, item_id: int, device: dict[str, Any], *, idempotency_key: str | None = None) -> Any:
    _guard_dedicated_apis(name)
    store = _store()
    if _is_file_operation(name, "DELETE", {}, idempotency_key, item_id=item_id):
        return await _run_file_delete(name, item_id, device, idempotency_key)

    def authorize(current: dict[str, Any]) -> None:
        assert_extra_collection_permission(name, device, current=current)

    if name != "concert_record_videos":
        store.delete(name, item_id, authorize)
        return None

    def work(c: Any) -> None:
        peek = store.get(name, item_id, ctx=c)
        if peek is None:
            raise HTTPException(status_code=404, detail="Data not found")
        performance_id = _concert_record_performance_id(peek.get("performance_id"))
        store.lock(c, name, [f"group:performance:{performance_id}"])
        deleted = store.delete(name, item_id, authorize, ctx=c)
        rows = performance_concert_record_videos(store.list(name, ctx=c), performance_id)
        orders = _concert_group_orders(rows, deleted, old_performance_id=performance_id, new_performance_id=performance_id, target_sort_order=None, remove_item=True)
        if orders:
            store.update_many(name, orders, ctx=c, unique_two_phase="sort_order")

    _in_transaction(store, None, work)
    return None


# --------------------------------------------------------------------------- file operations
# Desired-piece reference score and organization icon (JST spec R05-A/B, R06).


FILE_ACTION_FIELDS = {
    "desired_pieces": ("reference_score_file", "reference_score_action", None),
    "org_settings": ("icon_url_file", "icon_action", "icon_url"),
}


def _file_inputs(name: str, raw_body: dict[str, Any]) -> tuple[Any, str]:
    file_field, action_field, data_field = FILE_ACTION_FIELDS[name]
    upload = raw_body.get(file_field)
    action = str(raw_body.get(action_field) or "").strip().lower()
    if file_assets.has_upload(upload):
        return upload, "replace"
    if data_field:
        payload = parse_extra_upsert_request(raw_body).payload
        if file_assets.is_data_image(payload.get(data_field)):
            return payload.get(data_field), "replace"
    if action == "remove":
        return None, "remove"
    return None, "keep"


def _is_file_operation(name: str, method: str, raw_body: dict[str, Any], key: Any, *, item_id: Any = None) -> bool:
    """Requests that change a file (or delete a row owning one) use the operation protocol."""
    if name not in FILE_ACTION_FIELDS:
        return False
    if key not in (None, ""):
        return True
    if method == "DELETE":
        return file_assets.has_active_asset(file_assets.KIND_BY_COLLECTION[name], item_id)
    _, action = _file_inputs(name, raw_body)
    return action != "keep"


async def _read_file(name: str, source: Any) -> Any:
    if source is None:
        return None
    if name == "desired_pieces":
        return await file_assets.read_pdf(source)
    if isinstance(source, str):
        return file_assets.read_data_image(source)
    return await file_assets.read_image_upload(source)


def _fingerprint(payload: dict[str, Any], expected_updated_at: str) -> dict[str, Any]:
    from ..utils.datetime_utils import InvalidDateTimeValue, normalize_instant_text

    data = {
        key: value
        for key, value in payload.items()
        if key not in {"id", "created_at", "updated_at", "organization_id"} and not file_assets.has_upload(value)
    }
    expected = str(expected_updated_at or "").strip()
    try:
        # The same instant in any notation is the same request (R05-A).
        expected = normalize_instant_text(expected) if expected else ""
    except InvalidDateTimeValue:
        pass
    return {"payload": data, "expected_updated_at": expected}


def _require_target(tx: Any, name: str, item_id: int, device: dict[str, Any], expected_updated_at: str | None) -> dict[str, Any]:
    current = _store().get(name, item_id, ctx=tx.ctx, lock=True)
    if current is None:
        raise HTTPException(status_code=404, detail="Data not found")
    if name == "desired_pieces" and not is_admin_device(device) and not _is_desired_piece_owner(current, device):
        raise HTTPException(status_code=403, detail="Only owner can modify desired piece details")
    assert_extra_collection_permission(name, device, current=current)
    ensure_expected_updated_at(current, expected_updated_at)
    return current


async def _run_file_operation(name: str, method: str, item_id: int | None, raw_body: dict[str, Any], device: dict[str, Any], key: Any) -> Any:
    kind = file_assets.KIND_BY_COLLECTION[name]
    url_field = file_assets.KINDS[kind].url_field
    upsert = parse_extra_upsert_request(raw_body)
    source, action = _file_inputs(name, raw_body)
    file = await _read_file(name, source)
    if method == "POST":
        normalized_body, metadata = build_create_payload(name, upsert.payload, device)
    else:
        payload_for_update = dict(upsert.payload)
        if url_field in payload_for_update and file_assets.is_data_image(payload_for_update.get(url_field)):
            payload_for_update.pop(url_field)
        mutate = build_update_mutate(name, int(item_id or 0), payload_for_update, device, None)

    def validate(tx: Any) -> None:
        if method != "POST":
            _require_target(tx, name, int(item_id or 0), device, upsert.expected_updated_at)

    def apply(tx: Any, applied: Any) -> tuple[int, dict[str, Any]]:
        if method == "POST":
            def extra(new_id: int) -> dict[str, Any]:
                return {url_field: applied.url_for(new_id)}

            saved = create_row(name, normalized_body, metadata, ctx=tx.ctx, extra=extra)
            applied.commit_reference(tx, int(saved["id"]))
            return 200, _public(name, saved)
        # Re-checked in the commit transaction (R05-B step 5).
        _require_target(tx, name, int(item_id or 0), device, upsert.expected_updated_at)
        new_url = applied.url_for(int(item_id or 0)) if action == "replace" else ""

        def with_reference(current: dict[str, Any]) -> dict[str, Any]:
            updated = mutate(current)
            updated[url_field] = new_url if action != "keep" else current.get(url_field) or ""
            return updated

        saved = _store().update(name, int(item_id or 0), with_reference, ctx=tx.ctx)
        if action == "replace":
            applied.commit_reference(tx, int(item_id or 0))
        elif action == "remove":
            applied.retire_reference(tx, int(item_id or 0))
        return 200, _public(name, saved)

    status, body = await file_assets.run(
        file_assets.FileOperation(
            kind=kind,
            method=method,
            target_id=item_id,
            action=action,
            file=file,
            fingerprint=_fingerprint(upsert.payload, upsert.expected_updated_at),
            validate=validate,
            apply=apply,
            view_scope="admin" if name == "org_settings" else "owner",
        ),
        device,
        key,
    )
    return file_assets.http_result(status, body)


async def _run_file_delete(name: str, item_id: int, device: dict[str, Any], key: Any) -> Any:
    kind = file_assets.KIND_BY_COLLECTION[name]

    def validate(tx: Any) -> None:
        _require_target(tx, name, item_id, device, None)

    def apply(tx: Any, applied: Any) -> tuple[int, dict[str, Any]]:
        _store().delete(name, item_id, lambda current: assert_extra_collection_permission(name, device, current=current), ctx=tx.ctx)
        applied.retire_reference(tx, item_id)
        return 200, {"message": "Deleted"}

    status, body = await file_assets.run(
        file_assets.FileOperation(
            kind=kind, method="DELETE", target_id=item_id, action="delete", file=None,
            fingerprint={}, validate=validate, apply=apply,
            view_scope="admin" if name == "org_settings" else "owner",
        ),
        device,
        key,
    )
    return file_assets.http_result(status, body)
