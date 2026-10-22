from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import psycopg


def clock_state(dsn: str) -> tuple[bool, str]:
    with psycopg.connect(dsn, autocommit=True, connect_timeout=10,
                         options="-c default_transaction_read_only=on -c statement_timeout=5000") as conn:
        generation, versions = conn.execute("SELECT to_regclass('public.portal_data_generation'), "
                                            "to_regclass('public.portal_collection_versions')").fetchone()
        if bool(generation) != bool(versions):
            raise RuntimeError("Incomplete clock installation; maintenance must remain enabled")
        return bool(generation), conn.execute("SELECT current_database()").fetchone()[0]


def db_url() -> str:
    if os.getenv("DB_URL", "").strip():
        return os.environ["DB_URL"]
    required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]
    missing = [name for name in required if not os.getenv(name, "").strip()]
    if missing:
        raise SystemExit(f"Missing DB env vars: {', '.join(missing)}")
    return (
        f"postgresql://{os.environ['DB_USER']}:{os.environ['DB_PASSWORD']}@"
        f"{os.environ['DB_HOST']}:{os.getenv('DB_PORT', '5432')}/{os.environ['DB_NAME']}"
    )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/restore_db.py path/to/backup.dump")
    backup = Path(sys.argv[1]).resolve()
    if not backup.exists():
        raise SystemExit(f"Backup not found: {backup}")
    dsn = db_url()
    before, database = clock_state(dsn)
    cmd = ["pg_restore", "--clean", "--if-exists", "--no-owner", "--no-acl", "--dbname", dsn, str(backup)]
    print("running:", " ".join([cmd[0], "--clean", "--if-exists", "--no-owner", "--no-acl", "--dbname", "<DB_URL>", str(backup)]))
    subprocess.run(cmd, check=True)
    after, restored_database = clock_state(dsn)
    if database != restored_database or (before and not after):
        raise RuntimeError("Restored clocks are missing; repair and verify before leaving maintenance")
    if after:
        # Finalizer verifies the role/triggers and replaces restored generation.
        # No command line argument or log contains the secret connection string.
        env = dict(os.environ, RESTORE_CLOCK_DB_URL=dsn)
        subprocess.run([sys.executable, str(Path(__file__).with_name("portal_collection_clocks.py")),
                        "finalize", "--dsn-env", "RESTORE_CLOCK_DB_URL", "--expected-database", database,
                        "--environment", os.getenv("APP_ENV", "local") if os.getenv("APP_ENV", "local")
                        in {"local", "test", "production"} else "local", "--execute"], check=True, env=env)
    print("restore completed")


if __name__ == "__main__":
    main()
