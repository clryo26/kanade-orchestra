from __future__ import annotations

from typing import Any

from fastapi import UploadFile

from ..repositories.member_repository import MemberRepository
from .auth_service import (
    prepare_member_payload,
    public_member_list,
    public_member_payload,
    public_member_public_profile_payload,
)
from .image_asset_service import delete_stored_image, is_data_image, store_data_image, store_uploaded_image

_repo = MemberRepository()


def _member_photo_route(member_id: int) -> str:
    return f"/api/members/{member_id}/photo"


def _member_photo_object_prefix(member_id: int) -> str:
    return f"member-images/{member_id}/photo"


async def _persist_member_photo(member_id: int, photo_url: str, photo_file: UploadFile | None = None) -> str:
    if photo_file is not None:
        return await store_uploaded_image(
            photo_file,
            object_prefix=_member_photo_object_prefix(member_id),
            route_path=_member_photo_route(member_id),
        )
    return store_data_image(
        photo_url,
        object_prefix=_member_photo_object_prefix(member_id),
        route_path=_member_photo_route(member_id),
    )


def _delete_member_photo(member_id: int, photo_url: str) -> None:
    delete_stored_image(photo_url, object_prefix=_member_photo_object_prefix(member_id))


def list_members() -> list[dict[str, Any]]:
    return public_member_list(_repo.list_all())


def _can_view_private_member_detail(viewer_device: dict[str, Any] | None, member: dict[str, Any]) -> bool:
    if not viewer_device:
        return False
    viewer_member_id = str(viewer_device.get("member_id") or "")
    if viewer_member_id and viewer_member_id == str(member.get("id") or ""):
        return True
    permission = str(viewer_device.get("permission") or "").strip()
    return permission in {"管理者", "システム管理者", "admin", "system admin", "sysadmin", "system_admin"}


def get_member(member_id: int, viewer_device: dict[str, Any] | None = None) -> dict[str, Any]:
    _, member = _repo.find_by_id(member_id)
    if _can_view_private_member_detail(viewer_device, member):
        return public_member_payload(member)
    return public_member_public_profile_payload(member)


def get_member_record(member_id: int) -> dict[str, Any]:
    _, member = _repo.find_by_id(member_id)
    return member


async def create_member(member_payload: dict[str, Any], photo_file: UploadFile | None = None) -> dict[str, Any]:
    prepared = prepare_member_payload(member_payload)
    photo_source = str(prepared.get("photo_url") or "")
    if photo_file is not None or is_data_image(photo_source):
        prepared["photo_url"] = ""
    created = _repo.create(prepared)
    member_id = int(created.get("id") or 0)
    try:
        uploaded_photo_url = await _persist_member_photo(
            member_id,
            photo_source,
            photo_file,
        )
        created["photo_url"] = uploaded_photo_url
        if uploaded_photo_url != str(prepared.get("photo_url") or ""):
            _repo.update(member_id, lambda current: {**current, "photo_url": uploaded_photo_url})
    except Exception:
        if created.get("photo_url") and str(created.get("photo_url") or "") != str(prepared.get("photo_url") or ""):
            _delete_member_photo(member_id, str(created.get("photo_url") or ""))
        _repo.delete(member_id)
        raise
    return public_member_payload(created)


async def update_member(member_id: int, member_payload: dict[str, Any], photo_file: UploadFile | None = None) -> dict[str, Any]:
    _, current = _repo.find_by_id(member_id)
    old_photo_url = str(current.get("photo_url") or "")
    prepared = prepare_member_payload(member_payload, current)
    photo_source = str(prepared.get("photo_url") or "")
    try:
        uploaded_photo_url = await _persist_member_photo(member_id, photo_source, photo_file)
        prepared["photo_url"] = uploaded_photo_url
        updated = _repo.update(member_id, lambda _current: prepared)
    except Exception:
        uploaded_photo_url = str(prepared.get("photo_url") or "")
        if uploaded_photo_url and uploaded_photo_url != old_photo_url:
            _delete_member_photo(member_id, uploaded_photo_url)
        raise
    if old_photo_url and old_photo_url != str(updated.get("photo_url") or ""):
        _delete_member_photo(member_id, old_photo_url)
    return public_member_payload(updated)


async def update_member_profile(
    member_id: int,
    profile_payload: dict[str, Any],
    photo_file: UploadFile | None = None,
) -> dict[str, Any]:
    allowed_fields = {
        "photo_url",
        "joined_at",
        "introducer",
        "role",
        "instrument_history",
        "past_orchestras",
        "comment",
    }

    def _mutate(current: dict[str, Any]) -> dict[str, Any]:
        updated = dict(current)
        for key in allowed_fields:
            if key in profile_payload:
                updated[key] = profile_payload[key]
        return updated

    _, current = _repo.find_by_id(member_id)
    old_photo_url = str(current.get("photo_url") or "")
    updated = _mutate(current)
    photo_source = str(updated.get("photo_url") or "")
    try:
        uploaded_photo_url = await _persist_member_photo(member_id, photo_source, photo_file)
        updated["photo_url"] = uploaded_photo_url
        updated = _repo.update(member_id, lambda _current: updated)
    except Exception:
        uploaded_photo_url = str(updated.get("photo_url") or "")
        if uploaded_photo_url and uploaded_photo_url != old_photo_url:
            _delete_member_photo(member_id, uploaded_photo_url)
        raise
    if old_photo_url and old_photo_url != str(updated.get("photo_url") or ""):
        _delete_member_photo(member_id, old_photo_url)
    return public_member_payload(updated)

def reset_member_password(member_id: int) -> dict[str, Any]:
    def _mutate(current: dict[str, Any]) -> dict[str, Any]:
        updated = dict(current)
        updated["password"] = ""
        return updated

    updated = _repo.update(member_id, _mutate)
    return public_member_payload(updated)

def delete_member(member_id: int) -> None:
    _, current = _repo.find_by_id(member_id)
    _delete_member_photo(member_id, str(current.get("photo_url") or ""))
    _repo.delete(member_id)
