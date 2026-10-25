"""Private photo bindings, shared without importing app/core startup wiring."""

ALBUM_PHOTO_ASSET_REFS = ("original_asset_id", "thumbnail_asset_id")
ALBUM_PHOTO_INTERNAL_COLUMNS = frozenset((*ALBUM_PHOTO_ASSET_REFS, "original_asset_kind", "thumbnail_asset_kind"))
