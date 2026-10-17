"""One-off promotion reset. An existing run is resumed, never silently replaced."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def verify_maintenance(url, environment):
    if not url.startswith("https://"):
        raise RuntimeError("An HTTPS maintenance URL is required")
    with urllib.request.urlopen(url.rstrip("/") + "/api/health", timeout=15) as response:
        health = json.load(response)
    if environment == "production":
        valid = health.get("mode") == "production-maintenance"
    else:
        valid = health.get("maintenance_mode") == "enabled"
    if not valid:
        raise RuntimeError("The target service is not in maintenance")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=("test", "production"), required=True)
    parser.add_argument("--organization", required=True)
    parser.add_argument("--db-name", required=True)
    parser.add_argument("--maintenance-url", required=True)
    parser.add_argument("--writers-stopped", action="store_true", help="Confirm jobs and old revision requests have drained")
    parser.add_argument("--run-id")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if os.getenv("APP_ENV") != args.environment:
        raise SystemExit("Environment mismatch")
    if args.execute:
        if not args.writers_stopped:
            raise SystemExit("Stop jobs and drain all old writers before executing")
        verify_maintenance(args.maintenance_url, args.environment)
    from src.backend import main as backend  # noqa: F401
    from src.backend.core.tenant_context import set_current_tenant_id
    from src.backend.repositories import promotion_repository as repo
    from src.backend.services import promotion_reset_service as reset
    if repo.local_json_fallback_enabled():
        raise SystemExit("Cloud reset requires DB mode")
    set_current_tenant_id(args.organization)
    with repo.transaction() as cur:
        cur.execute("SELECT current_database() AS name")
        if cur.fetchone()["name"] != args.db_name:
            raise SystemExit("Database identity mismatch")
    environment_id = f"{args.environment}:{args.db_name}:{args.maintenance_url.rstrip('/')}"
    if args.run_id:
        result = reset.resume(args.run_id, environment_id, execute=args.execute)
    else:
        # First execution only prepares the durable manifest. Copy its run_id
        # into the next explicit invocation; no rows/images have been deleted yet.
        result = reset.prepare(environment_id, execute=args.execute)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
