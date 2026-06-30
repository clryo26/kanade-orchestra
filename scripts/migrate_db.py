from __future__ import annotations

import hashlib
import os
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "db" / "migrations"


def connection_string() -> str:
    if os.getenv("DB_URL", "").strip():
        return os.environ["DB_URL"]
    required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]
    missing = [name for name in required if not os.getenv(name, "").strip()]
    if missing:
        raise SystemExit(f"Missing DB env vars: {', '.join(missing)}")
    return (
        f"host={os.environ['DB_HOST']} "
        f"port={os.getenv('DB_PORT', '5432')} "
        f"dbname={os.environ['DB_NAME']} "
        f"user={os.environ['DB_USER']} "
        f"password={os.environ['DB_PASSWORD']} "
        f"sslmode={os.getenv('DB_SSLMODE', 'disable')}"
    )


def ensure_history(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )


def main() -> None:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        raise SystemExit(f"No migration files found in {MIGRATIONS_DIR}")
    with psycopg.connect(connection_string(), autocommit=False) as conn:
        with conn.cursor() as cur:
            ensure_history(cur)
            cur.execute("SELECT version, checksum FROM schema_migrations")
            applied = {str(row[0]): str(row[1]) for row in cur.fetchall()}
            for path in files:
                version = path.name.split("_", 1)[0]
                sql = path.read_text(encoding="utf-8")
                checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
                if version in applied:
                    if applied[version] != checksum:
                        raise SystemExit(
                            f"Checksum mismatch for migration {path.name}. "
                            "Do not edit applied migrations; create a new migration instead."
                        )
                    print(f"skip {path.name}")
                    continue
                print(f"apply {path.name}")
                cur.execute(sql)
                cur.execute(
                    "INSERT INTO schema_migrations (version, name, checksum) VALUES (%s, %s, %s)",
                    (version, path.name, checksum),
                )
        conn.commit()
    print("DB migrations completed")


if __name__ == "__main__":
    main()
