from __future__ import annotations

from typing import Any

from ..repositories.payment_repository import PaymentRepository

_repo = PaymentRepository()


def list_payments() -> list[dict[str, Any]]:
    return _repo.list_all()


def create_payment(payload: dict[str, Any]) -> dict[str, Any]:
    return _repo.create(payload)


def update_payment(payment_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return _repo.update(payment_id, lambda current: {**current, **payload})


def delete_payment(payment_id: int) -> None:
    _repo.delete(payment_id)
