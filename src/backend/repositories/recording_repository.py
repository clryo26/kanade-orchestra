from __future__ import annotations

from .base_repository import BaseRepository


class RecordingRepository(BaseRepository):
    collection_name = "recording_metadata"
