from __future__ import annotations

from typing import Any, cast

from ..repositories.payment_repository import PaymentRepository

_repo = PaymentRepository()


def list_payments() -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], _repo.list_all())


def create_payment(payload: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], _repo.create(payload))


def update_payment(payment_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], _repo.update(payment_id, lambda current: {**current, **payload}))


def delete_payment(payment_id: int) -> None:
    _repo.delete(payment_id)
