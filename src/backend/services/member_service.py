from __future__ import annotations

from typing import Any

from ..repositories.member_repository import MemberRepository
from .auth_service import prepare_member_payload, public_member_list, public_member_payload

_repo = MemberRepository()


def list_members() -> list[dict[str, Any]]:
    return public_member_list(_repo.list_all())


def create_member(member_payload: dict[str, Any]) -> dict[str, Any]:
    prepared = prepare_member_payload(member_payload)
    created = _repo.create(prepared)
    return public_member_payload(created)


def update_member(member_id: int, member_payload: dict[str, Any]) -> dict[str, Any]:
    def _mutate(current: dict[str, Any]) -> dict[str, Any]:
        return prepare_member_payload(member_payload, current)

    updated = _repo.update(member_id, _mutate)
    return public_member_payload(updated)


def delete_member(member_id: int) -> None:
    _repo.delete(member_id)
