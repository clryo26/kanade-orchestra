"""Explicit promotion image reconciliation; dry-run unless --execute is given."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--organization", required=True)
    parser.add_argument("--environment", choices=("test", "production", "local"), required=True)
    parser.add_argument("--db-name", required=True)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    from src.backend import main as backend  # noqa: F401
    from src.backend.core.tenant_context import set_current_tenant_id
    from src.backend.repositories import promotion_repository as repo
    from src.backend.services.promotion_image_service import cleanup
    import os
    if os.getenv("APP_ENV", "local") != args.environment or not 1 <= args.limit <= 1000:
        raise SystemExit("Environment or limit mismatch")
    set_current_tenant_id(args.organization)
    if args.environment != "local":
        if repo.local_json_fallback_enabled():
            raise SystemExit("Cloud cleanup requires DB mode")
        with repo.transaction() as cur:
            cur.execute("SELECT current_database() AS name")
            if cur.fetchone()["name"] != args.db_name:
                raise SystemExit("Database identity mismatch")
    result = cleanup(limit=args.limit, execute=args.execute)
    print(json.dumps({"mode": "execute" if args.execute else "dry-run", "candidate_count": len(result)}))


if __name__ == "__main__":
    main()
