from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from ..repositories.db_item_repository import ListRowStore, PostgresRowStore

from fastapi import HTTPException, UploadFile
from fastapi.responses import Response

from ..models.schemas import Member
from ..repositories.member_repository import MemberRepository
from . import portal_file_asset_service as file_assets
from . import member_photo_service
from ..utils.datetime_utils import require_input_dates
from ..utils.concurrency import ensure_expected_updated_at
from .auth_service import (
    prepare_member_payload,
    public_member_list,
    public_member_payload,
    public_member_public_profile_payload,
)

_repo = MemberRepository()

MEMBER_PERMISSIONS = {"一般", "エキストラ", "管理者", "システム管理者"}
SYSTEM_ADMIN_PERMISSION = "システム管理者"
PHOTO_KIND = "member_photo"


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


def member_photo_response(member_id: int, asset: str | None) -> Response:
    member = get_member_record(member_id)
    return file_assets.deliver(PHOTO_KIND, member_id, asset, inline_value=str(member.get("photo_url") or ""))


def _photo_action(payload: dict[str, Any], photo_file: UploadFile | None, current: dict[str, Any] | None, *, replayable: bool = False) -> tuple[Any, str]:
    """replace (file or data URL) / remove (explicit empty over an existing photo) / keep."""
    photo_source = str(payload.get("photo_url") or "")
    if photo_file is not None:
        return photo_file, "replace"
    if file_assets.is_data_image(photo_source):
        return photo_source, "replace"
    if "photo_url" in payload and not photo_source and (replayable or (current is not None and str(current.get("photo_url") or ""))):
        return None, "remove"
    return None, "keep"


async def _photo_file(source: Any) -> Any:
    if source is None:
        return None
    if isinstance(source, str):
        if len(source) > member_photo_service.MAX_INPUT_BYTES * 4 // 3 + 256:
            raise HTTPException(413, detail="写真は20MiB以下のファイルを選択してください")
        return file_assets.read_data_image(source)
    # Bound the read before copying/decoding a high-resolution upload. Other
    # image kinds retain their existing read/validation paths.
    content = await source.read(member_photo_service.MAX_INPUT_BYTES + 1)
    if len(content) > member_photo_service.MAX_INPUT_BYTES:
        raise HTTPException(413, detail="写真は20MiB以下のファイルを選択してください")
    media_type = (source.content_type or "application/octet-stream").lower()
    return file_assets.FileInput(content, media_type, file_assets.IMAGE_EXTENSIONS.get(media_type, ".png"), source.filename or "photo")


def _response_body(saved: dict[str, Any]) -> dict[str, Any]:
    # Same shape as the route's response_model on the non-file path.
    return cast(dict[str, Any], Member.model_validate(public_member_payload(saved)).model_dump())


def _validate_member_permission(member: dict[str, Any]) -> None:
    permission = str(member.get("permission") or "").strip()
    if permission not in MEMBER_PERMISSIONS:
        raise HTTPException(status_code=400, detail="Invalid member permission")
    member["permission"] = permission


def _store() -> PostgresRowStore | ListRowStore:
    from ..core.compat_gateway import row_store

    return row_store()


def _peek(member_id: int) -> dict[str, Any] | None:
    return _store().get("members", member_id)


async def create_member(
    member_payload: dict[str, Any],
    photo_file: UploadFile | None = None,
    *,
    device: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> Any:
    require_input_dates(member_payload, ("system_access_until",), month_fields=("joined_at",))
    prepared = prepare_member_payload(member_payload)
    _validate_member_permission(prepared)
    if prepared["permission"] == SYSTEM_ADMIN_PERMISSION:
        raise HTTPException(status_code=400, detail="System admin permission can only be granted from system permission management")
    source, action = _photo_action(member_payload, photo_file, None)
    # The photo reference is server managed (a confirmed asset only).
    prepared["photo_url"] = ""
    if action == "keep" and not idempotency_key:
        return public_member_payload(_repo.create(prepared))
    file = await _photo_file(source)

    def apply(tx: Any, applied: Any) -> tuple[int, dict[str, Any]]:
        saved = _store().insert("members", lambda new_id: {**prepared, "photo_url": applied.url_for(new_id)}, ctx=tx.ctx)
        if applied.asset_id:
            applied.commit_reference(tx, int(saved["id"]))
        return 200, _response_body(saved)

    status, body = await file_assets.run(
        file_assets.FileOperation(
            kind=PHOTO_KIND, method="POST", target_id=None, action=action, file=file,
            # Only the digest is stored, never this payload. Password changes
            # must still distinguish different contents of the same operation.
            fingerprint=member_payload,
            validate=lambda tx: None, apply=apply, view_scope="admin",
            prepare_file=member_photo_service.normalize,
        ),
        device or {},
        idempotency_key,
    )
    return file_assets.http_result(status, body)


async def _update_with_photo(
    member_id: int,
    member_payload: dict[str, Any],
    photo_file: UploadFile | None,
    mutate: Any,
    *,
    device: dict[str, Any],
    idempotency_key: str | None,
    view_scope: str,
) -> Any:
    # With an operation key, target checks belong after result replay. Derive
    # the action from the request so removal remains identical after commit.
    current = _peek(member_id) if not idempotency_key else None
    if current is None and not idempotency_key:
        raise HTTPException(status_code=404, detail="Data not found")
    source, action = _photo_action(member_payload, photo_file, current, replayable=bool(idempotency_key))
    if action == "keep" and not idempotency_key:
        def keep_photo(latest: dict[str, Any]) -> dict[str, Any]:
            updated = dict(mutate(latest))
            updated["photo_url"] = latest.get("photo_url") or ""
            return updated

        return public_member_payload(_repo.update(member_id, keep_photo))
    file = await _photo_file(source)

    def validate(tx: Any) -> None:
        latest = _store().get("members", member_id, ctx=tx.ctx, lock=True)
        if latest is None:
            raise HTTPException(status_code=404, detail="Data not found")
        ensure_expected_updated_at(latest, member_payload.get("expected_updated_at"))

    def apply(tx: Any, applied: Any) -> tuple[int, dict[str, Any]]:
        def with_photo(latest: dict[str, Any]) -> dict[str, Any]:
            updated = dict(mutate(latest))
            if action == "replace":
                updated["photo_url"] = applied.url_for(member_id)
            elif action == "remove":
                updated["photo_url"] = ""
            else:
                updated["photo_url"] = latest.get("photo_url") or ""
            return updated

        saved = _store().update("members", member_id, with_photo, expected_updated_at=member_payload.get("expected_updated_at"), ctx=tx.ctx)
        if action == "replace":
            applied.commit_reference(tx, member_id)
        elif action == "remove":
            applied.retire_reference(tx, member_id)
        return 200, _response_body(saved)

    status, body = await file_assets.run(
        file_assets.FileOperation(
            kind=PHOTO_KIND, method="PUT", target_id=member_id, action=action, file=file,
            fingerprint=member_payload,
            validate=validate, apply=apply, view_scope=view_scope,
            prepare_file=member_photo_service.normalize,
        ),
        device,
        idempotency_key,
    )
    return file_assets.http_result(status, body)


async def update_member(
    member_id: int,
    member_payload: dict[str, Any],
    photo_file: UploadFile | None = None,
    *,
    device: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> Any:
    def mutate(current: dict[str, Any]) -> dict[str, Any]:
        # Evaluated on the locked current row (no stale password/permission).
        prepared = prepare_member_payload(member_payload, current)
        _validate_member_permission(prepared)
        if current.get("permission") != SYSTEM_ADMIN_PERMISSION and prepared["permission"] == SYSTEM_ADMIN_PERMISSION:
            raise HTTPException(status_code=400, detail="System admin permission can only be granted from system permission management")
        return prepared

    require_input_dates(member_payload, ("system_access_until",), month_fields=("joined_at",))
    # Same permission validation as before, before any lock or file work.
    _validate_member_permission({"permission": member_payload.get("permission")})
    return await _update_with_photo(
        member_id, member_payload, photo_file, mutate,
        device=device or {}, idempotency_key=idempotency_key, view_scope="admin",
    )


def grant_system_permission(member_id: int) -> dict[str, Any]:
    """Grant the existing system-admin permission without editing other member roles."""
    updated = _repo.update(member_id, lambda current: {**current, "permission": SYSTEM_ADMIN_PERMISSION})
    return public_member_payload(updated)


async def update_member_profile(
    member_id: int,
    profile_payload: dict[str, Any],
    photo_file: UploadFile | None = None,
    *,
    device: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> Any:
    allowed_fields = {
        "joined_at",
        "introducer",
        "role",
        "instrument_history",
        "past_orchestras",
        "comment",
    }

    require_input_dates(profile_payload, (), month_fields=("joined_at",))

    def mutate(current: dict[str, Any]) -> dict[str, Any]:
        updated = dict(current)
        for key in allowed_fields:
            if key in profile_payload:
                updated[key] = profile_payload[key]
        return updated

    return await _update_with_photo(
        member_id, profile_payload, photo_file, mutate,
        device=device or {}, idempotency_key=idempotency_key, view_scope="owner",
    )


def reset_member_password(member_id: int) -> dict[str, Any]:
    def _mutate(current: dict[str, Any]) -> dict[str, Any]:
        updated = dict(current)
        updated["password"] = ""
        return updated

    updated = _repo.update(member_id, _mutate)
    return public_member_payload(updated)


def requires_file_operation_for_delete(member_id: int, idempotency_key: str | None) -> bool:
    return bool(idempotency_key) or file_assets.has_active_asset(PHOTO_KIND, member_id)


async def delete_member(member_id: int, *, device: dict[str, Any] | None = None, idempotency_key: str | None = None) -> Any:
    result: Any = None
    if requires_file_operation_for_delete(member_id, idempotency_key):
        def validate(tx: Any) -> None:
            if _store().get("members", member_id, ctx=tx.ctx, lock=True) is None:
                raise HTTPException(status_code=404, detail="Data not found")

        def apply(tx: Any, applied: Any) -> tuple[int, dict[str, Any]]:
            _store().delete("members", member_id, lambda current: None, ctx=tx.ctx)
            applied.retire_reference(tx, member_id)
            return 200, {"message": "Deleted"}

        status, body = await file_assets.run(
            file_assets.FileOperation(
                kind=PHOTO_KIND, method="DELETE", target_id=member_id, action="delete", file=None,
                fingerprint={}, validate=validate, apply=apply, view_scope="admin",
            ),
            device or {},
            idempotency_key,
        )
        result = file_assets.http_result(status, body)
        if status != 200:
            return result
    else:
        _repo.delete(member_id)
    # The tuner history of this member is revoked and deleted (the DB trigger
    # does the same; this call covers databases where it is missing).
    from .tuner_service import revoke_member

    revoke_member(member_id)
    return result
