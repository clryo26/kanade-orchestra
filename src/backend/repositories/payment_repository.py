from __future__ import annotations

from .base_repository import BaseRepository


class PaymentRepository(BaseRepository):
    collection_name = "payments"
