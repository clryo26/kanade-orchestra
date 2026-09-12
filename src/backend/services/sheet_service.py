from __future__ import annotations

import zipfile
from datetime import datetime
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from ..core.runtime_paths import DRIVE_STAGING_DIR, SHEET_DIR, UPLOAD_DIR
from ..drive_storage import get_storage_bucket, storage_enabled
from ..utils.datetime_utils import next_updated_at
from .sheet_asset_service import delete_sheet_file, local_sheet_path, sheet_metadata, sheet_payload, unique_zip_name
from .file_service import ensure_pdf_file, safe_segment, save_upload_to_path
from .extra_collection_helpers import normalize_extra_payload
from .storage_service import load_json_data, save_json_data
from ..utils.collection_utils import find_item, next_id


def get_sheets_payload() -> dict[str, list[dict[str, Any]]]:
    return {"files": sheet_payload(load_json_data("sheet_library"))}


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
        for item in load_json_data("sheet_library")
        if str(item.get("performance_id") or "") == str(performance_id)
        and (not piece or str(item.get("piece") or "") == piece)
        and (not part or str(item.get("part") or "") == part)
    ]
    if not sheets:
        raise HTTPException(status_code=404, detail="Sheets not found")

    available_sheets = [item for item in sheets if _sheet_exists(item)]
    if not available_sheets:
        raise HTTPException(status_code=404, detail="Sheet files not found")

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
            "Cache-Control": "private, max-age=60",
        },
    )


def upload_sheet_file(
    file: UploadFile,
    performance_id: str,
    performance_title: str,
    piece: str,
) -> dict[str, Any]:
    ensure_pdf_file(file)
    if not performance_id:
        raise HTTPException(status_code=400, detail="performance_id is required")
    if not piece:
        raise HTTPException(status_code=400, detail="piece is required")

    performance_dir = safe_segment(f"{performance_id}_{performance_title}", "performance")
    piece_dir = safe_segment(piece, "piece")
    now = datetime.now().isoformat()

    if storage_enabled():
        staging_path = save_upload_to_path(
            file,
            DRIVE_STAGING_DIR / "sheets" / performance_dir / piece_dir,
        )
        object_name = "/".join(["sheets", performance_dir, piece_dir, staging_path.name])
        blob = get_storage_bucket().blob(object_name)
        blob.upload_from_filename(str(staging_path), content_type="application/pdf")
        blob.reload()
        item = {
            "name": staging_path.name,
            "performance_id": performance_id,
            "performance_title": performance_title,
            "piece": piece,
            "part": "",
            "size": blob.size or staging_path.stat().st_size,
            "mime_type": blob.content_type or "application/pdf",
            "modified_at": blob.updated.isoformat() if blob.updated else now,
            "source": "google_cloud_storage",
            "object_name": object_name,
        }
    else:
        local_path = save_upload_to_path(file, SHEET_DIR / performance_dir / piece_dir)
        rel = local_path.relative_to(UPLOAD_DIR).as_posix()
        item = {
            "name": local_path.name,
            "performance_id": performance_id,
            "performance_title": performance_title,
            "piece": piece,
            "part": "",
            "size": local_path.stat().st_size,
            "mime_type": "application/pdf",
            "modified_at": now,
            "source": "local",
            "path": rel,
        }

    items = load_json_data("sheet_library")
    payload = normalize_extra_payload(item, next_updated_at_func=next_updated_at)
    payload["id"] = next_id(items)
    items.insert(0, payload)
    save_json_data("sheet_library", items)
    return sheet_metadata(payload)


def update_sheet_part(sheet_id: int, part: str) -> dict[str, Any]:
    items = load_json_data("sheet_library")
    index, current = find_item(items, sheet_id)
    current["part"] = part.strip()
    current["updated_at"] = datetime.now().isoformat()
    items[index] = current
    save_json_data("sheet_library", items)
    return sheet_metadata(current)


def update_sheets_parts(sheet_ids: list[int], part: str) -> dict[str, Any]:
    if not sheet_ids:
        raise HTTPException(status_code=400, detail="sheet_ids is required")
    if not part.strip():
        raise HTTPException(status_code=400, detail="part is required")

    items = load_json_data("sheet_library")
    updated_count = 0
    part_value = part.strip()
    now_str = datetime.now().isoformat()

    for sheet_id in sheet_ids:
        for i, item in enumerate(items):
            if item.get("id") == sheet_id:
                items[i]["part"] = part_value
                items[i]["updated_at"] = now_str
                updated_count += 1
                break

    save_json_data("sheet_library", items)
    return {"updated_count": updated_count, "message": f"{updated_count} sheets updated"}


def delete_sheets(performance_id: str, piece: str = "", sheet_id: int | None = None) -> dict[str, Any]:
    if not performance_id:
        raise HTTPException(status_code=400, detail="performance_id is required")

    items = load_json_data("sheet_library")
    delete_ids: set[int] = set()
    for item in items:
        item_id = int(item.get("id", -1))
        if sheet_id is not None:
            if item_id == sheet_id:
                delete_ids.add(item_id)
        elif str(item.get("performance_id") or "") == str(performance_id):
            if not piece or str(item.get("piece") or "") == piece:
                delete_ids.add(item_id)

    targets = [item for item in items if int(item.get("id", -1)) in delete_ids]
    for item in targets:
        delete_sheet_file(item)

    save_json_data(
        "sheet_library",
        [item for item in items if int(item.get("id", -1)) not in delete_ids],
    )
    return {"message": "Deleted", "deleted": len(targets)}
