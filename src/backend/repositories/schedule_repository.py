from __future__ import annotations

from .base_repository import BaseRepository


class ScheduleRepository(BaseRepository):
    collection_name = "schedules"
