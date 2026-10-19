"""Reconcile portal file assets (JST spec R06-A, plan 6.5); dry-run unless --execute.

Deletes only abandoned/retired files after their grace period, re-checking
reference, lease and state under the asset lock, marking ``delete_pending``
before the storage delete, and using the recorded object generation. Same CLI
convention as scripts/cleanup_promotion_images.py.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--organization", required=True)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)

    from src.backend import main as _backend  # noqa: F401  (application import order)
    from src.backend.core.tenant_context import set_current_tenant_id
    from src.backend.services import portal_file_asset_service

    set_current_tenant_id(args.organization)
    result = portal_file_asset_service.cleanup(limit=max(1, min(args.limit, 1000)), execute=args.execute)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
