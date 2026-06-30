from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


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
    cmd = ["pg_restore", "--clean", "--if-exists", "--no-owner", "--no-acl", "--dbname", db_url(), str(backup)]
    print("running:", " ".join([cmd[0], "--clean", "--if-exists", "--no-owner", "--no-acl", "--dbname", "<DB_URL>", str(backup)]))
    subprocess.run(cmd, check=True)
    print("restore completed")


if __name__ == "__main__":
    main()
