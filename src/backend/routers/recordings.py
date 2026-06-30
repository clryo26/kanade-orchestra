from __future__ import annotations

# ruff: noqa: F403,F405
from fastapi import APIRouter

from ..app_core import *

router = APIRouter()

# ===== 骭ｲ髻ｳ繝輔ぃ繧､繝ｫ API =====
# 骭ｲ髻ｳ繝輔ぃ繧､繝ｫ繧貞女縺大叙繧翫∝ｿ・ｦ√↓蠢懊§縺ｦ繧ｯ繝ｩ繧ｦ繝峨∈蜷梧悄縺励※逋ｻ骭ｲ縺吶ｋ縲・
@router.post("/api/convert")
async def convert_audio(
    file: UploadFile = File(...),
    date: str = Form(""),
    piece: str = Form(""),
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_recording_manager_device(x_device_id)
    ensure_audio_file(file)

    date_dir = safe_segment(date, datetime.now().date().isoformat())
    piece_dir = safe_segment(piece, "uncategorized")
    output_dir = CONVERTED_DIR / date_dir / piece_dir
    output_path = save_upload_to_path(file, output_dir)

    duration_seconds = get_audio_duration_seconds(output_path)
    rel_path = output_path.relative_to(UPLOAD_DIR).as_posix()
    remember_recording_duration(rel_path, duration_seconds)
    response = {
        "filename": output_path.name,
        "path": rel_path,
        "download_url": f"/api/recordings/download/{rel_path}",
        "source": "local",
        "duration_seconds": duration_seconds,
        "duration": format_duration(duration_seconds),
        "message": "Uploaded",
    }

    if storage_enabled():
        storage_file = upload_file_to_drive(
            local_path=output_path,
            practice_date=date_dir,
            song_name=piece_dir,
        )
        logger.info("Google Cloud Storage upload complete: %s", storage_file)
        storage_file["duration_seconds"] = duration_seconds
        storage_file["duration"] = format_duration(duration_seconds)
        remember_drive_file(storage_file)
        response.update(
            {
                "drive_file_id": storage_file["id"],
                "share_link": storage_file.get("view_url") or storage_file.get("download_url"),
                "download_url": storage_file.get("download_url") or response["download_url"],
                "source": "google_cloud_storage",
                "message": "Uploaded and mirrored to Google Cloud Storage",
            }
        )

    return response


def recording_payload() -> dict[str, list[dict[str, Any]]]:
    # Cloud 荳翫・骭ｲ髻ｳ繧貞・鬆ｭ縺ｫ縲√Ο繝ｼ繧ｫ繝ｫ骭ｲ髻ｳ繧呈峩譁ｰ譌･譎る剄鬆・〒邯壹￠縺ｦ霑斐☆縲・
    # 蜷後§骭ｲ髻ｳ縺・Cloud 縺ｨ繝ｭ繝ｼ繧ｫ繝ｫ縺ｮ荳｡譁ｹ縺ｫ縺ゅｋ蝣ｴ蜷医・ Cloud 蛛ｴ繧貞━蜈医＠縲・
    # 繧｢繝・・繝ｭ繝ｼ繝臥峩蠕後・荳隕ｧ縺ｧ蜷御ｸ繝輔ぃ繧､繝ｫ縺御ｺ碁㍾陦ｨ遉ｺ縺輔ｌ縺ｪ縺・ｈ縺・↓縺吶ｋ縲・
    drive_files = [cloud_recording_metadata(item) for item in load_json_data("drive_files")]
    mirrored_local_paths = {
        f"converted/{object_name}"
        for item in drive_files
        for object_name in [str(item.get("object_name") or item.get("id") or "").strip("/")]
        if object_name
    }
    local_paths = sorted(
        [*CONVERTED_DIR.rglob("*.mp3"), *CONVERTED_DIR.rglob("*.m4a")],
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    local_files = [
        local_recording_metadata(path)
        for path in local_paths
        if path.relative_to(UPLOAD_DIR).as_posix() not in mirrored_local_paths
    ]
    return {"files": drive_files + local_files}


# 骭ｲ髻ｳ荳隕ｧ・・loud + 繝ｭ繝ｼ繧ｫ繝ｫ邨ｱ蜷茨ｼ峨ｒ霑斐☆縲・
@router.get("/api/recordings")
async def get_recordings() -> dict[str, list[dict[str, Any]]]:
    return recording_payload()


# 譚｡莉ｶ縺ｫ荳閾ｴ縺吶ｋ骭ｲ髻ｳ繧・ZIP 縺ｫ縺ｾ縺ｨ繧√※繝繧ｦ繝ｳ繝ｭ繝ｼ繝峨＆縺帙ｋ縲・
@router.get("/api/recordings/download-zip")
async def download_recordings_zip(date: str = "", piece: str = "") -> Response:
    recordings = [
        item
        for item in recording_payload()["files"]
        if (not date or str(item.get("date") or "") == date)
        and (not piece or str(item.get("piece") or "") == piece)
    ]
    if not recordings:
        raise HTTPException(status_code=404, detail="Recordings not found")

    buffer = io.BytesIO()
    used_names: set[str] = set()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in recordings:
            data = recording_file_bytes(item)
            if data is None:
                continue
            filename = safe_upload_name(str(item.get("name") or "recording.mp3"))
            if not Path(filename).suffix:
                filename = f"{filename}.mp3"
            filename = unique_zip_name(filename, used_names)
            archive.writestr(filename, data)

    if not buffer.tell():
        raise HTTPException(status_code=404, detail="Recording files not found")

    zip_name = safe_segment(f"recordings_{date or 'all'}_{piece or 'all'}", "recordings") + ".zip"
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(zip_name)}",
            "Cache-Control": "private, max-age=60",
        },
    )


def local_recording_path(path: str) -> Path:
    requested = (UPLOAD_DIR / path).resolve()
    if not requested.is_file() or UPLOAD_DIR.resolve() not in requested.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return requested


# 繝ｭ繝ｼ繧ｫ繝ｫ骭ｲ髻ｳ繧貞・逕溽畑騾斐〒霑斐☆縲・
@router.get("/api/recordings/play/{path:path}")
async def play_recording(path: str) -> FileResponse:
    requested = local_recording_path(path)
    return FileResponse(
        requested,
        media_type=mimetypes.guess_type(requested.name)[0] or "application/octet-stream",
    )


# 繝ｭ繝ｼ繧ｫ繝ｫ骭ｲ髻ｳ繧呈ｷｻ莉倥ム繧ｦ繝ｳ繝ｭ繝ｼ繝峨〒霑斐☆縲・
@router.get("/api/recordings/download/{path:path}")
async def download_recording(path: str) -> FileResponse:
    requested = local_recording_path(path)
    return FileResponse(requested, filename=requested.name)


# 骭ｲ髻ｳ・・loud 縺ｾ縺溘・繝ｭ繝ｼ繧ｫ繝ｫ・峨ｒ蜑企勁縺吶ｋ縲・
@router.delete("/api/recordings")
async def delete_recording(payload: RecordingDeleteRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, str]:
    require_recording_manager_device(x_device_id)
    if payload.source == "google_cloud_storage":
        object_name = payload.object_name.strip()
        if not object_name:
            raise HTTPException(status_code=400, detail="object_name is required")

        blob = get_storage_bucket().blob(object_name)
        if blob.exists():
            blob.delete()
        forget_drive_file(object_name)
        return {"message": "Deleted"}

    path = payload.path.strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")

    requested = local_recording_path(path)
    requested.unlink()
    return {"message": "Deleted"}


def parse_range_header(range_header: str, total_size: int) -> tuple[int, int] | None:
    if not range_header or not range_header.startswith("bytes="):
        return None
    first_range = range_header.removeprefix("bytes=").split(",", 1)[0].strip()
    if "-" not in first_range:
        return None
    start_text, end_text = first_range.split("-", 1)
    if not start_text and not end_text:
        return None
    if start_text:
        start = int(start_text)
        end = int(end_text) if end_text else total_size - 1
    else:
        suffix_length = int(end_text)
        start = max(total_size - suffix_length, 0)
        end = total_size - 1
    if start >= total_size:
        return None
    return max(start, 0), min(end, total_size - 1)


def stream_storage_blob(object_name: str, download: bool, request: Request):
    # Cloud Storage 荳翫・繝輔ぃ繧､繝ｫ繧偵∝・逕滓凾縺ｯ Range 蟇ｾ蠢懊〒縲・
    # 繝繧ｦ繝ｳ繝ｭ繝ｼ繝画凾縺ｯ騾壼ｸｸ豺ｻ莉倥→縺励※驟堺ｿ｡縺吶ｋ蜈ｱ騾壹せ繝医Μ繝ｼ繝槭・縲・
    if not storage_enabled():
        raise HTTPException(status_code=503, detail="Google Cloud Storage is not configured")
    if not object_name:
        raise HTTPException(status_code=404, detail="File not found")

    blob = get_storage_bucket().blob(object_name)
    if not blob.exists():
        raise HTTPException(status_code=404, detail="File not found")

    blob.reload()
    filename = Path(object_name).name
    total_size = int(blob.size or 0)
    disposition = "attachment" if download else "inline"
    content_type = blob.content_type or mimetypes.guess_type(filename)[0] or "audio/mpeg"
    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(filename)}",
        "Cache-Control": "private, max-age=3600",
    }

    requested_range = None if download else parse_range_header(request.headers.get("range", ""), total_size)
    if requested_range:
        start, end = requested_range
        data = blob.download_as_bytes(start=start, end=end)
        headers = {
            **base_headers,
            "Content-Range": f"bytes {start}-{end}/{total_size}",
            "Content-Length": str(len(data)),
        }
        return Response(content=data, status_code=206, media_type=content_type, headers=headers)

    headers = dict(base_headers)
    if total_size:
        headers["Content-Length"] = str(total_size)

    def chunks():
        with blob.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(chunks(), media_type=content_type, headers=headers)


# Cloud 骭ｲ髻ｳ繧・Range 蟇ｾ蠢懊〒蜀咲函驟堺ｿ｡縺吶ｋ縲・
@router.get("/api/recordings/cloud/play/{object_name:path}")
async def play_cloud_recording(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=False, request=request)


# Cloud 骭ｲ髻ｳ繧呈ｷｻ莉倥ム繧ｦ繝ｳ繝ｭ繝ｼ繝峨〒驟堺ｿ｡縺吶ｋ縲・
@router.get("/api/recordings/cloud/download/{object_name:path}")
async def download_cloud_recording(object_name: str, request: Request) :
    return stream_storage_blob(object_name, download=True, request=request)


# 骭ｲ髻ｳ繧・Cloud Storage 縺ｸ繧｢繝・・繝ｭ繝ｼ繝峨＠繝｡繧ｿ繝・・繧ｿ繧定ｿ斐☆縲・
@router.post("/api/drive/upload")
async def upload_to_drive(
    file: UploadFile = File(...),
    date: str = Form(""),
    piece: str = Form(""),
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_recording_manager_device(x_device_id)
    ensure_audio_file(file)

    date_dir = safe_segment(date, datetime.now().date().isoformat())
    logger.info(f"date={date}")
    logger.info(f"piece={piece}")
    piece_dir = safe_segment(piece, "uncategorized")
    output_path = save_upload_to_path(file, CONVERTED_DIR / date_dir / piece_dir)
    duration_seconds = get_audio_duration_seconds(output_path)
    rel_path = output_path.relative_to(UPLOAD_DIR).as_posix()
    remember_recording_duration(rel_path, duration_seconds)

    if not storage_enabled():
        return {
            "drive_file_id": None,
            "share_link": f"/api/recordings/download/{rel_path}",
            "source": "local",
            "duration_seconds": duration_seconds,
            "duration": format_duration(duration_seconds),
            "message": "Google Cloud Storage is not configured. Saved locally.",
        }

    try:
        drive_item = upload_file_to_drive(output_path, date_dir, piece_dir)
        drive_item["duration_seconds"] = duration_seconds
        drive_item["duration"] = format_duration(duration_seconds)
        remember_recording_duration(str(drive_item.get("object_name") or drive_item.get("id") or ""), duration_seconds)
        remember_drive_file(drive_item)
    except Exception as exc:
        logger.exception("Google Cloud Storage upload failed")
        raise HTTPException(
            status_code=502,
            detail=f"Google Cloud Storage upload failed: {exc}",
        ) from exc

    return {
        "drive_file_id": drive_item["id"],
        "share_link": drive_item.get("web_view_link") or drive_item.get("download_url"),
        "download_url": drive_item.get("download_url"),
        "source": "google_cloud_storage",
        "duration_seconds": duration_seconds,
        "duration": format_duration(duration_seconds),
        "message": "Uploaded to Google Cloud Storage",
    }


# Cloud 骭ｲ髻ｳ繝｡繧ｿ繝・・繧ｿ荳隕ｧ繧定ｿ斐☆縲・
@router.get("/api/drive/files")
async def get_drive_files() -> dict[str, list[dict[str, Any]]]:
    return {"files": load_json_data("drive_files")}


