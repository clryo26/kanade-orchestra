from __future__ import annotations

from .base_repository import BaseRepository


class EventRepository(BaseRepository):
    collection_name = "events"
