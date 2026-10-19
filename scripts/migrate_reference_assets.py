"""Fix confirmed references for legacy reference scores and common images (JST spec R06, C03; plan S17).

Two steps, nothing is deleted or rewritten in storage:

1. ``plan`` (read-only): list every row whose file is not yet a confirmed
   asset, with all candidate objects and their identity (key, generation,
   size, time). Every entry starts ``"confirmed": false``. The count of
   candidates is never treated as proof - a single candidate may be an
   interrupted upload.
2. ``apply --manifest``: for entries an operator confirmed with evidence
   (``confirmed: true``, ``chosen_object``, ``chosen_generation``, ``evidence``),
   register the legacy asset after re-verifying the row value, the absence of
   an active asset and the object generation. Writes a report; the
   maintenance release gate requires ``state == "completed"`` (no unresolved
   entries).

Usage (dry-run unless --execute):
  python scripts/migrate_reference_assets.py plan --organization default --output manifest.json
  python scripts/migrate_reference_assets.py apply --organization default --manifest manifest.json \
      --run-id 2026-10-xx-1 --report report.json [--execute]
The manifest/report contain record IDs, object keys and hashes only (no member data).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TARGETS = (
    ("desired_piece_reference_score", "desired_pieces", "reference_score_url"),
    ("member_photo", "members", "photo_url"),
    ("performance_flyer", "performances", "flyer_image"),
    ("org_icon", "org_settings", "icon_url"),
)


def _legacy_image_candidate(kind: str, owner_id: int, value: str) -> str | None:
    from urllib.parse import parse_qs, urlsplit

    from src.backend.services.portal_file_asset_service import LEGACY_IMAGE_PREFIXES

    query = parse_qs(urlsplit(value).query)
    if "asset" in query:
        return None
    ext = str((query.get("ext") or [""])[0]).strip().lstrip(".")
    if not ext:
        return None
    return LEGACY_IMAGE_PREFIXES[kind].format(id=owner_id) + f".{ext}"


def plan(organization: str) -> dict[str, Any]:
    from src.backend import main as _backend  # noqa: F401  (application import order)
    from src.backend.core.compat_gateway import row_store
    from src.backend.core.tenant_context import set_current_tenant_id
    from src.backend.services import portal_file_asset_service as files
    from src.backend.services.desired_piece_asset_service import list_legacy_reference_scores

    set_current_tenant_id(organization)
    entries: list[dict[str, Any]] = []
    store = row_store()
    for kind, collection, field in TARGETS:
        for item in store.list(collection):
            owner_id = int(item.get("id") or 0)
            value = str(item.get(field) or "")
            if not owner_id or not value or files.is_data_image(value) or files.has_active_asset(kind, owner_id):
                continue
            if kind == "desired_piece_reference_score":
                candidates = list_legacy_reference_scores(owner_id)
            else:
                key = _legacy_image_candidate(kind, owner_id, value)
                identity = files.legacy_object_identity(key) if key else None
                candidates = [{"object_name": key, **identity}] if identity else []
            entries.append(
                {
                    "kind": kind, "owner_id": owner_id, "db_value": value, "candidates": candidates,
                    "confirmed": False, "chosen_object": None, "chosen_generation": None, "evidence": "",
                }
            )
    return {"organization": organization, "entries": entries}


TEST_MISSING_SCOPE = "test-existing-member-photo-404"


def _accepted_test_missing(organization: str, manifest: dict[str, Any], enabled: bool) -> list[dict[str, Any]]:
    """The 2026-10-19 operator decision accepts exactly three existing TEST 404s.

    Re-plan against the current DB/storage before accepting the exception. It
    never creates assets, deletes references, or applies to production.
    """
    policy = manifest.get("test_missing_reference_acceptance")
    if not policy:
        return []
    if (
        not enabled or os.getenv("APP_ENV") != "test"
        or os.getenv("CLOUD_RUN_SERVICE") != "kanade-orchestra-test"
        or policy.get("scope") != TEST_MISSING_SCOPE or policy.get("approved") is not True
        or not str(policy.get("approval_reference") or "").strip()
    ):
        raise SystemExit("Missing-reference acceptance requires explicit TEST-only approval")
    entries = manifest.get("entries", [])
    current = plan(organization)["entries"]
    def key(entry: dict[str, Any]) -> tuple[Any, Any, Any]:
        return (entry["kind"], entry["owner_id"], entry["db_value"])
    if len(entries) != 3 or len(current) != 3 or {key(e) for e in entries} != {key(e) for e in current}:
        raise SystemExit("TEST missing-reference set changed; stop for review")
    current_by_key = {key(e): e for e in current}
    accepted = []
    for entry in entries:
        object_name = _legacy_image_candidate(entry["kind"], entry["owner_id"], entry["db_value"])
        if (
            entry["kind"] != "member_photo" or entry.get("accepted_missing") is not True
            or not object_name or entry.get("object_name") != object_name
            or current_by_key[key(entry)]["candidates"]
            or entry.get("preexisting_http_status") != 404
            or entry.get("noncurrent_versions") != 0 or entry.get("soft_deleted_versions") != 0
        ):
            raise SystemExit("TEST missing-reference evidence is incomplete or changed")
        accepted.append({"kind": "member_photo", "owner_id": entry["owner_id"], "object_name": object_name,
                         "db_reference_preserved": True, "checked_missing": True})
    return accepted


def apply(organization: str, manifest: dict[str, Any], run_id: str, execute: bool,
          *, accept_test_missing_photos: bool = False) -> dict[str, Any]:
    from src.backend import main as _backend  # noqa: F401
    from src.backend.core.tenant_context import set_current_tenant_id
    from src.backend.services import portal_file_asset_service as files

    if manifest.get("organization") != organization:
        raise SystemExit("Manifest organization mismatch")
    set_current_tenant_id(organization)
    accepted_missing = _accepted_test_missing(organization, manifest, accept_test_missing_photos)
    applied: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    unresolved = 0
    for entry in manifest.get("entries", []):
        if accepted_missing:
            continue  # The exact three entries were rechecked; preserve their URLs.
        chosen = entry.get("chosen_object")
        if not entry.get("confirmed") or not chosen or not str(entry.get("evidence") or "").strip():
            unresolved += 1
            continue
        if chosen not in {candidate.get("object_name") for candidate in entry.get("candidates", [])}:
            errors.append({"kind": entry["kind"], "owner_id": entry["owner_id"], "detail": "chosen object is not a listed candidate"})
            continue
        if not execute:
            applied.append({"kind": entry["kind"], "owner_id": entry["owner_id"], "mode": "dry-run"})
            continue
        status, body = files.register_legacy_asset(
            entry["kind"], int(entry["owner_id"]), db_value=entry["db_value"], object_name=chosen,
            generation=entry.get("chosen_generation"), evidence=str(entry["evidence"]), run_id=run_id,
        )
        (applied if status == 200 else errors).append({"kind": entry["kind"], "owner_id": entry["owner_id"], "status": status, **body})
    complete = execute and unresolved == 0 and not errors
    report = {"state": "completed" if complete else "incomplete", "run_id": run_id, "unresolved": unresolved,
              "applied": applied, "errors": errors, "executed": execute, "accepted_missing": accepted_missing}
    if accepted_missing:
        report.update(environment="test", exception_scope=TEST_MISSING_SCOPE,
                      approval_reference=manifest["test_missing_reference_acceptance"]["approval_reference"])
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=("plan", "apply"))
    parser.add_argument("--organization", required=True)
    parser.add_argument("--output")
    parser.add_argument("--manifest")
    parser.add_argument("--report")
    parser.add_argument("--run-id")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--accept-test-missing-photos", action="store_true",
                        help="accept the approved three existing TEST 404s after rechecking the exact manifest")
    args = parser.parse_args(argv)
    if args.action == "plan":
        result = plan(args.organization)
        text = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output:
            Path(args.output).write_text(text, encoding="utf-8")
        print(json.dumps({"entries": len(result["entries"])}))
        return 0
    if not args.manifest or not args.run_id:
        raise SystemExit("apply requires --manifest and --run-id")
    report = apply(args.organization, json.loads(Path(args.manifest).read_text(encoding="utf-8")), args.run_id, args.execute,
                   accept_test_missing_photos=args.accept_test_missing_photos)
    if args.report:
        Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("state", "unresolved", "executed")}))
    return 0 if report["state"] == "completed" or not args.execute else 1


if __name__ == "__main__":
    raise SystemExit(main())
