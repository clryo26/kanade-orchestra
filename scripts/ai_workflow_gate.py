from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
GATE_DIR = ROOT / ".ai-gate"
EVIDENCE_DIR = GATE_DIR / "evidence"

TEXT_SUFFIXES = {
    ".css", ".html", ".js", ".json", ".md", ".ps1", ".py",
    ".sql", ".txt", ".yml", ".yaml",
}

ALLOWED_TEST_KINDS = {
    "pytest",
    "vitest",
    "node_check",
    "python_compile",
    "workflow_static",
    "frontend_full",
    "backend_full",
    "qa_local",
}

FORBIDDEN_PLAN_KEYS = {
    "command", "cmd", "shell", "powershell", "bash", "script",
    "raw_command", "run",
}


class GateReject(RuntimeError):
    pass


@dataclass(frozen=True)
class JobPaths:
    root: Path
    manifest: Path
    plan: Path
    contract: Path | None
    patch: Path | None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def run(
    argv: list[str],
    *,
    cwd: Path | None = None,
    capture: bool = True,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    if not argv:
        raise GateReject("internal error: empty argv")
    if capture:
        proc = subprocess.run(
            argv,
            cwd=cwd or ROOT,
            text=True,
            encoding="utf-8",
            errors="strict",
            capture_output=True,
        )
    else:
        proc = subprocess.run(argv, cwd=cwd or ROOT)
    if check and proc.returncode != 0:
        out = ""
        if capture:
            out = (proc.stdout or "") + (proc.stderr or "")
        raise GateReject(
            f"command failed ({proc.returncode}): {json.dumps(argv, ensure_ascii=False)}\n{out}"
        )
    return proc


def executable(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise GateReject(f"required executable not found: {name}")
    return path


def load_utf8_json(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except FileNotFoundError as exc:
        raise GateReject(f"required file not found: {path}") from exc

    if raw.startswith(b"\xef\xbb\xbf"):
        raise GateReject(f"UTF-8 BOM is forbidden: {path.name}")

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise GateReject(f"UTF-8 decode failed: {path.name}: {exc}") from exc

    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise GateReject(f"JSON parse failed: {path.name}: {exc}") from exc

    if not isinstance(value, dict):
        raise GateReject(f"JSON root must be object: {path.name}")
    return value


def reject_forbidden_keys(value: Any, where: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in FORBIDDEN_PLAN_KEYS:
                raise GateReject(f"raw command/shell field forbidden: {where}.{key}")
            reject_forbidden_keys(child, f"{where}.{key}")
    elif isinstance(value, list):
        for i, child in enumerate(value):
            reject_forbidden_keys(child, f"{where}[{i}]")


def safe_rel_path(value: Any, *, roots: tuple[str, ...]) -> str:
    if not isinstance(value, str) or not value:
        raise GateReject("path must be non-empty string")
    norm = value.replace("\\", "/")
    p = Path(norm)
    if p.is_absolute() or ".." in p.parts:
        raise GateReject(f"path escapes allowed root: {value}")
    if not norm.startswith(roots):
        raise GateReject(f"path outside approved roots {roots}: {value}")
    return norm


def eol_kind(data: bytes) -> str:
    crlf = data.count(b"\r\n")
    lf_total = data.count(b"\n")
    lf_only = lf_total - crlf
    cr_only = data.count(b"\r") - crlf
    if cr_only or (crlf and lf_only):
        return "MIXED"
    if crlf:
        return "CRLF"
    if lf_only:
        return "LF"
    return "NONE"


def git_bytes(ref: str, path: str, *, cwd: Path) -> bytes | None:
    proc = subprocess.run(
        [executable("git"), "show", f"{ref}:{path}"],
        cwd=cwd,
        capture_output=True,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout


def verify_text_file(path: Path, rel: str, *, base_ref: str, cwd: Path) -> dict[str, Any]:
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        raise GateReject(f"UTF-8 BOM forbidden: {rel}")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise GateReject(f"UTF-8 decode failed: {rel}: {exc}") from exc

    current = eol_kind(data)
    if current == "MIXED":
        raise GateReject(f"mixed line endings: {rel}")

    old = git_bytes(base_ref, rel, cwd=cwd)
    old_kind = eol_kind(old) if old is not None else None
    if old_kind in {"LF", "CRLF"} and current != old_kind:
        raise GateReject(f"EOL changed unexpectedly: {rel}: {old_kind} -> {current}")

    return {
        "encoding": "utf-8",
        "bom": False,
        "eol": current,
        "base_eol": old_kind,
    }


def verify_assertions(contract: dict[str, Any], *, cwd: Path) -> None:
    assertions = contract.get("assertions", [])
    if not isinstance(assertions, list):
        raise GateReject("contract.assertions must be list")

    for assertion in assertions:
        if not isinstance(assertion, dict):
            raise GateReject("each assertion must be object")

        rel = safe_rel_path(
            assertion.get("path"),
            roots=("src/", "tests/", ".github/", "scripts/", "db/", "docs/", ".githooks/"),
        )
        full = cwd / rel
        if not full.is_file():
            raise GateReject(f"assertion target missing: {rel}")

        text = full.read_text(encoding="utf-8")

        for token in assertion.get("contains", []):
            if token not in text:
                raise GateReject(f"required token missing: {rel}: {token!r}")

        for token in assertion.get("not_contains", []):
            if token in text:
                raise GateReject(f"forbidden token present: {rel}: {token!r}")

        for sequence in assertion.get("ordered", []):
            if not isinstance(sequence, list) or not sequence:
                raise GateReject(f"ordered assertion must be non-empty list: {rel}")
            pos = -1
            for token in sequence:
                nxt = text.find(token, pos + 1)
                if nxt < 0:
                    raise GateReject(
                        f"ordered token missing/out-of-order: {rel}: {token!r}"
                    )
                pos = nxt

        for pattern in assertion.get("regex", []):
            if re.search(pattern, text, re.MULTILINE | re.DOTALL) is None:
                raise GateReject(f"required regex failed: {rel}: {pattern!r}")

        for pattern in assertion.get("not_regex", []):
            if re.search(pattern, text, re.MULTILINE | re.DOTALL) is not None:
                raise GateReject(f"forbidden regex matched: {rel}: {pattern!r}")


def syntax_check(rel: str, *, cwd: Path) -> None:
    suffix = Path(rel).suffix.lower()

    if suffix == ".py":
        proc = run(
            [sys.executable, "-m", "py_compile", rel],
            cwd=cwd,
            capture=True,
        )
        if proc.returncode:
            raise GateReject(f"Python syntax failed: {rel}\n{proc.stdout}{proc.stderr}")

    elif suffix == ".js":
        proc = run(
            [executable("node"), "--check", rel],
            cwd=cwd,
            capture=True,
        )
        if proc.returncode:
            raise GateReject(f"JavaScript syntax failed: {rel}\n{proc.stdout}{proc.stderr}")

    elif suffix == ".json":
        load_utf8_json(cwd / rel)


def test_argv(test: dict[str, Any]) -> list[str]:
    if not isinstance(test, dict):
        raise GateReject("required test descriptor must be object")

    kind = test.get("kind")
    if kind not in ALLOWED_TEST_KINDS:
        raise GateReject(f"unsupported test kind: {kind!r}")

    if kind == "pytest":
        paths = test.get("paths")
        if not isinstance(paths, list) or not paths:
            raise GateReject("pytest test requires non-empty paths")
        checked = [
            safe_rel_path(p, roots=("tests/",))
            for p in paths
        ]
        if any(not p.endswith(".py") for p in checked):
            raise GateReject("pytest paths must end with .py")
        return [sys.executable, "-m", "pytest", *checked, "-q"]

    if kind == "vitest":
        paths = test.get("paths")
        if not isinstance(paths, list) or not paths:
            raise GateReject("vitest test requires non-empty paths")
        checked = [
            safe_rel_path(p, roots=("tests/frontend/",))
            for p in paths
        ]
        if any(not p.endswith(".js") for p in checked):
            raise GateReject("vitest paths must end with .js")
        npx = executable("npx")
        if os.name == "nt" and Path(npx).suffix.lower() in {".cmd", ".bat"}:
            comspec = os.environ.get("COMSPEC") or shutil.which("cmd.exe")
            if not comspec:
                raise GateReject("cmd.exe required to launch npx on Windows")
            return [comspec, "/d", "/s", "/c", npx, "vitest", "run", *checked]
        return [npx, "vitest", "run", *checked]

    if kind == "node_check":
        rel = safe_rel_path(test.get("path"), roots=("src/", "tests/"))
        if not rel.endswith(".js"):
            raise GateReject("node_check path must end with .js")
        return [executable("node"), "--check", rel]

    if kind == "python_compile":
        rel = safe_rel_path(test.get("path"), roots=("src/", "tests/", "scripts/"))
        if not rel.endswith(".py"):
            raise GateReject("python_compile path must end with .py")
        return [sys.executable, "-m", "py_compile", rel]

    if kind == "workflow_static":
        return [sys.executable, "-m", "pytest", "tests/operations/test_workflow_static.py", "-q"]

    if kind == "frontend_full":
        npx = executable("npm")
        if os.name == "nt" and Path(npx).suffix.lower() in {".cmd", ".bat"}:
            comspec = os.environ.get("COMSPEC") or shutil.which("cmd.exe")
            return [comspec, "/d", "/s", "/c", npx, "run", "test:frontend"]
        return [npx, "run", "test:frontend"]

    if kind == "backend_full":
        return [sys.executable, "-m", "pytest", "-q"]

    if kind == "qa_local":
        npm = executable("npm")
        if os.name == "nt" and Path(npm).suffix.lower() in {".cmd", ".bat"}:
            comspec = os.environ.get("COMSPEC") or shutil.which("cmd.exe")
            return [comspec, "/d", "/s", "/c", npm, "run", "qa:local"]
        return [npm, "run", "qa:local"]

    raise GateReject(f"internal error: unhandled test kind {kind}")


def validate_contract(contract: dict[str, Any]) -> None:
    reject_forbidden_keys(contract)
    if contract.get("version") != 1:
        raise GateReject("contract.version must be 1")
    if not isinstance(contract.get("id"), str) or not contract["id"]:
        raise GateReject("contract.id required")
    if not isinstance(contract.get("goal"), str) or not contract["goal"].strip():
        raise GateReject("contract.goal required")
    allowed = contract.get("allowed_files")
    if not isinstance(allowed, list) or not allowed:
        raise GateReject("contract.allowed_files must be non-empty list")
    for rel in allowed:
        safe_rel_path(
            rel,
            roots=("src/", "tests/", ".github/", "scripts/", "db/", "docs/", ".githooks/"),
        )
    for rel in contract.get("required_changed_files", []):
        safe_rel_path(
            rel,
            roots=("src/", "tests/", ".github/", "scripts/", "db/", "docs/", ".githooks/"),
        )
    tests = contract.get("required_tests", [])
    if not isinstance(tests, list):
        raise GateReject("contract.required_tests must be list")
    for t in tests:
        test_argv(t)


def extract_job(zip_path: Path, temp_dir: Path) -> JobPaths:
    if not zip_path.is_file():
        raise GateReject(f"job bundle not found: {zip_path}")

    try:
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            if not names:
                raise GateReject("job bundle is empty")

            for name in names:
                p = Path(name)
                if p.is_absolute() or ".." in p.parts:
                    raise GateReject(f"unsafe zip path: {name}")

            allowed_names = {
                "manifest.json",
                "plan.json",
                "contract.json",
                "change.patch",
            }
            unexpected = sorted(set(names) - allowed_names)
            if unexpected:
                raise GateReject(f"unexpected file(s) in job bundle: {unexpected}")

            zf.extractall(temp_dir)
    except zipfile.BadZipFile as exc:
        raise GateReject("job bundle is not a valid zip") from exc

    manifest = temp_dir / "manifest.json"
    plan = temp_dir / "plan.json"
    contract = temp_dir / "contract.json"
    patch = temp_dir / "change.patch"

    if not manifest.is_file() or not plan.is_file():
        raise GateReject("job bundle requires manifest.json and plan.json")

    manifest_data = load_utf8_json(manifest)
    if manifest_data.get("version") != 1:
        raise GateReject("manifest.version must be 1")

    hashes = manifest_data.get("sha256")
    if not isinstance(hashes, dict):
        raise GateReject("manifest.sha256 must be object")

    for name, expected in hashes.items():
        if name not in {"plan.json", "contract.json", "change.patch"}:
            raise GateReject(f"manifest hashes unexpected file: {name}")
        path = temp_dir / name
        if not path.is_file():
            raise GateReject(f"manifest references missing file: {name}")
        actual = sha256_file(path)
        if actual != expected:
            raise GateReject(
                f"job bundle hash mismatch: {name}: expected {expected}, got {actual}"
            )

    return JobPaths(
        root=temp_dir,
        manifest=manifest,
        plan=plan,
        contract=contract if contract.is_file() else None,
        patch=patch if patch.is_file() else None,
    )


def validate_plan(plan: dict[str, Any]) -> None:
    reject_forbidden_keys(plan)
    allowed_keys = {
        "version",
        "job_id",
        "purpose",
        "operation",
        "contract_id",
        "commit_message",
    }
    extra = sorted(set(plan) - allowed_keys)
    if extra:
        raise GateReject(f"unsupported plan keys: {extra}")

    if plan.get("version") != 1:
        raise GateReject("plan.version must be 1")

    job_id = plan.get("job_id")
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", job_id):
        raise GateReject("plan.job_id invalid")

    purpose = plan.get("purpose")
    if not isinstance(purpose, str) or not purpose.strip():
        raise GateReject("plan.purpose required")

    if plan.get("operation") not in {
        "inspect",
        "validate_existing_change",
        "apply_change",
        "commit_validated_change",
        "deploy_test",
    }:
        raise GateReject("plan.operation is not approved")


def repo_clean(*, cwd: Path) -> bool:
    proc = run([executable("git"), "status", "--porcelain"], cwd=cwd)
    return not proc.stdout.strip()


def is_gate_runtime_path(rel: str) -> bool:
    normalized = rel.replace("\\", "/")
    return normalized.startswith(".ai-gate/evidence/")


def changed_files(*, cwd: Path, base: str = "HEAD") -> list[str]:
    tracked = run(
        [executable("git"), "diff", "--name-only", base],
        cwd=cwd,
        check=True,
    )
    untracked = run(
        [executable("git"), "ls-files", "--others", "--exclude-standard"],
        cwd=cwd,
        check=True,
    )

    paths = {
        line.strip().replace("\\", "/")
        for output in (tracked.stdout, untracked.stdout)
        for line in output.splitlines()
        if line.strip()
    }
    return sorted(path for path in paths if not is_gate_runtime_path(path))


def worktree_hash(files: list[str], *, cwd: Path) -> str:
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        p = cwd / rel
        if p.is_file():
            h.update(p.read_bytes())
        else:
            h.update(b"<deleted>")
        h.update(b"\0")
    return h.hexdigest()


def verify_change_against_contract(
    contract: dict[str, Any],
    *,
    cwd: Path,
    base_ref: str = "HEAD",
    run_tests: bool = True,
) -> dict[str, Any]:
    validate_contract(contract)
    files = changed_files(cwd=cwd, base=base_ref)
    if not files:
        raise GateReject("no source changes detected")

    allowed = set(rel.replace("\\", "/") for rel in contract["allowed_files"])
    unexpected = sorted(set(files) - allowed)
    if unexpected:
        raise GateReject(f"changed files outside contract: {unexpected}")

    required = set(
        rel.replace("\\", "/")
        for rel in contract.get("required_changed_files", [])
    )
    missing = sorted(required - set(files))
    if missing:
        raise GateReject(f"required changed files missing: {missing}")

    integrity: dict[str, Any] = {}
    for rel in files:
        full = cwd / rel
        if full.exists():
            if full.suffix.lower() in TEXT_SUFFIXES:
                integrity[rel] = verify_text_file(
                    full,
                    rel,
                    base_ref=base_ref,
                    cwd=cwd,
                )
            syntax_check(rel, cwd=cwd)

    verify_assertions(contract, cwd=cwd)

    diff_check = run(
        [
            executable("git"),
            "-c",
            "core.whitespace=trailing-space,space-before-tab,cr-at-eol",
            "diff",
            "--check",
            base_ref,
        ],
        cwd=cwd,
    )
    if diff_check.returncode != 0:
        raise GateReject(
            f"git diff --check failed:\n{diff_check.stdout}{diff_check.stderr}"
        )

    test_results: list[dict[str, Any]] = []
    if run_tests:
        for descriptor in contract.get("required_tests", []):
            argv = test_argv(descriptor)
            proc = run(argv, cwd=cwd, capture=False)
            test_results.append({
                "kind": descriptor["kind"],
                "returncode": proc.returncode,
                "argv": argv,
            })
            if proc.returncode != 0:
                raise GateReject(
                    f"required test failed ({proc.returncode}): {descriptor['kind']}"
                )

    return {
        "files": files,
        "content_hash": worktree_hash(files, cwd=cwd),
        "integrity": integrity,
        "tests": test_results,
    }


def write_evidence(
    *,
    job_id: str,
    contract: dict[str, Any],
    verification: dict[str, Any],
    cwd: Path,
) -> Path:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    evidence_path = EVIDENCE_DIR / f"{job_id}.json"
    payload = {
        "version": 1,
        "job_id": job_id,
        "contract_id": contract["id"],
        "goal": contract["goal"],
        "files": verification["files"],
        "content_hash": verification["content_hash"],
        "integrity": verification["integrity"],
        "tests": verification["tests"],
        "gate": "PASS",
    }
    evidence_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return evidence_path



def validate_existing_change(
    job: JobPaths,
    plan: dict[str, Any],
    *,
    allow_state_change: bool,
) -> None:
    if not allow_state_change:
        raise GateReject("validate_existing_change requires --allow-state-change")
    if job.contract is None:
        raise GateReject("validate_existing_change requires contract.json")
    if job.patch is not None:
        raise GateReject("validate_existing_change must not contain change.patch")

    contract = load_utf8_json(job.contract)
    if plan.get("contract_id") != contract.get("id"):
        raise GateReject("plan.contract_id does not match contract.id")
    validate_contract(contract)

    verification = verify_change_against_contract(
        contract,
        cwd=ROOT,
        base_ref="HEAD",
        run_tests=True,
    )

    evidence = write_evidence(
        job_id=plan["job_id"],
        contract=contract,
        verification=verification,
        cwd=ROOT,
    )

    print("AI_WORKFLOW_GATE=PASS")
    print("OPERATION=validate_existing_change")
    print(f"JOB_ID={plan['job_id']}")
    print(f"EVIDENCE={evidence.relative_to(ROOT)}")
    print(f"CONTENT_HASH={verification['content_hash']}")



def apply_change(job: JobPaths, plan: dict[str, Any], *, allow_state_change: bool) -> None:
    if not allow_state_change:
        raise GateReject("apply_change requires --allow-state-change")
    if job.contract is None or job.patch is None:
        raise GateReject("apply_change requires contract.json and change.patch")

    contract = load_utf8_json(job.contract)
    if plan.get("contract_id") != contract.get("id"):
        raise GateReject("plan.contract_id does not match contract.id")
    validate_contract(contract)

    if not repo_clean(cwd=ROOT):
        raise GateReject("real worktree must be clean before apply_change")

    patch_bytes = job.patch.read_bytes()
    try:
        patch_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise GateReject(f"change.patch is not UTF-8: {exc}") from exc

    with tempfile.TemporaryDirectory(prefix="kanade-ai-v3-") as temp:
        temp_root = Path(temp) / "worktree"

        add = run(
            [executable("git"), "worktree", "add", "--detach", str(temp_root), "HEAD"],
            cwd=ROOT,
        )
        if add.returncode != 0:
            raise GateReject(f"failed to create validation worktree:\n{add.stdout}{add.stderr}")

        try:
            patch_copy = Path(temp) / "change.patch"
            patch_copy.write_bytes(patch_bytes)

            check = run(
                [executable("git"), "apply", "--check", str(patch_copy)],
                cwd=temp_root,
            )
            if check.returncode != 0:
                raise GateReject(
                    f"patch does not apply cleanly:\n{check.stdout}{check.stderr}"
                )

            applied = run(
                [executable("git"), "apply", str(patch_copy)],
                cwd=temp_root,
            )
            if applied.returncode != 0:
                raise GateReject(
                    f"patch failed in validation worktree:\n{applied.stdout}{applied.stderr}"
                )

            verification = verify_change_against_contract(
                contract,
                cwd=temp_root,
                base_ref="HEAD",
                run_tests=True,
            )

            verified_diff = Path(temp) / "verified.patch"
            with verified_diff.open("wb") as fh:
                proc = subprocess.run(
                    [executable("git"), "diff", "--binary", "HEAD"],
                    cwd=temp_root,
                    stdout=fh,
                )
            if proc.returncode != 0:
                raise GateReject("failed to produce verified patch")

            real_check = run(
                [executable("git"), "apply", "--check", str(verified_diff)],
                cwd=ROOT,
            )
            if real_check.returncode != 0:
                raise GateReject(
                    "verified patch no longer applies to real worktree"
                )

            real_apply = run(
                [executable("git"), "apply", str(verified_diff)],
                cwd=ROOT,
            )
            if real_apply.returncode != 0:
                raise GateReject("failed to apply verified patch to real worktree")

            # Recalculate on real worktree before evidence.
            real_verification = verify_change_against_contract(
                contract,
                cwd=ROOT,
                base_ref="HEAD",
                run_tests=False,
            )
            if real_verification["content_hash"] != verification["content_hash"]:
                raise GateReject(
                    "real worktree content hash differs from validated worktree"
                )

            evidence = write_evidence(
                job_id=plan["job_id"],
                contract=contract,
                verification=verification,
                cwd=ROOT,
            )

            print("AI_WORKFLOW_GATE=PASS")
            print("OPERATION=apply_change")
            print(f"JOB_ID={plan['job_id']}")
            print(f"EVIDENCE={evidence.relative_to(ROOT)}")
            print(f"CONTENT_HASH={verification['content_hash']}")

        finally:
            run(
                [executable("git"), "worktree", "remove", "--force", str(temp_root)],
                cwd=ROOT,
            )
            run([executable("git"), "worktree", "prune"], cwd=ROOT)


def evidence_for_job(job_id: str) -> dict[str, Any]:
    path = EVIDENCE_DIR / f"{job_id}.json"
    evidence = load_utf8_json(path)
    if evidence.get("gate") != "PASS":
        raise GateReject("evidence gate is not PASS")
    return evidence


def commit_validated_change(plan: dict[str, Any], *, allow_state_change: bool) -> None:
    if not allow_state_change:
        raise GateReject("commit_validated_change requires --allow-state-change")

    message = plan.get("commit_message")
    if not isinstance(message, str) or not message.strip():
        raise GateReject("commit_message required")
    if "\n" in message or "\r" in message or len(message) > 120:
        raise GateReject("commit_message must be one line <= 120 chars")

    evidence = evidence_for_job(plan["job_id"])
    files = changed_files(cwd=ROOT, base="HEAD")
    if files != evidence.get("files"):
        raise GateReject("current changed files differ from validated evidence")

    current_hash = worktree_hash(files, cwd=ROOT)
    if current_hash != evidence.get("content_hash"):
        raise GateReject("current content hash differs from validated evidence")

    for rel in files:
        run([executable("git"), "add", "--", rel], cwd=ROOT, check=True)

    check = run(
        [
            executable("git"),
            "-c",
            "core.whitespace=trailing-space,space-before-tab,cr-at-eol",
            "diff",
            "--cached",
            "--check",
        ],
        cwd=ROOT,
    )
    if check.returncode != 0:
        raise GateReject(f"staged diff check failed:\n{check.stdout}{check.stderr}")

    commit = run(
        [executable("git"), "commit", "-m", message],
        cwd=ROOT,
    )
    if commit.returncode != 0:
        raise GateReject(f"git commit failed:\n{commit.stdout}{commit.stderr}")

    evidence_path = EVIDENCE_DIR / f"{plan['job_id']}.json"
    if evidence_path.is_file():
        evidence_path.unlink()

    print("AI_WORKFLOW_GATE=PASS")
    print("OPERATION=commit_validated_change")
    print(f"JOB_ID={plan['job_id']}")


def deploy_test(plan: dict[str, Any], *, allow_state_change: bool) -> None:
    if not allow_state_change:
        raise GateReject("deploy_test requires --allow-state-change")

    if not repo_clean(cwd=ROOT):
        raise GateReject("worktree must be clean before deploy_test")

    script = ROOT / "scripts" / "deploy_to_test.ps1"
    if not script.is_file():
        raise GateReject("approved deploy script missing: scripts/deploy_to_test.ps1")

    if os.name == "nt":
        ps = shutil.which("powershell.exe") or shutil.which("powershell")
        if not ps:
            raise GateReject("Windows PowerShell not found")
        argv = [
            ps,
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
        ]
    else:
        pwsh = shutil.which("pwsh")
        if not pwsh:
            raise GateReject("pwsh not found")
        argv = [pwsh, "-NoLogo", "-NoProfile", "-File", str(script)]

    proc = run(argv, cwd=ROOT, capture=False)
    if proc.returncode != 0:
        raise GateReject(f"deploy_test failed ({proc.returncode})")

    print("AI_WORKFLOW_GATE=PASS")
    print("OPERATION=deploy_test")
    print(f"JOB_ID={plan['job_id']}")


def inspect(plan: dict[str, Any]) -> None:
    status = run(
        [executable("git"), "status", "--short", "--branch"],
        cwd=ROOT,
        capture=True,
        check=True,
    )
    head = run(
        [
            executable("git"),
            "show",
            "--no-patch",
            "--format=CommitSHA=%H%nCommitSubject=%s",
            "HEAD",
        ],
        cwd=ROOT,
        capture=True,
        check=True,
    )
    print("AI_WORKFLOW_GATE=PASS")
    print("OPERATION=inspect")
    print(f"JOB_ID={plan['job_id']}")
    print(status.stdout, end="")
    print(head.stdout, end="")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("job_zip", type=Path)
    parser.add_argument("--allow-state-change", action="store_true")
    ns = parser.parse_args()

    try:
        with tempfile.TemporaryDirectory(prefix="kanade-job-v3-") as temp:
            paths = extract_job(ns.job_zip.resolve(), Path(temp))
            plan = load_utf8_json(paths.plan)
            validate_plan(plan)

            op = plan["operation"]
            if op == "inspect":
                inspect(plan)
            elif op == "validate_existing_change":
                validate_existing_change(
                    paths,
                    plan,
                    allow_state_change=ns.allow_state_change,
                )
            elif op == "apply_change":
                apply_change(paths, plan, allow_state_change=ns.allow_state_change)
            elif op == "commit_validated_change":
                commit_validated_change(plan, allow_state_change=ns.allow_state_change)
            elif op == "deploy_test":
                deploy_test(plan, allow_state_change=ns.allow_state_change)
            else:
                raise GateReject(f"unsupported operation: {op}")

        return 0

    except GateReject as exc:
        print("AI_WORKFLOW_GATE=REJECT", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
