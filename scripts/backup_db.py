from __future__ import annotations

import os
import subprocess
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKUP_DIR = Path(os.getenv("DB_BACKUP_DIR", ROOT / "db" / "backups"))


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
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output = BACKUP_DIR / f"oke_portal_{stamp}.dump"
    cmd = ["pg_dump", "--format=custom", "--no-owner", "--no-acl", "--file", str(output), db_url()]
    print("running:", " ".join([cmd[0], "--format=custom", "--no-owner", "--no-acl", "--file", str(output), "<DB_URL>"]))
    subprocess.run(cmd, check=True)
    print(f"backup created: {output}")


if __name__ == "__main__":
    main()
