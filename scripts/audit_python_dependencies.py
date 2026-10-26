"""Audit the locked Linux runtime, independently of the audit tool's Python."""

import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
PIN = re.compile(r"([A-Za-z0-9][A-Za-z0-9_.-]*)==([A-Za-z0-9_.+!-]+)")


def runtime_python(root: Path) -> str:
    docker = (root / "Dockerfile").read_text(encoding="utf-8")
    match = re.search(r"^FROM python:(\d+\.\d+)-slim\s*$", docker, re.MULTILINE)
    version = (root / ".python-version").read_text(encoding="utf-8").strip()
    if not match or version != match.group(1):
        raise ValueError("Dockerfile and .python-version must agree on runtime Python")
    return version


def pins(text: str, *, universal: bool = False) -> set[tuple[str, str]]:
    result = set()
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if universal:
            line = line.split(";", 1)[0].strip()
        match = PIN.fullmatch(line)
        if not match:
            raise ValueError("Requirements must contain exact package pins only")
        name = re.sub(r"[-_.]+", "-", match.group(1)).lower()
        result.add((name, match.group(2)))
    if not result:
        raise ValueError("Empty runtime requirements; audit refused")
    return result


def run_stage(command: list[str], root: Path) -> subprocess.CompletedProcess:
    # Do not print subprocess diagnostics: configured index URLs can carry secrets.
    result = subprocess.run(command, cwd=root, capture_output=True, timeout=300)
    if result.returncode:
        raise ValueError(f"Dependency preparation failed (exit {result.returncode})")
    return result


def audit(root: Path = ROOT) -> int:
    try:
        version = runtime_python(root)
        uv = shutil.which("uv")
        if not uv:
            raise ValueError("uv is required")
        with tempfile.TemporaryDirectory(prefix="portal-python-audit-") as temporary:
            exported = Path(temporary) / "runtime.txt"
            profile = Path(temporary) / "linux.txt"
            run_stage([
                uv, "export", "--locked", "--no-dev", "--no-emit-project",
                "--no-hashes", "--format", "requirements-txt", "--output-file", str(exported),
            ], root)
            run_stage([
                uv, "pip", "compile", "--no-deps", "--python-version", version,
                "--python-platform", "linux", "--no-header", "--no-annotate",
                str(exported), "--output-file", str(profile),
            ], root)
            expected = pins(exported.read_text(encoding="utf-8"), universal=True)
            selected = pins(profile.read_text(encoding="utf-8"))
            if not selected <= expected:
                raise ValueError("Target profile changed locked package versions")
            print(f"Locked Linux runtime: Python {version}, {len(selected)} packages", flush=True)
            print(f"Requirements SHA256: {hashlib.sha256(profile.read_bytes()).hexdigest()}", flush=True)
            # Tool Python is deliberately separate: patched filelock needs >=3.11.
            # --disable-pip prevents installing the application; never audit uvx's
            # own environment as a fallback when preparation or resolution fails.
            result = subprocess.run([
                uv, "tool", "run", "--python", "3.11", "--with", "filelock>=4.2.1",
                "pip-audit", "--disable-pip", "--no-deps", "--requirement", str(profile),
                "--format", "json",
            ], cwd=root, capture_output=True, timeout=300)
            if result.returncode not in (0, 1):
                raise ValueError(f"Audit tool failed (exit {result.returncode})")
            report = json.loads(result.stdout)
            dependencies = report["dependencies"]
            audited = {(re.sub(r"[-_.]+", "-", item["name"]).lower(), item["version"])
                       for item in dependencies if not item.get("skip_reason")}
            if audited != selected or any(item.get("skip_reason") for item in dependencies):
                raise ValueError("Audit omitted or skipped runtime packages")
            # Package advisory IDs are safe to publish; keep raw JSON out of Git
            # and artifacts. Findings remain failures without an ignore list.
            affected = 0
            for item in dependencies:
                ids = sorted({entry["id"] for entry in item["vulns"]})
                if ids:
                    affected += 1
                    print(f"{item['name']}=={item['version']}: {', '.join(ids)}")
            print(f"Affected packages: {affected}; skipped: 0")
            return 1 if affected else result.returncode
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired) as error:
        # Only controlled messages are emitted; JSON/OS errors can contain paths
        # or upstream output. Never weaken the gate on malformed audit output.
        message = str(error) if type(error) is ValueError else type(error).__name__
        print(f"Python dependency audit failed: {message}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(audit())
