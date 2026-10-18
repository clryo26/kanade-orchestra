"""Explicit sheet storage cleanup (files, ZIP jobs, tickets, old operations).

Dry-run unless --execute is given. The state is in the DB, so a run that
stopped half way continues on the next run; see
docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md (section 2) for the protection rules.
"""
from __future__ import annotations

import argparse
import json
import os
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
    from src.backend.repositories import sheet_repository as repo
    from src.backend.services import sheet_cleanup_service
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
    result = sheet_cleanup_service.run(limit=args.limit, execute=args.execute)
    print(json.dumps({
        "mode": "execute" if args.execute else "dry-run",
        "files": len(result["files"]),
        "files_to_delete": sum(1 for item in result["files"] if "delete" in item),
        "jobs": len(result["jobs"]),
        "records": result["records"],
    }))


if __name__ == "__main__":
    main()
