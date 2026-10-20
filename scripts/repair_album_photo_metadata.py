"""Repair the six known album photo references lost to legacy per-album IDs.

Dry-run by default. Reads two hash-pinned backups in memory, verifies all six
original objects, and inserts only missing references with globally unique IDs.
Never restores a whole DB/table or changes existing photo rows/files/sequences.
Credentials come from the selected Cloud Run service and are never printed.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql

PROJECT = "kanade-orchestra"
REGION = "asia-northeast2"
BACKUPS = (
    ("gs://kanade-storage/neon-migration/kanade_portal.sql",
     "b87faa4c07c216458728bd926428b9cf9fbb4f40bb89e89ee9647f284d1764fb", False),
    ("gs://kanade-storage-test/backups/prod-to-test/4a89ec67-dc15-4625-929d-0f86edd968d9/database/kanade_portal_test.dump",
     "9d1315b12133624a957710c965f7bed997b5abae987c606951da83cfd33ae5c9", True),
)
EXPECTED = {1: 4, 2: 2}


def command(args: list[str], *, content: bytes | None = None) -> bytes:
    result = subprocess.run(args, input=content, capture_output=True, timeout=90)
    if result.returncode:
        # stderr may contain connection details; expose no raw child output.
        raise RuntimeError(f"External command failed: {Path(args[0]).name}")
    return result.stdout


def photo_rows(dump: bytes) -> list[dict[str, Any]]:
    """Parse only PostgreSQL text COPY rows for album_photos (escaped fields)."""
    text = dump.decode("utf-8").replace("\r\n", "\n")
    match = re.search(r"^COPY public\.album_photos \(([^\n]+)\) FROM stdin;\n(.*?)^\\\.$", text, re.M | re.S)
    if not match:
        raise ValueError("Album photo COPY block missing")
    columns = match[1].split(", ")
    # Decode COPY's scalar escapes without interpreting Japanese UTF-8 as bytes.
    escapes = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", "\\": "\\"}

    def value(raw: str) -> str | None:
        if raw == r"\N":
            return None
        return re.sub(r"\\([bfnrtv\\])", lambda m: escapes[m[1]], raw)

    rows = []
    for line in io.StringIO(match[2]):
        cells = line.rstrip("\n").split("\t")
        if len(cells) != len(columns):
            raise ValueError("Malformed photo COPY row")
        row = dict(zip(columns, map(value, cells)))
        row["id"] = int(row["id"])
        row["album_id"] = int(row["album_id"])
        rows.append(row)
    return rows


def recovery_rows(pg_restore: str) -> list[dict[str, Any]]:
    photos: dict[tuple[int, str], dict[str, Any]] = {}
    for uri, checksum, custom in BACKUPS:
        content = command(["gcloud.cmd", "storage", "cat", uri])
        if hashlib.sha256(content).hexdigest() != checksum:
            raise ValueError("Backup SHA-256 mismatch")
        if custom:
            content = command([pg_restore, "--data-only", "--table=album_photos", "--file=-"], content=content)
        for photo in photo_rows(content):
            if photo["album_id"] in EXPECTED:
                key = str(photo.get("object_name") or "")
                if not key.startswith(f"albums/{photo['album_id']}/"):
                    raise ValueError("Unexpected original object reference")
                photos[(photo["album_id"], key)] = photo
    result = sorted(photos.values(), key=lambda p: (p["album_id"], p["object_name"]))
    if dict(Counter(p["album_id"] for p in result)) != EXPECTED:
        raise ValueError("Recovery source counts differ from the known six photos")
    return result


def repair(service: str, photos: list[dict[str, Any]], *, execute: bool) -> dict[str, Any]:
    bucket = "kanade-storage-test" if service.endswith("-test") else "kanade-storage"
    for photo in photos:
        metadata = json.loads(command(["gcloud.cmd", "storage", "objects", "describe", f"gs://{bucket}/{photo['object_name']}", "--format=json"]))
        if int(metadata.get("size", 0)) <= 0:
            raise ValueError("Original photo is empty")
    config = json.loads(command(["gcloud.cmd", "run", "services", "describe", service, "--project", PROJECT, "--region", REGION, "--format=json"]))
    env = {v["name"]: v.get("value", "") for v in config["spec"]["template"]["spec"]["containers"][0].get("env", [])}
    dsn = env.get("DB_URL")
    if not dsn:
        raise ValueError("Selected service has no direct DB_URL")
    with psycopg.connect(dsn, connect_timeout=15) as conn:
        if not execute:
            conn.execute("SET TRANSACTION READ ONLY")
        else:
            # Same allocation lock/order as album_service.upload_album_photo.
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ("portal:id:album_photos",))
        conn.execute("SET LOCAL statement_timeout = '20s'")
        parents = conn.execute("SELECT id, organization_id FROM albums WHERE id IN (1,2) ORDER BY id" + (" FOR UPDATE" if execute else "")).fetchall()
        if {r[0] for r in parents} != {1, 2}:
            raise ValueError("Expected albums missing")
        tenants = dict(parents)
        if len(set(tenants.values())) != 1 or any(str(p.get("organization_id")) != str(tenants[p["album_id"]]) for p in photos):
            raise ValueError("Backup tenant does not match target albums")
        before = conn.execute("SELECT * FROM album_photos ORDER BY id").fetchall()
        columns = [c.name for c in conn.execute("SELECT * FROM album_photos LIMIT 0").description]
        existing = [dict(zip(columns, r)) for r in before]
        wanted = {(p["album_id"], p["object_name"]) for p in photos}
        current = {(p["album_id"], p["object_name"]) for p in existing if p["album_id"] in EXPECTED}
        if current - wanted:
            raise ValueError("Unexpected photos in target albums; stop for review")
        missing = [p for p in photos if (p["album_id"], p["object_name"]) not in current]
        next_id = max((p["id"] for p in existing), default=0) + 1
        plan = {"service": service, "mode": "execute" if execute else "dry-run", "before": dict(Counter(p["album_id"] for p in existing)), "insert_count": len(missing), "new_ids": list(range(next_id, next_id + len(missing)))}
        if execute:
            for offset, source in enumerate(missing):
                row = {**source, "id": next_id + offset}
                row["url"] = f"/api/albums/{row['album_id']}/photos/{row['id']}"
                names = list(row)
                conn.execute(sql.SQL("INSERT INTO album_photos ({}) VALUES ({})").format(
                    sql.SQL(",").join(map(sql.Identifier, names)),
                    sql.SQL(",").join(sql.Placeholder() for _ in names),
                ), [row[n] for n in names])
            # Byte/value comparison of all pre-existing rows, including album 3.
            kept = conn.execute("SELECT * FROM album_photos WHERE id = ANY(%s) ORDER BY id", ([p["id"] for p in existing],)).fetchall()
            if kept != before:
                raise ValueError("Existing photo rows changed; transaction rolled back")
            after = conn.execute("SELECT album_id, COUNT(*) FROM album_photos GROUP BY album_id").fetchall()
            if any(dict(after).get(k) != v for k, v in EXPECTED.items()):
                raise ValueError("Recovery counts mismatch; transaction rolled back")
            plan["after"] = dict(after)
        return plan


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", required=True, choices=("kanade-orchestra", "kanade-orchestra-test"))
    parser.add_argument("--pg-restore", default="pg_restore")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(repair(args.service, recovery_rows(args.pg_restore), execute=args.execute)))
    except Exception as exc:
        # No DB URLs, filenames, member details or child process output in logs.
        raise SystemExit(f"Repair stopped: {type(exc).__name__}") from None


if __name__ == "__main__":
    main()
