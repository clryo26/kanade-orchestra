from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Any, Iterable

from src.backend.services.image_asset_service import (
    delete_stored_image,
    is_data_image,
    store_data_image,
)
from src.backend.services.storage_service import load_json_data, save_json_data


@dataclass(frozen=True)
class MigrationTarget:
    collection: str
    field: str
    route_path: str
    object_prefix: str


TARGETS: tuple[MigrationTarget, ...] = (
    MigrationTarget("members", "photo_url", "/api/members/{id}/photo", "member-images/{id}/photo"),
    MigrationTarget("performances", "flyer_image", "/api/performances/{id}/flyer-image", "performance-flyers/{id}/flyer"),
    MigrationTarget("promotions", "image_url", "/api/extra/promotions/{id}/image", "promotion-images/{id}/image"),
    MigrationTarget("org_settings", "icon_url", "/api/extra/org_settings/{id}/icon", "org-settings/{id}/icon"),
)


def _format_route(template: str, item_id: int) -> str:
    return template.format(id=item_id)


def _migrate_items(target: MigrationTarget, *, apply: bool) -> dict[str, Any]:
    items = [dict(item) for item in load_json_data(target.collection)]
    changed: list[dict[str, Any]] = []
    uploaded_refs: list[tuple[str, str]] = []

    for item in items:
        item_id = int(item.get("id") or 0)
        if not item_id:
            continue
        current_value = str(item.get(target.field) or "").strip()
        if not is_data_image(current_value):
            continue
        proposed_url = _format_route(target.route_path, item_id)
        if not apply:
            changed.append(
                {
                    "collection": target.collection,
                    "id": item_id,
                    "field": target.field,
                    "from": current_value[:48],
                    "to": proposed_url,
                }
            )
            continue

        new_value = store_data_image(
            current_value,
            object_prefix=_format_route(target.object_prefix, item_id),
            route_path=_format_route(target.route_path, item_id),
        )
        item[target.field] = new_value
        uploaded_refs.append((new_value, _format_route(target.object_prefix, item_id)))
        changed.append(
            {
                "collection": target.collection,
                "id": item_id,
                "field": target.field,
                "from": current_value[:48],
                "to": new_value,
            }
        )

    if apply and changed:
        try:
            save_json_data(target.collection, items)
        except Exception:
            for url, object_prefix in uploaded_refs:
                delete_stored_image(url, object_prefix=object_prefix)
            raise

    return {
        "collection": target.collection,
        "field": target.field,
        "migrated": len(changed) if apply else 0,
        "planned": len(changed) if not apply else 0,
        "changes": changed,
    }


def run_migration(*, apply: bool, collections: Iterable[str] | None = None) -> list[dict[str, Any]]:
    selected = {name for name in collections} if collections else {target.collection for target in TARGETS}
    results: list[dict[str, Any]] = []
    for target in TARGETS:
        if target.collection not in selected:
            continue
        results.append(_migrate_items(target, apply=apply))
    return results


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Migrate legacy base64 image payloads to stored image URLs.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="Write migrated image URLs back to storage.")
    mode.add_argument("--dry-run", action="store_true", help="Show planned changes without writing anything.")
    parser.add_argument(
        "--collections",
        nargs="*",
        choices=[target.collection for target in TARGETS],
        help="Limit migration to specific collections.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    apply = bool(args.apply) and not bool(args.dry_run)
    results = run_migration(apply=apply, collections=args.collections)
    for result in results:
        mode = "APPLY" if apply else "DRY-RUN"
        print(f"[{mode}] {result['collection']}: {result['migrated'] or result['planned']} image(s)")
        for change in result["changes"]:
            print(
                f"  - id={change['id']} field={change['field']} "
                f"{change['from']} -> {change['to']}"
            )
    return 0


if __name__ == "__main__":  # pragma: no cover - script entry point
    raise SystemExit(main())
