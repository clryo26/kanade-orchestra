"""Sheet PDF/ZIP delivery (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md, section 6).

Two ways to receive a file, both authenticated and bound to the organization:
- fetch with the device header (the portal reads it into memory up to the
  limits in the client, then offers the OS share/save sheet), and
- a short-lived ticket URL for the save path that cannot send headers
  (navigation in a separate browser context when sharing is unavailable or
  the file is larger than the in-memory limit). Only the SHA-256 of a ticket
  is stored; every use re-checks the device session and the organization.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse

from ..core.tenant_context import get_current_tenant_id, reset_current_tenant_id, set_current_tenant_id
from ..repositories import sheet_repository as repo
from . import sheet_storage_service as storage
from . import sheet_zip_service as zips

TICKET_TTL = timedelta(minutes=10)


def _disposition(kind: str, filename: str) -> str:
    ascii_name = "".join(ch if 32 <= ord(ch) < 127 and ch not in '"\\' else "_" for ch in filename) or "download"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def _stream(source: str, name: str, generation: Any, filename: str, media: str, download: bool,
            area: str = "sheet") -> StreamingResponse:
    try:
        info = storage.stat(source, name, generation, area)
        reader = storage.open_reader(source, name, generation, area)
    except storage.StorageMissing as exc:
        raise HTTPException(404, detail={"code": "sheet_file_missing", "message": "ファイルが見つかりません。一覧を更新してください"}) from exc
    return StreamingResponse(storage.iter_chunks(reader), media_type=media, headers={
        "Content-Length": str(info["size"]),
        "Content-Disposition": _disposition("attachment" if download else "inline", filename),
        # Authenticated content: never shared caches, never stale lists.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
    })


def sheet_response(item: dict[str, Any], download: bool) -> StreamingResponse:
    source = "google_cloud_storage" if item.get("source") == "google_cloud_storage" else "local"
    name = str(item.get("object_name") if source == "google_cloud_storage" else item.get("path") or "")
    if not name:
        raise HTTPException(404, detail="File not found")
    filename = str(item.get("name") or "score.pdf")
    return _stream(source, name, item.get("storage_generation"), filename, "application/pdf", download)


def zip_response(job: dict[str, Any]) -> StreamingResponse:
    source = storage.source_kind()
    return _stream(source, str(job["object_name"]), None, zips.download_name(job), "application/zip", True, area="zip")


def create_ticket(device: dict[str, Any], kind: str, target_id: str) -> dict[str, Any]:
    from .sheet_library_service import sheet_by_id
    if kind == "file":
        if not str(target_id).isdigit() or not sheet_by_id(int(target_id)):
            raise HTTPException(404, detail={"code": "sheet_missing", "message": "楽譜が見つかりません。一覧を更新してください"})
    elif kind == "zip":
        zips.owned_ready_job(device, str(target_id))
    else:
        raise HTTPException(422, detail="Invalid target")
    token = secrets.token_urlsafe(32)
    with repo.transaction() as cur:
        now = repo.db_now(cur)
        expires = now + TICKET_TTL
        cur.execute("INSERT INTO sheet_download_tickets (ticket_hash,organization_id,device_id,target_kind,target_id,created_at,expires_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (hashlib.sha256(token.encode()).hexdigest(), get_current_tenant_id(), str(device.get("device_id") or ""),
                     kind, str(target_id), now, expires))
    return {"url": f"/api/sheets/tickets/{token}", "expires_at": repo.iso(expires)}


def ticket_response(token: str, device_auth_record) -> StreamingResponse | HTMLResponse:
    digest = hashlib.sha256(str(token).encode()).hexdigest()
    with repo.transaction() as cur:
        # Looked up by its hash only; the ticket names its organization.
        cur.execute("SELECT * FROM sheet_download_tickets WHERE ticket_hash=%s AND expires_at>clock_timestamp()", (digest,))
        ticket = cur.fetchone()
    if not ticket:
        return guidance_page(410, "保存用のリンクの期限が切れました。ポータルに戻って、もう一度「DL」を押してください。")
    context = set_current_tenant_id(ticket["organization_id"])
    try:
        try:
            device = device_auth_record(ticket["device_id"])
        except HTTPException:
            return guidance_page(401, "ログインの状態を確認できません。ポータルに戻ってログインしてから、もう一度お試しください。")
        if ticket["target_kind"] == "file":
            from .sheet_library_service import sheet_by_id
            item = sheet_by_id(int(ticket["target_id"]))
            if not item:
                return guidance_page(404, "楽譜が削除されたか、見つかりません。ポータルで一覧を更新してください。")
            return sheet_response(item, download=True)
        job = zips.owned_ready_job(device, ticket["target_id"])
        return zip_response(job)
    finally:
        reset_current_tenant_id(context)


def guidance_page(status: int, message: str) -> HTMLResponse:
    # Shown when a download is opened without the portal's session (an old
    # screen's link, an expired ticket). Always offers the way back.
    html = ("<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>楽譜の保存</title>"
            "<style>body{font-family:system-ui,sans-serif;margin:24px;line-height:1.6}"
            "a{display:inline-block;padding:12px 20px;border-radius:8px;background:#0d6efd;color:#fff;text-decoration:none}</style>"
            f"</head><body><p>{message}</p><p><a href=\"/\">ポータルに戻る</a></p></body></html>")
    return HTMLResponse(html, status_code=status, headers={"Cache-Control": "no-store"})
