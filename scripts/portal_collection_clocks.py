"""Private operations CLI: preflight, digest check, finalization and tenant init.

No implicit application DB_URL. Secrets and source rows are never printed.
Writes require an explicit command/target and the separately provisioned role.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

import psycopg

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.backend import app_core as _compat  # noqa: E402,F401
from src.backend.services import collection_clock_maintenance as clocks  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("preflight", "check", "finalize", "init-tenant"))
    parser.add_argument("--dsn-env", default="CLOCK_DB_URL")
    parser.add_argument("--expected-database", required=True)
    parser.add_argument("--environment", choices=("local", "test", "production"), required=True)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--organization")
    parser.add_argument("--application-role", action="store_true")
    parser.add_argument("--allow-uninstalled", action="store_true")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    writing = args.command in {"finalize", "init-tenant"}
    if writing and not args.execute:
        parser.error("Write operations require --execute")
    if args.command == "init-tenant" and not args.organization:
        parser.error("--organization is required")
    dsn = os.getenv(args.dsn_env, "").strip()
    if not dsn:
        parser.error("Explicit operations DSN environment variable is missing")
    state = None
    try:
        with psycopg.connect(dsn, autocommit=False, connect_timeout=10) as conn:
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ" + ("" if writing else " READ ONLY"))
            conn.execute("SET LOCAL statement_timeout='30s'")
            conn.execute("SET LOCAL lock_timeout='5s'")
            if conn.execute("SELECT current_database()").fetchone()[0] != args.expected_database:
                raise RuntimeError("Unexpected operations database")
            if not clocks.installed(conn):
                if not args.allow_uninstalled:
                    raise RuntimeError("Clock migration is not installed")
                print(json.dumps({"status": "not_installed", "environment": args.environment}))
                return 0
            clocks.verify_schema(conn, require_application_role=args.application_role)
            if args.command == "finalize":
                clocks.finalize_generation(conn)
            elif args.command == "init-tenant":
                clocks.initialize_tenant(conn, args.organization)
            if args.command in {"check", "finalize", "init-tenant"}:
                state = clocks.canonical_digests(conn)
                state["environment"] = args.environment
                if args.command == "check" and args.state and args.state.exists():
                    previous = json.loads(args.state.read_text(encoding="utf-8"))
                    if previous.get("environment") != args.environment:
                        raise RuntimeError("Digest state belongs to another environment")
                    clocks.compare_digests(previous, state)
        # Only replace the old evidence after successful inspection AND COMMIT.
        if state is not None and args.state:
            args.state.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.state.with_suffix(args.state.suffix + ".tmp")
            temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
            os.replace(temporary, args.state)
        print(json.dumps({"status": "ok", "command": args.command, "environment": args.environment,
                          "collections": len(state["entries"]) if state else None}))
        return 0
    except Exception as exc:
        # Raw driver messages can contain credentials, hostnames or row data.
        print(f"Collection-clock operation failed ({type(exc).__name__}); maintenance must remain enabled",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
