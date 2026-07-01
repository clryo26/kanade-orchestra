from __future__ import annotations

from .base_repository import BaseRepository


class MemberRepository(BaseRepository):
    collection_name = "members"
