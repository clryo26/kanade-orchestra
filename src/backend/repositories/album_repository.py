from __future__ import annotations

import logging
from typing import Any, cast

from fastapi import HTTPException

from .base_repository import BaseRepository
from .db_item_repository import ItemContext, PostgresRowStore
from .db_row_repository import db_row_to_json, table_has_organization_id


logger = logging.getLogger(__name__)


class AlbumRepository(BaseRepository):
    collection_name = "albums"

    def find_photo(self, album_id: int, photo_id: int, *, store: Any) -> dict[str, Any]:
        """PERF-R13: committed target row only; never attach the whole child set."""
        if isinstance(store, PostgresRowStore):
            return store._run(None, lambda ctx: self._select_photo(ctx, album_id, photo_id))
        # Keep the explicit local JSON adapter and existing test stores on the
        # same album-scoped path. A process-wide list can miss other writers.
        album = store.get("albums", album_id)
        if album is None:
            raise HTTPException(status_code=404, detail="Data not found")
        photo = next((row for row in album.get("photos") or [] if str(row.get("id")) == str(photo_id)), None)
        if not photo:
            raise HTTPException(status_code=404, detail="Photo not found")
        return cast(dict[str, Any], photo)

    @staticmethod
    def _select_photo(ctx: ItemContext, album_id: int, photo_id: int) -> dict[str, Any]:
        # Fail closed without the tenant columns: a global child id alone is
        # not proof that its parent belongs to the current organization.
        for table in ("albums", "album_photos"):
            if not table_has_organization_id(ctx.conn, table):
                # Log only fixed schema identifiers, never tenant/device IDs or
                # connection settings. NOT NULL is a separate release preflight.
                logger.error(
                    "PERF-R13 album photo lookup blocked: %s.organization_id is missing; "
                    "deployment schema prerequisite not met", table,
                )
                raise RuntimeError("Album photo lookup requires organization columns")
        # A LEFT JOIN preserves the existing two 404 messages in one snapshot:
        # no row means parent absent; null child id means photo absent. Both
        # parent and child tenant predicates are required even without an FK.
        ctx.cur.execute(
            """SELECT photo.* FROM albums AS album
               LEFT JOIN album_photos AS photo
                 ON photo.album_id = album.id
                AND photo.organization_id = album.organization_id
                AND photo.id = %s
               WHERE album.organization_id = %s AND album.id = %s""",
            (photo_id, ctx.tenant_id, album_id),
        )
        row = ctx.cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Data not found")
        photo = dict(zip((column[0] for column in ctx.cur.description), row))
        if photo.get("id") is None:
            raise HTTPException(status_code=404, detail="Photo not found")
        return db_row_to_json(photo, "album_photos")
