from __future__ import annotations

# ruff: noqa: F403,F405
from fastapi import APIRouter

from ..app_core import *

router = APIRouter()

# ===== 讌ｽ隴・API =====
# 讌ｽ隴應ｸ隕ｧ繧定ｿ斐☆縲・
@router.get("/api/sheets")
async def get_sheets() -> dict[str, list[dict[str, Any]]]:
    return {"files": sheet_payload()}


# 繝ｭ繝ｼ繧ｫ繝ｫ讌ｽ隴懊ｒ豺ｻ莉倥ム繧ｦ繝ｳ繝ｭ繝ｼ繝峨〒霑斐☆縲・
@router.get("/api/sheets/download/{path:path}")
async def download_local_sheet(path: str) -> FileResponse:
    requested = local_sheet_path(path)
    return FileResponse(requested, media_type="application/pdf", filename=requested.name)


# 繝ｭ繝ｼ繧ｫ繝ｫ讌ｽ隴懊ｒ繧､繝ｳ繝ｩ繧､繝ｳ陦ｨ遉ｺ逕ｨ縺ｫ霑斐☆縲・
@router.get("/api/sheets/view/{path:path}")
async def view_local_sheet(path: str) -> Response:
    requested = local_sheet_path(path)
    return Response(
        content=requested.read_bytes(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(requested.name)}",
            "Cache-Control": "private, max-age=3600",
        },
    )


# Cloud 讌ｽ隴懊ｒ豺ｻ莉倥ム繧ｦ繝ｳ繝ｭ繝ｼ繝峨〒霑斐☆縲・
@router.get("/api/sheets/cloud/download/{object_name:path}")
async def download_cloud_sheet(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=True, request=request)


# Cloud 讌ｽ隴懊ｒ繧､繝ｳ繝ｩ繧､繝ｳ陦ｨ遉ｺ逕ｨ縺ｫ霑斐☆縲・
@router.get("/api/sheets/cloud/view/{object_name:path}")
async def view_cloud_sheet(object_name: str, request: Request):
    return stream_storage_blob(object_name, download=False, request=request)


# 譚｡莉ｶ縺ｫ荳閾ｴ縺吶ｋ讌ｽ隴懊ｒ ZIP 縺ｫ縺ｾ縺ｨ繧√※霑斐☆縲・
@router.get("/api/sheets/download-zip")
async def download_sheets_zip(performance_id: str = "", piece: str = "", part: str = "") -> Response:
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

    buffer = io.BytesIO()
    used_names: set[str] = set()
    performance_title = sheets[0].get("performance_title") or "sheets"
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in sheets:
            data = sheet_file_bytes(item)
            if data is None:
                continue
            folder = safe_segment(str(item.get("piece") or "piece"), "piece")
            filename = unique_zip_name(str(item.get("name") or "score.pdf"), used_names)
            archive.writestr(f"{folder}/{filename}", data)

    if not buffer.tell():
        raise HTTPException(status_code=404, detail="Sheet files not found")

    zip_name = safe_segment(f"{performance_title}_{piece or 'all'}_{part or 'all-parts'}", "sheets") + ".zip"
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(zip_name)}",
            "Cache-Control": "private, max-age=60",
        },
    )


# 讌ｽ隴・PDF 繧貞女縺大叙繧翫∽ｿ晏ｭ伜・縺ｫ蠢懊§縺ｦ逋ｻ骭ｲ縺吶ｋ縲・
@router.post("/api/sheets/upload")
async def upload_sheet(
    file: UploadFile = File(...),
    performance_id: str = Form(""),
    performance_title: str = Form(""),
    piece: str = Form(""),
    x_device_id: str = Header(default="", alias="X-Device-Id"),
) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    ensure_pdf_file(file)
    if not performance_id:
        raise HTTPException(status_code=400, detail="performance_id is required")
    if not piece:
        raise HTTPException(status_code=400, detail="piece is required")

    performance_dir = safe_segment(f"{performance_id}_{performance_title}", "performance")
    piece_dir = safe_segment(piece, "piece")
    now = datetime.now().isoformat()

    if storage_enabled():
        staging_path = save_upload_to_path(file, DRIVE_STAGING_DIR / "sheets" / performance_dir / piece_dir)
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
    payload = normalize_extra_payload(item)
    payload["id"] = next_id(items)
    items.insert(0, payload)
    save_json_data("sheet_library", items)
    return sheet_metadata(payload)


# 謖・ｮ壽･ｽ隴懊・繝代・繝域ュ蝣ｱ繧呈峩譁ｰ縺吶ｋ縲・
@router.put("/api/sheets/{sheet_id}/part")
async def update_sheet_part(sheet_id: int, payload: SheetPartUpdateRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    items = load_json_data("sheet_library")
    index, current = find_item(items, sheet_id)
    current["part"] = payload.part.strip()
    current["updated_at"] = datetime.now().isoformat()
    items[index] = current
    save_json_data("sheet_library", items)
    return sheet_metadata(current)


# 隍・焚讌ｽ隴懊・繝代・繝域ュ蝣ｱ繧剃ｸ諡ｬ譖ｴ譁ｰ縺吶ｋ縲・
@router.put("/api/sheets/parts")
async def update_sheets_parts(payload: SheetBulkPartUpdateRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    if not payload.sheet_ids:
        raise HTTPException(status_code=400, detail="sheet_ids is required")
    if not payload.part.strip():
        raise HTTPException(status_code=400, detail="part is required")
    
    items = load_json_data("sheet_library")
    updated_count = 0
    part_value = payload.part.strip()
    now_str = datetime.now().isoformat()
    
    # 荳諡ｬ譖ｴ譁ｰ縺ｯ莉ｶ謨ｰ縺梧ｯ碑ｼ・噪蟆上＆縺・燕謠舌・縺溘ａ縲・
    # 譌｢蟄倥・鬆・ｺ上ｒ菫昴▲縺溘∪縺ｾ蟇ｾ雎｡縺縺代ｒ譖ｸ縺肴鋤縺医ｋ蜊倡ｴ斐↑譖ｴ譁ｰ縺ｫ縺励※縺・ｋ縲・
    for sheet_id in payload.sheet_ids:
        for i, item in enumerate(items):
            if item.get("id") == sheet_id:
                items[i]["part"] = part_value
                items[i]["updated_at"] = now_str
                updated_count += 1
                break
    
    save_json_data("sheet_library", items)
    return {"updated_count": updated_count, "message": f"{updated_count} sheets updated"}


# 譚｡莉ｶ謖・ｮ壹〒讌ｽ隴懊ｒ蜑企勁縺吶ｋ・亥腰逾ｨ/譖ｲ蜊倅ｽ・貍泌･丈ｼ壼腰菴搾ｼ峨・
@router.delete("/api/sheets")
async def delete_sheets(payload: SheetDeleteRequest, x_device_id: str = Header(default="", alias="X-Device-Id")) -> dict[str, Any]:
    require_sheet_manager_device(x_device_id)
    if not payload.performance_id:
        raise HTTPException(status_code=400, detail="performance_id is required")

    items = load_json_data("sheet_library")
    delete_ids: set[int] = set()
    for item in items:
        item_id = int(item.get("id", -1))
        if payload.sheet_id is not None:
            if item_id == payload.sheet_id:
                delete_ids.add(item_id)
        elif str(item.get("performance_id") or "") == str(payload.performance_id):
            if not payload.piece or str(item.get("piece") or "") == payload.piece:
                delete_ids.add(item_id)

    targets = [item for item in items if int(item.get("id", -1)) in delete_ids]
    for item in targets:
        delete_sheet_file(item)

    save_json_data("sheet_library", [item for item in items if int(item.get("id", -1)) not in delete_ids])
    return {"message": "Deleted", "deleted": len(targets)}


