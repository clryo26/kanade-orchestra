"""Check real Docker ignore semantics with synthetic data, never real data.

The minimal scratch image tests the build context alone; application images
need their own build/health check. Only resources created by this run are removed.
"""
from __future__ import annotations

import io
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path
from uuid import uuid4


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    tag = "kanade-context-check:" + uuid4().hex
    container = None
    try:
        with tempfile.TemporaryDirectory(prefix="kanade-context-") as directory:
            context = Path(directory)
            shutil.copyfile(root / ".dockerignore", context / ".dockerignore")
            (context / "Dockerfile").write_text("FROM scratch\nCOPY src /src\n", encoding="utf-8")
            data = context / "src" / "data"
            data.mkdir(parents=True)
            forbidden = ["sheets-local.sqlite3", "sheets-local.sqlite3-wal", "sheets-local.sqlite3-shm",
                         "other.sqlite", "other.sqlite-journal", "other.db", "other.db-journal", "members.json"]
            for name in forbidden:
                (data / name).write_text("SYNTHETIC TEST DATA", encoding="utf-8")
            (context / "src" / "main.js").write_text("// expected source", encoding="utf-8")
            subprocess.run(["docker", "build", "--network=none", "--tag", tag, str(context)], check=True,
                           stdout=subprocess.DEVNULL)
        container = subprocess.check_output(["docker", "create", tag, "/unused"], text=True).strip()
        archive = subprocess.check_output(["docker", "export", container])
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            names = {member.name for member in tar.getmembers()}
        assert "src/main.js" in names, "Expected source was excluded"
        assert not {"src/data/" + name for name in forbidden} & names, "Database/data leaked into Docker context"
        print("[PASS] Docker excludes runtime databases, journals and JSON; source remains included")
    finally:
        if container:
            subprocess.run(["docker", "rm", container], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["docker", "image", "rm", tag], check=False, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
