from __future__ import annotations

from .base_repository import BaseRepository


class AuditRepository(BaseRepository):
    collection_name = "access_logs"
