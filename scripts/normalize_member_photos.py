"""Plan/apply member-photo normalization only. No bulk saves or file deletion.

The plan records hashes and sizes, never inline images or personal text. An
apply needs that plan and rechecks each source. Missing legacy files are kept.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import HTTPException  # noqa: E402
from PIL import Image  # noqa: E402
from src.backend.core.compat_gateway import row_store, get_runtime_data_paths  # noqa: E402
from src.backend.core.db_config import db_connection_string  # noqa: E402
from src.backend.core.tenant_context import get_current_tenant_id, set_current_tenant_id  # noqa: E402
from src.backend.services import member_photo_service as portraits  # noqa: E402
from src.backend.services import portal_file_asset_service as assets  # noqa: E402
from src.backend.repositories import portal_file_repository as repo  # noqa: E402


class UnresolvedReference(Exception):
    pass


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def environment_fingerprint() -> str:
    # Bind a plan to its DB/bucket without recording credentials or hostnames.
    # TEST and production can have the same tenant/identical source images.
    if repo.uses_local_store():
        identity = ["local", *(str(p.resolve()) for p in get_runtime_data_paths())]
    else:
        from psycopg.conninfo import conninfo_to_dict
        from src.backend.drive_storage import storage_bucket_name
        config = conninfo_to_dict(db_connection_string())
        identity = [config.get(k, "") for k in ("host", "port", "dbname")]
        identity.append(storage_bucket_name())
    return _hash(json.dumps(identity))


def _stored_asset(member_id: int, asset_id: str | None) -> dict[str, Any] | None:
    if repo.uses_local_store():
        # A dry-run must not create/migrate the local SQLite asset registry.
        path = get_runtime_data_paths()[0] / "portal-files-local.sqlite3"
        if not path.exists():
            return None
        with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as conn:
            conn.row_factory = sqlite3.Row
            clause = "asset_id=?" if asset_id else "state='active'"
            params = (get_current_tenant_id(), member_id, asset_id) if asset_id else (get_current_tenant_id(), member_id)
            row = conn.execute("SELECT * FROM portal_file_assets WHERE organization_id=? AND owner_id=? AND kind='member_photo' AND " + clause, params).fetchone()
            return dict(row) if row else None
    with assets.transaction() as tx:
        return repo.asset(tx.cur, asset_id) if asset_id else repo.active_asset(tx.cur, "member_photo", member_id)


def _source(member: dict[str, Any]) -> tuple[assets.FileInput, bool]:
    reference = str(member.get("photo_url") or "")
    if assets.is_data_image(reference):
        if len(reference) > portraits.MAX_INPUT_BYTES * 4 // 3 + 256:
            raise HTTPException(413, "Photo is too large")
        return assets.read_data_image(reference), False
    asset_id = (parse_qs(urlsplit(reference).query).get("asset") or [None])[0]
    stored = _stored_asset(int(member["id"]), asset_id)
    if not stored:
        if not asset_id:
            parsed = urlsplit(reference)
            ext = (parse_qs(parsed.query).get("ext") or [""])[0]
            if parsed.path == f"/api/members/{member['id']}/photo" and ext.isalnum():
                candidate = assets.LEGACY_IMAGE_PREFIXES["member_photo"].format(id=member["id"]) + "." + ext
                if assets.legacy_object_identity(candidate) is None:
                    raise FileNotFoundError()
        # A fixed-name candidate's existence alone is not source proof.
        # Confirm legacy refs using migrate_reference_assets.py first.
        raise UnresolvedReference()
    if (stored.get("kind") != "member_photo" or int(stored.get("owner_id") or 0) != int(member["id"])
            or stored.get("state") != "active"):
        raise UnresolvedReference()
    if not asset_id:
        evidence = stored.get("legacy_evidence") or {}
        if isinstance(evidence, str):
            evidence = json.loads(evidence)
        if not stored.get("legacy") or evidence.get("db_value") != reference:
            raise UnresolvedReference()
    if int(stored.get("byte_size") or 0) > portraits.MAX_INPUT_BYTES:
        raise HTTPException(413, "Photo is too large")
    content = assets._read_bytes(stored)
    expected_key = f"portal-files/{quote(get_current_tenant_id(), safe='')}/member_photo/v1/{stored['asset_id']}.webp"
    marked = (stored.get("object_name") == expected_key and stored.get("filename") == portraits.FILENAME
              and stored.get("content_type") == "image/webp")
    if marked:
        with Image.open(io.BytesIO(content)) as image:
            image.load()
            marked = max(image.size) <= 800 and len(content) <= portraits.MAX_OUTPUT_BYTES and not image.getexif()
        marked = marked and hashlib.sha256(content).hexdigest() == stored.get("sha256")
    return assets.FileInput(content, stored["content_type"], Path(stored["object_name"]).suffix, stored.get("filename") or "photo"), marked


def build_plan() -> dict[str, Any]:
    entries = []
    for member in row_store().list("members"):
        reference = str(member.get("photo_url") or "")
        if not reference:
            continue
        entry = {"id": int(member["id"]), "reference_hash": _hash(reference)}
        try:
            file, marked = _source(member)
            entry.update(source_sha256=file.sha256, source_bytes=len(file.content))
            if marked:
                entry["state"] = "normalized"
            else:
                converted = portraits.normalize(file)
                with Image.open(io.BytesIO(converted.content)) as image:
                    entry.update(width=image.width, height=image.height)
                entry.update(state="ready", output_bytes=len(converted.content))
        except UnresolvedReference:
            entry["state"] = "unresolved_reference"
        except FileNotFoundError:
            entry["state"] = "missing_source"
        except Exception as exc:
            from google.api_core.exceptions import NotFound
            entry["state"] = "missing_source" if isinstance(exc, NotFound) else "source_error"
            entry["error_type"] = type(exc).__name__
        entries.append(entry)
    return {"organization": get_current_tenant_id(), "environment_fingerprint": environment_fingerprint(), "profile": portraits.PROFILE, "entries": entries}


async def apply_plan(plan: dict[str, Any], run_id: str) -> dict[str, Any]:
    if (plan.get("organization") != get_current_tenant_id() or plan.get("profile") != portraits.PROFILE
            or plan.get("environment_fingerprint") != environment_fingerprint()):
        raise ValueError("Plan tenant/profile mismatch")
    results = []
    for entry in plan["entries"]:
        member_id = int(entry["id"])
        if entry["state"] != "ready":
            results.append({"id": member_id, "state": entry["state"]})
            continue
        member = row_store().get("members", member_id)
        if not member:
            results.append({"id": member_id, "state": "conflict"})
            continue
        reference = str(member.get("photo_url") or "")
        if _hash(reference) != entry["reference_hash"]:
            # Successful reruns are already normalized; never recompress them.
            try:
                _, marked = _source(member)
            except Exception:
                marked = False
            results.append({"id": member_id, "state": "normalized" if marked else "conflict"})
            continue
        try:
            file, marked = _source(member)
            if marked:
                results.append({"id": member_id, "state": "normalized"})
                continue
            if file.sha256 != entry["source_sha256"]:
                results.append({"id": member_id, "state": "conflict"})
                continue

            def validate(tx: Any) -> None:
                current = row_store().get("members", member_id, ctx=tx.ctx, lock=True)
                if current is None or str(current.get("photo_url") or "") != reference:
                    raise HTTPException(409, "Photo changed after plan")

            def apply(tx: Any, applied: Any) -> tuple[int, dict[str, Any]]:
                # Only the reference + DB-managed version change. An unrelated
                # profile edit during conversion is retained verbatim.
                saved = row_store().update_columns("members", member_id,
                    {"photo_url": applied.url_for(member_id)}, where={"photo_url": reference}, ctx=tx.ctx)
                if saved is None:
                    raise HTTPException(409, "Photo changed after plan")
                applied.commit_reference(tx, member_id)
                return 200, {"id": member_id}

            operation = assets.FileOperation("member_photo", "PUT", member_id, "replace", file,
                {"profile": portraits.PROFILE, "reference_hash": entry["reference_hash"]},
                validate, apply, "admin", portraits.normalize)
            key = assets.migration_operation_id(f"{run_id}:{portraits.PROFILE}:{entry['reference_hash']}", "member_photo", member_id)
            status, _ = await assets.run(operation, {"permission": "システム管理者"}, key, actor=f"migration:{run_id}")
            results.append({"id": member_id, "state": "converted" if status == 200 else "failed", "status": status})
        except Exception as exc:
            results.append({"id": member_id, "state": "failed", "error_type": type(exc).__name__})
    return {"organization": get_current_tenant_id(), "profile": portraits.PROFILE, "results": results}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--organization", required=True)
    parser.add_argument("--output", required=True, help="Plan/report path outside shared source")
    parser.add_argument("--apply-plan")
    parser.add_argument("--run-id", default="member-photo-v1")
    args = parser.parse_args()
    from src.backend import main as _backend  # noqa: F401
    set_current_tenant_id(args.organization)
    report = asyncio.run(apply_plan(json.loads(Path(args.apply_plan).read_text(encoding="utf-8")), args.run_id)) if args.apply_plan else build_plan()
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    entries = report.get("results", report.get("entries", []))
    from collections import Counter
    print(json.dumps(dict(Counter(e["state"] for e in entries))))
    return int(any(e["state"] in {"failed", "source_error", "conflict", "unresolved_reference"} for e in entries))


if __name__ == "__main__":
    raise SystemExit(main())
