from __future__ import annotations

from copy import deepcopy

import pytest
from fastapi import HTTPException

from src.backend.routers.notices import router
from src.backend.services import portal_notice_service


class FakeNoticeRepository:
    def __init__(self, items: list[dict] | None = None) -> None:
        self.items = deepcopy(items or [])

    def list_all(self):
        return deepcopy(self.items)

    def find_by_id(self, item_id: int):
        for item in self.items:
            if item["id"] == item_id:
                return deepcopy(item)
        raise HTTPException(status_code=404, detail="not found")

    def create(self, payload: dict):
        item = {
            **payload,
            "id": max([i["id"] for i in self.items], default=0) + 1,
            "created_at": "2026-08-12T10:00:00+00:00",
            "updated_at": "2026-08-12T10:00:00+00:00",
        }
        self.items.append(item)
        return deepcopy(item)

    def update(self, item_id: int, payload: dict):
        for index, item in enumerate(self.items):
            if item["id"] == item_id:
                updated = {**item, **payload, "updated_at": "2026-08-12T11:00:00+00:00"}
                self.items[index] = updated
                return deepcopy(updated)
        raise HTTPException(status_code=404, detail="not found")

    def delete(self, item_id: int):
        self.items = [item for item in self.items if item["id"] != item_id]


def device(permission: str, member_id: int) -> dict:
    return {"permission": permission, "member_id": member_id}


def test_notice_routes_are_registered_on_notice_router():
    paths = {route.path for route in router.routes}
    assert "/api/notices" in paths
    assert "/api/notices/{notice_id}" in paths


def test_list_notices_sorts_by_registration_timestamp(monkeypatch):
    fake = FakeNoticeRepository([
        {"id": 1, "created_at": "2026-08-12T09:00:00+00:00"},
        {"id": 2, "created_at": "2026-08-12T11:00:00+00:00"},
        {"id": 3, "created_at": "2026-08-12T10:00:00+00:00"},
    ])
    monkeypatch.setattr(portal_notice_service, "_repo", fake)
    assert [item["id"] for item in portal_notice_service.list_notices()] == [2, 3, 1]


def test_general_member_can_create_and_creator_is_server_stamped(monkeypatch):
    fake = FakeNoticeRepository()
    monkeypatch.setattr(portal_notice_service, "_repo", fake)
    created = portal_notice_service.create_notice(
        {"date": "2026-08-12", "title": "title", "content": "body", "created_by_member_id": 999},
        device("一般", 42),
    )
    assert created["created_by_member_id"] == 42


def test_extra_cannot_create(monkeypatch):
    monkeypatch.setattr(portal_notice_service, "_repo", FakeNoticeRepository())
    with pytest.raises(HTTPException) as exc:
        portal_notice_service.create_notice(
            {"date": "2026-08-12", "title": "title", "content": "body"},
            device("エキストラ", 42),
        )
    assert exc.value.status_code == 403


def test_creator_can_update_without_changing_creator(monkeypatch):
    fake = FakeNoticeRepository([
        {
            "id": 1,
            "date": "2026-08-01",
            "title": "old",
            "content": "old body",
            "created_by_member_id": 42,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        }
    ])
    monkeypatch.setattr(portal_notice_service, "_repo", fake)
    updated = portal_notice_service.update_notice(
        1,
        {"date": "2026-08-12", "title": "new", "content": "new body", "created_by_member_id": 77},
        device("一般", 42),
    )
    assert updated["title"] == "new"
    assert updated["created_by_member_id"] == 42


def test_non_owner_general_cannot_update_or_delete(monkeypatch):
    fake = FakeNoticeRepository([
        {"id": 1, "created_by_member_id": 42, "created_at": "2026-08-01T00:00:00+00:00"}
    ])
    monkeypatch.setattr(portal_notice_service, "_repo", fake)
    with pytest.raises(HTTPException) as update_exc:
        portal_notice_service.update_notice(1, {"date": "2026-08-12", "title": "x", "content": "y"}, device("一般", 99))
    with pytest.raises(HTTPException) as delete_exc:
        portal_notice_service.delete_notice(1, device("一般", 99))
    assert update_exc.value.status_code == 403
    assert delete_exc.value.status_code == 403


@pytest.mark.parametrize("permission", ["管理者", "システム管理者"])
def test_admin_roles_can_update_and_delete_others(monkeypatch, permission):
    fake = FakeNoticeRepository([
        {"id": 1, "created_by_member_id": 42, "created_at": "2026-08-01T00:00:00+00:00"}
    ])
    monkeypatch.setattr(portal_notice_service, "_repo", fake)
    updated = portal_notice_service.update_notice(
        1,
        {"date": "2026-08-12", "title": "admin", "content": "body"},
        device(permission, 99),
    )
    assert updated["title"] == "admin"
    portal_notice_service.delete_notice(1, device(permission, 99))
    assert fake.items == []
