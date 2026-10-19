"""Migrate legacy inline base64 images (data URLs stored in rows) to confirmed assets.

Dry-run by default. ``--apply`` runs one audited internal file operation per
row (JST spec R06/F02): UUID object key with a create-only precondition, the
row updated only while it still holds the same data URL, and the confirmed
asset reference committed in the same transaction. No fixed-name object and
no whole-list save is used. A re-run with the same ``--run-id`` joins the same
operations (idempotent); rows already migrated are skipped.

Promotions are excluded: they have their own image mechanism.
"""
from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
from typing import Any, Iterable

from src.backend.services.portal_file_asset_service import is_data_image, migrate_inline_image
from src.backend.services.storage_service import load_json_data


@dataclass(frozen=True)
class MigrationTarget:
    collection: str
    field: str
    route_path: str
    kind: str


TARGETS: tuple[MigrationTarget, ...] = (
    MigrationTarget("members", "photo_url", "/api/members/{id}/photo", "member_photo"),
    MigrationTarget("performances", "flyer_image", "/api/performances/{id}/flyer-image", "performance_flyer"),
    MigrationTarget("org_settings", "icon_url", "/api/extra/org_settings/{id}/icon", "org_icon"),
)


def _format_route(template: str, item_id: int) -> str:
    return template.format(id=item_id)


def _migrate_items(target: MigrationTarget, *, apply: bool, run_id: str) -> dict[str, Any]:
    changed: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for item in load_json_data(target.collection):
        item_id = int(item.get("id") or 0)
        current_value = str(item.get(target.field) or "").strip()
        if not item_id or not is_data_image(current_value):
            continue
        entry = {"collection": target.collection, "id": item_id, "field": target.field, "from": current_value[:48]}
        if not apply:
            changed.append({**entry, "to": _format_route(target.route_path, item_id)})
            continue
        status, body = asyncio.run(migrate_inline_image(target.kind, item_id, current_value, run_id=run_id))
        if status == 200:
            changed.append({**entry, "to": body.get("to")})
        else:
            failed.append({**entry, "status": status})
    return {
        "collection": target.collection,
        "field": target.field,
        "migrated": len(changed) if apply else 0,
        "planned": len(changed) if not apply else 0,
        "failed": failed,
        "changes": changed,
    }


def run_migration(*, apply: bool, collections: Iterable[str] | None = None, run_id: str = "manual") -> list[dict[str, Any]]:
    selected = {name for name in collections} if collections else {target.collection for target in TARGETS}
    return [
        _migrate_items(target, apply=apply, run_id=run_id)
        for target in TARGETS
        if target.collection in selected
    ]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="Run the audited file operations.")
    mode.add_argument("--dry-run", action="store_true", help="Show planned changes without writing anything.")
    parser.add_argument("--collections", nargs="*", choices=[target.collection for target in TARGETS])
    parser.add_argument("--run-id", default="manual", help="Migration run identifier (re-use it to resume a run).")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    apply = bool(args.apply) and not bool(args.dry_run)
    results = run_migration(apply=apply, collections=args.collections, run_id=args.run_id)
    exit_code = 0
    for result in results:
        mode = "APPLY" if apply else "DRY-RUN"
        print(f"[{mode}] {result['collection']}: {result['migrated'] or result['planned']} image(s)")
        for change in result["changes"]:
            print(f"  - id={change['id']} field={change['field']} {change['from']} -> {change['to']}")
        for failure in result["failed"]:
            exit_code = 1
            print(f"  ! id={failure['id']} status={failure['status']} (not changed)")
    return exit_code


if __name__ == "__main__":  # pragma: no cover - script entry point
    raise SystemExit(main())
