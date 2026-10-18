"""Compatibility shim for the sheet library.

Reads only. Registering, changing and deleting sheets is done by
sheet_library_service (row-level, idempotent); the former whole-list saves
were removed so no path can replace the list with an old copy.
"""
from __future__ import annotations

import zipfile
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from ..drive_storage import get_storage_bucket, storage_enabled
from .sheet_asset_service import local_sheet_path, unique_zip_name
from .file_service import safe_segment


def get_sheets_payload() -> dict[str, Any]:
    # Read straight from the DB with its list version (never a process cache).
    from .sheet_library_service import list_payload
    return list_payload()


SHEET_ZIP_STREAM_CHUNK_SIZE = 1024 * 1024


class _StreamingZipWriter:
    def __init__(self) -> None:
        self._offset = 0
        self._chunks: list[bytes] = []

    def write(self, data: bytes) -> int:
        chunk = bytes(data)
        if chunk:
            self._chunks.append(chunk)
            self._offset += len(chunk)
        return len(chunk)

    def tell(self) -> int:
        return self._offset

    def flush(self) -> None:
        return None

    def seekable(self) -> bool:
        return False

    def drain(self) -> list[bytes]:
        chunks = self._chunks
        self._chunks = []
        return chunks


def _sheet_exists(item: dict[str, Any]) -> bool:
    if item.get("source") == "google_cloud_storage":
        object_name = str(item.get("object_name") or "")
        if not object_name or not storage_enabled():
            return False
        return bool(get_storage_bucket().blob(object_name).exists())

    path = str(item.get("path") or "")
    if not path:
        return False
    try:
        local_sheet_path(path)
    except HTTPException:
        return False
    return True


def _stream_sheets_zip(sheets: list[dict[str, Any]]):
    sink: Any = _StreamingZipWriter()
    used_names: set[str] = set()

    with zipfile.ZipFile(
        sink,
        "w",
        compression=zipfile.ZIP_STORED,
        allowZip64=True,
    ) as archive:
        for item in sheets:
            folder = safe_segment(str(item.get("piece") or "piece"), "piece")
            filename = unique_zip_name(str(item.get("name") or "score.pdf"), used_names)
            archive_name = f"{folder}/{filename}"

            if item.get("source") == "google_cloud_storage":
                object_name = str(item.get("object_name") or "")
                source = get_storage_bucket().blob(object_name).open("rb")
            else:
                source = local_sheet_path(str(item.get("path") or "")).open("rb")

            with source, archive.open(archive_name, "w", force_zip64=True) as target:
                while True:
                    chunk = source.read(SHEET_ZIP_STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    target.write(chunk)
                    yield from sink.drain()
            yield from sink.drain()

    yield from sink.drain()


def download_sheets_zip(
    performance_id: str = "",
    piece: str = "",
    part: str = "",
) -> StreamingResponse:
    if not performance_id:
        raise HTTPException(status_code=400, detail="performance_id is required")

    sheets = [
        item
        for item in get_sheets_payload()["files"]
        if str(item.get("performance_id") or "") == str(performance_id)
        and (not piece or str(item.get("piece") or "") == piece)
        and (not part or str(item.get("part") or "") == part)
    ]
    if not sheets:
        raise HTTPException(status_code=404, detail="Sheets not found")

    # Screens loaded before the ZIP jobs existed still call this route. A ZIP
    # that silently leaves out missing files would look complete, so any
    # missing file refuses the whole download (the new screen offers a
    # partial ZIP only on explicit choice).
    missing = [item for item in sheets if not _sheet_exists(item)]
    if missing:
        raise HTTPException(status_code=409, detail="取得できない楽譜があるため、まとめて保存できません。画面を再読み込みしてください")
    available_sheets = sheets

    performance_title = available_sheets[0].get("performance_title") or "sheets"
    zip_name = safe_segment(
        f"{performance_title}_{piece or 'all'}_{part or 'all-parts'}",
        "sheets",
    ) + ".zip"
    return StreamingResponse(
        _stream_sheets_zip(available_sheets),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(zip_name)}",
            "Cache-Control": "private, no-store",
        },
    )
