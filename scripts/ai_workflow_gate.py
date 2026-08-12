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
    env: dict[str, str] | None = None,
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
            env=env,
        )
    else:
        proc = subprocess.run(argv, cwd=cwd or ROOT, env=env)
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


def local_node_bin_argv(package_name: str, bin_name: str, *args: str) -> list[str]:
    package_json = ROOT / "node_modules" / package_name / "package.json"
    if not package_json.is_file():
        raise GateReject(f"required Node package not found: {package_name}")

    package = load_utf8_json(package_json)
    bin_value = package.get("bin")
    if isinstance(bin_value, str):
        rel = bin_value
    elif isinstance(bin_value, dict):
        rel = bin_value.get(bin_name)
    else:
        rel = None

    if not isinstance(rel, str) or not rel:
        raise GateReject(f"Node package bin not found: {package_name}:{bin_name}")

    cli = (package_json.parent / rel).resolve()
    package_root = package_json.parent.resolve()
    try:
        cli.relative_to(package_root)
    except ValueError as exc:
        raise GateReject(f"Node package bin escapes package root: {package_name}:{bin_name}") from exc

    if not cli.is_file():
        raise GateReject(f"Node package bin file not found: {cli}")

    return [executable("node"), str(cli), *args]


def npm_argv(*args: str) -> list[str]:
    npm = Path(executable("npm"))
    if npm.suffix.lower() in {".cmd", ".bat"}:
        cli = npm.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
        if not cli.is_file():
            raise GateReject(f"npm CLI file not found: {cli}")
        return [executable("node"), str(cli), *args]
    return [str(npm), *args]


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


def validate_next_action(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GateReject("plan.next_action required")

    allowed_keys = {"instruction", "expected_result", "state_change"}
    extra = sorted(set(value) - allowed_keys)
    if extra:
        raise GateReject(f"unsupported next_action keys: {extra}")

    instruction = value.get("instruction")
    expected_result = value.get("expected_result")
    state_change = value.get("state_change")

    if not isinstance(instruction, str) or not instruction.strip():
        raise GateReject("plan.next_action.instruction required")
    if not isinstance(expected_result, str) or not expected_result.strip():
        raise GateReject("plan.next_action.expected_result required")
    if not isinstance(state_change, bool):
        raise GateReject("plan.next_action.state_change must be boolean")

    for field_name, text in (
        ("instruction", instruction),
        ("expected_result", expected_result),
    ):
        if "\n" in text or "\r" in text:
            raise GateReject(f"plan.next_action.{field_name} must be one line")
        if len(text) > 500:
            raise GateReject(f"plan.next_action.{field_name} is too long")

    return value


def print_next_action(plan: dict[str, Any]) -> None:
    next_action = validate_next_action(plan.get("next_action"))
    print("NEXT_ACTION_REQUIRED=1")
    print(f"NEXT_ACTION_INSTRUCTION={next_action['instruction']}")
    print(f"NEXT_ACTION_EXPECTED_RESULT={next_action['expected_result']}")
    print(
        "NEXT_ACTION_STATE_CHANGE="
        + ("true" if next_action["state_change"] else "false")
    )


def print_failure_next_action() -> None:
    print("NEXT_ACTION_REQUIRED=1", file=sys.stderr)
    print(
        "NEXT_ACTION_INSTRUCTION=Paste the complete output into ChatGPT. "
        "Do not run another repository-changing operation until a concrete next step is provided.",
        file=sys.stderr,
    )
    print(
        "NEXT_ACTION_EXPECTED_RESULT=The failure is reviewed and the next required concrete operation is provided.",
        file=sys.stderr,
    )
    print("NEXT_ACTION_STATE_CHANGE=false", file=sys.stderr)


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


def test_argv(
    test: dict[str, Any],
    *,
    cwd: Path | None = None,
) -> list[str]:
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
        argv = local_node_bin_argv("vitest", "vitest", "run")
        if cwd is not None:
            config = ROOT / "vitest.config.js"
            if not config.is_file():
                raise GateReject(f"Vitest config not found: {config}")
            argv.extend([
                "--root",
                str(cwd),
                "--config",
                str(config),
            ])
        argv.extend(checked)
        return argv

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
        return npm_argv("run", "test:frontend")

    if kind == "backend_full":
        return [sys.executable, "-m", "pytest", "-q"]

    if kind == "qa_local":
        return npm_argv("run", "qa:local")

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
        "next_action",
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

    validate_next_action(plan.get("next_action"))


def repo_clean(*, cwd: Path) -> bool:
    proc = run([executable("git"), "status", "--porcelain"], cwd=cwd)
    return not proc.stdout.strip()


def publish_guard_token() -> str:
    proc = run(
        [executable("git"), "rev-parse", "--git-common-dir"],
        cwd=ROOT,
        capture=True,
        check=True,
    )
    common_dir_raw = proc.stdout.strip()
    if not common_dir_raw:
        raise GateReject("Git common directory is empty")

    common_dir = Path(common_dir_raw)
    if not common_dir.is_absolute():
        common_dir = (ROOT / common_dir).resolve()

    token_path = common_dir / "kanade-ai-publish-token"
    try:
        token = token_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise GateReject(
            "publish guard token is missing; run through scripts/run_ai_job.ps1"
        ) from exc

    if re.fullmatch(r"[0-9a-f]{64}", token) is None:
        raise GateReject("publish guard token is invalid")
    return token


def require_runner_authorization() -> None:
    expected = publish_guard_token()
    actual = os.environ.get("KANADE_AI_RUNNER_TOKEN", "")
    if not actual or actual != expected:
        raise GateReject(
            "state-changing AI jobs must run through scripts/run_ai_job.ps1"
        )


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
            "core.whitespace=trailing-space,space-before-tab",
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
            argv = test_argv(descriptor, cwd=cwd)
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
            [executable("git"), "-c", "core.autocrlf=false", "worktree", "add", "--detach", str(temp_root), "HEAD"],
            cwd=ROOT,
        )
        if add.returncode != 0:
            raise GateReject(f"failed to create validation worktree:\n{add.stdout}{add.stderr}")

        try:
            patch_copy = Path(temp) / "change.patch"
            patch_copy.write_bytes(patch_bytes)

            check = run(
                [executable("git"), "-c", "core.autocrlf=false", "apply", "--check", str(patch_copy)],
                cwd=temp_root,
            )
            if check.returncode != 0:
                raise GateReject(
                    f"patch does not apply cleanly:\n{check.stdout}{check.stderr}"
                )

            applied = run(
                [executable("git"), "-c", "core.autocrlf=false", "apply", str(patch_copy)],
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
                    [executable("git"), "-c", "core.autocrlf=false", "diff", "--binary", "HEAD"],
                    cwd=temp_root,
                    stdout=fh,
                )
            if proc.returncode != 0:
                raise GateReject("failed to produce verified patch")

            real_check = run(
                [executable("git"), "-c", "core.autocrlf=false", "apply", "--check", str(verified_diff)],
                cwd=ROOT,
            )
            if real_check.returncode != 0:
                raise GateReject(
                    "verified patch no longer applies to real worktree"
                )

            real_apply = run(
                [executable("git"), "-c", "core.autocrlf=false", "apply", str(verified_diff)],
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
            "core.whitespace=trailing-space,space-before-tab",
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

    deploy_env = os.environ.copy()
    deploy_env["KANADE_AI_PUBLISH_TOKEN"] = publish_guard_token()
    proc = run(argv, cwd=ROOT, capture=False, env=deploy_env)
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

            if ns.allow_state_change:
                require_runner_authorization()

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

            print_next_action(plan)

        return 0

    except GateReject as exc:
        print("AI_WORKFLOW_GATE=REJECT", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        print_failure_next_action()
        return 2
    except Exception as exc:  # pragma: no cover - fail-closed safety net
        print("AI_WORKFLOW_GATE=ERROR", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        print_failure_next_action()
        return 3


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

FORBIDDEN_KEYS = {
    "command", "cmd", "shell", "powershell", "bash", "script",
    "raw_command", "run", "patch", "diff",
}

ALLOWED_OPERATION_TYPES = {
    "replace_exact",
    "insert_before_exact",
    "insert_after_exact",
    "delete_exact",
    "create_text_file",
}

REQUIRED_POST_CHECKS = {
    "encoding_eol",
    "syntax",
    "contract",
    "diff",
    "tests",
}

PROTECTED_GATE_PATHS = {
    "scripts/ai_workflow_gate.py",
    "scripts/run_ai_job.ps1",
    ".githooks/pre-commit",
    "tests/operations/test_ai_workflow_gate.py",
    "tests/operations/test_ai_workflow_execution_guards.py",
}

BOOTSTRAP_LEGACY_JOB_ID = "bootstrap-json-only-gate-v4-20260812"
BOOTSTRAP_LEGACY_CONTRACT_ID = "bootstrap-json-only-gate-v4"
BOOTSTRAP_LEGACY_FILES = {
    "scripts/ai_workflow_gate.py",
    "tests/operations/test_ai_workflow_gate.py",
}


class GateReject(RuntimeError):
    pass


@dataclass(frozen=True)
class JobPaths:
    root: Path
    manifest: Path
    plan: Path
    contract: Path | None
    operations: Path | None


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
    env: dict[str, str] | None = None,
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
            env=env,
        )
    else:
        proc = subprocess.run(argv, cwd=cwd or ROOT, env=env)
    if check and proc.returncode != 0:
        output = ""
        if capture:
            output = (proc.stdout or "") + (proc.stderr or "")
        raise GateReject(
            f"command failed ({proc.returncode}): "
            f"{json.dumps(argv, ensure_ascii=False)}\n{output}"
        )
    return proc


def executable(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise GateReject(f"required executable not found: {name}")
    return path


def npm_argv(*args: str) -> list[str]:
    npm = Path(executable("npm"))
    if npm.suffix.lower() in {".cmd", ".bat"}:
        cli = npm.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
        if not cli.is_file():
            raise GateReject(f"npm CLI file not found: {cli}")
        return [executable("node"), str(cli), *args]
    return [str(npm), *args]


def local_node_bin_argv(
    package_name: str,
    bin_name: str,
    *args: str,
) -> list[str]:
    package_json = ROOT / "node_modules" / package_name / "package.json"
    if not package_json.is_file():
        raise GateReject(f"required Node package not found: {package_name}")

    package = load_utf8_json(package_json)
    bin_value = package.get("bin")
    if isinstance(bin_value, str):
        rel = bin_value
    elif isinstance(bin_value, dict):
        rel = bin_value.get(bin_name)
    else:
        rel = None

    if not isinstance(rel, str) or not rel:
        raise GateReject(
            f"Node package bin not found: {package_name}:{bin_name}"
        )

    cli = (package_json.parent / rel).resolve()
    package_root = package_json.parent.resolve()
    try:
        cli.relative_to(package_root)
    except ValueError as exc:
        raise GateReject(
            f"Node package bin escapes package root: {package_name}:{bin_name}"
        ) from exc

    if not cli.is_file():
        raise GateReject(f"Node package bin file not found: {cli}")

    return [executable("node"), str(cli), *args]


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
        raise GateReject(
            f"UTF-8 decode failed: {path.name}: {exc}"
        ) from exc

    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise GateReject(
            f"JSON parse failed: {path.name}: {exc}"
        ) from exc

    if not isinstance(value, dict):
        raise GateReject(f"JSON root must be object: {path.name}")
    return value


def reject_forbidden_keys(value: Any, where: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in FORBIDDEN_KEYS:
                raise GateReject(
                    f"raw command/shell field forbidden: {where}.{key}"
                )
            reject_forbidden_keys(child, f"{where}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_forbidden_keys(child, f"{where}[{index}]")


def safe_rel_path(value: Any, *, roots: tuple[str, ...]) -> str:
    if not isinstance(value, str) or not value:
        raise GateReject("path must be non-empty string")
    normalized = value.replace("\\", "/")
    path = Path(normalized)
    if path.is_absolute() or ".." in path.parts:
        raise GateReject(f"path escapes allowed root: {value}")
    if not normalized.startswith(roots):
        raise GateReject(
            f"path outside approved roots {roots}: {value}"
        )
    return normalized


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


def decode_text_file(data: bytes, *, rel: str) -> tuple[str, str]:
    if data.startswith(b"\xef\xbb\xbf"):
        raise GateReject(f"UTF-8 BOM forbidden: {rel}")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise GateReject(f"UTF-8 decode failed: {rel}: {exc}") from exc

    kind = eol_kind(data)
    if kind == "MIXED":
        raise GateReject(f"mixed line endings: {rel}")

    if kind == "CRLF":
        text = text.replace("\r\n", "\n")
    elif "\r" in text:
        raise GateReject(f"unexpected carriage return: {rel}")

    return text, kind


def encode_text_file(text: str, *, eol: str, rel: str) -> bytes:
    if "\r" in text:
        raise GateReject(
            f"operation text must use LF newlines only: {rel}"
        )

    if eol == "CRLF":
        rendered = text.replace("\n", "\r\n")
    elif eol == "LF":
        rendered = text
    elif eol == "NONE":
        if "\n" in text:
            raise GateReject(
                f"cannot introduce newline into no-EOL file: {rel}"
            )
        rendered = text
    else:
        raise GateReject(f"unsupported EOL kind: {rel}: {eol!r}")

    return rendered.encode("utf-8")


def git_bytes(ref: str, path: str, *, cwd: Path) -> bytes | None:
    proc = subprocess.run(
        [executable("git"), "show", f"{ref}:{path}"],
        cwd=cwd,
        capture_output=True,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout


def git_head(*, cwd: Path) -> str:
    proc = run(
        [executable("git"), "rev-parse", "HEAD"],
        cwd=cwd,
        check=True,
    )
    value = proc.stdout.strip()
    if re.fullmatch(r"[0-9a-f]{40}", value) is None:
        raise GateReject(f"invalid HEAD commit: {value!r}")
    return value


def git_branch(*, cwd: Path) -> str:
    proc = run(
        [executable("git"), "symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd=cwd,
    )
    value = proc.stdout.strip()
    if proc.returncode != 0 or not value:
        raise GateReject("state-changing AI jobs require a named branch")
    return value


def repo_clean(*, cwd: Path) -> bool:
    proc = run(
        [executable("git"), "status", "--porcelain"],
        cwd=cwd,
        check=True,
    )
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
    return sorted(
        path for path in paths if not is_gate_runtime_path(path)
    )


def worktree_hash(files: list[str], *, cwd: Path) -> str:
    digest = hashlib.sha256()
    for rel in sorted(files):
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        path = cwd / rel
        if path.is_file():
            digest.update(path.read_bytes())
        else:
            digest.update(b"<deleted>")
        digest.update(b"\0")
    return digest.hexdigest()


def verify_text_file(
    path: Path,
    rel: str,
    *,
    base_ref: str,
    cwd: Path,
) -> dict[str, Any]:
    data = path.read_bytes()
    _, current = decode_text_file(data, rel=rel)

    old = git_bytes(base_ref, rel, cwd=cwd)
    old_kind = eol_kind(old) if old is not None else None
    if old_kind == "MIXED":
        raise GateReject(f"base file has mixed line endings: {rel}")
    if old_kind in {"LF", "CRLF", "NONE"} and current != old_kind:
        raise GateReject(
            f"EOL changed unexpectedly: {rel}: {old_kind} -> {current}"
        )

    return {
        "encoding": "utf-8",
        "bom": False,
        "eol": current,
        "base_eol": old_kind,
    }


def syntax_check(rel: str, *, cwd: Path) -> None:
    suffix = Path(rel).suffix.lower()
    if suffix == ".py":
        proc = run(
            [sys.executable, "-m", "py_compile", rel],
            cwd=cwd,
        )
        if proc.returncode:
            raise GateReject(
                f"Python syntax failed: {rel}\n"
                f"{proc.stdout}{proc.stderr}"
            )
    elif suffix == ".js":
        proc = run(
            [executable("node"), "--check", rel],
            cwd=cwd,
        )
        if proc.returncode:
            raise GateReject(
                f"JavaScript syntax failed: {rel}\n"
                f"{proc.stdout}{proc.stderr}"
            )
    elif suffix == ".json":
        load_utf8_json(cwd / rel)


def test_argv(
    descriptor: dict[str, Any],
    *,
    cwd: Path | None = None,
) -> list[str]:
    if not isinstance(descriptor, dict):
        raise GateReject("required test descriptor must be object")

    kind = descriptor.get("kind")
    if kind not in ALLOWED_TEST_KINDS:
        raise GateReject(f"unsupported test kind: {kind!r}")

    if kind == "pytest":
        paths = descriptor.get("paths")
        if not isinstance(paths, list) or not paths:
            raise GateReject("pytest test requires non-empty paths")
        checked = [
            safe_rel_path(path, roots=("tests/",))
            for path in paths
        ]
        if any(not path.endswith(".py") for path in checked):
            raise GateReject("pytest paths must end with .py")
        return [sys.executable, "-m", "pytest", *checked, "-q"]

    if kind == "vitest":
        paths = descriptor.get("paths")
        if not isinstance(paths, list) or not paths:
            raise GateReject("vitest test requires non-empty paths")
        checked = [
            safe_rel_path(path, roots=("tests/frontend/",))
            for path in paths
        ]
        if any(not path.endswith(".js") for path in checked):
            raise GateReject("vitest paths must end with .js")
        argv = local_node_bin_argv("vitest", "vitest", "run")
        if cwd is not None:
            config = ROOT / "vitest.config.js"
            if not config.is_file():
                raise GateReject(
                    f"Vitest config not found: {config}"
                )
            argv.extend(
                ["--root", str(cwd), "--config", str(config)]
            )
        argv.extend(checked)
        return argv

    if kind == "node_check":
        rel = safe_rel_path(
            descriptor.get("path"),
            roots=("src/", "tests/"),
        )
        if not rel.endswith(".js"):
            raise GateReject("node_check path must end with .js")
        return [executable("node"), "--check", rel]

    if kind == "python_compile":
        rel = safe_rel_path(
            descriptor.get("path"),
            roots=("src/", "tests/", "scripts/"),
        )
        if not rel.endswith(".py"):
            raise GateReject("python_compile path must end with .py")
        return [sys.executable, "-m", "py_compile", rel]

    if kind == "workflow_static":
        return [
            sys.executable,
            "-m",
            "pytest",
            "tests/operations/test_workflow_static.py",
            "-q",
        ]

    if kind == "frontend_full":
        return npm_argv("run", "test:frontend")

    if kind == "backend_full":
        return [sys.executable, "-m", "pytest", "-q"]

    if kind == "qa_local":
        return npm_argv("run", "qa:local")

    raise GateReject(f"internal error: unhandled test kind {kind}")


def verify_assertions(
    contract: dict[str, Any],
    *,
    cwd: Path,
) -> None:
    assertions = contract.get("assertions", [])
    if not isinstance(assertions, list):
        raise GateReject("contract.assertions must be list")

    for assertion in assertions:
        if not isinstance(assertion, dict):
            raise GateReject("each assertion must be object")

        rel = safe_rel_path(
            assertion.get("path"),
            roots=(
                "src/",
                "tests/",
                ".github/",
                "scripts/",
                "db/",
                "docs/",
                ".githooks/",
            ),
        )
        full = cwd / rel
        if not full.is_file():
            raise GateReject(f"assertion target missing: {rel}")

        text = full.read_text(encoding="utf-8")

        for token in assertion.get("contains", []):
            if token not in text:
                raise GateReject(
                    f"required token missing: {rel}: {token!r}"
                )

        for token in assertion.get("not_contains", []):
            if token in text:
                raise GateReject(
                    f"forbidden token present: {rel}: {token!r}"
                )

        for sequence in assertion.get("ordered", []):
            if not isinstance(sequence, list) or not sequence:
                raise GateReject(
                    f"ordered assertion must be non-empty list: {rel}"
                )
            position = -1
            for token in sequence:
                next_position = text.find(token, position + 1)
                if next_position < 0:
                    raise GateReject(
                        f"ordered token missing/out-of-order: "
                        f"{rel}: {token!r}"
                    )
                position = next_position

        for pattern in assertion.get("regex", []):
            if re.search(
                pattern,
                text,
                re.MULTILINE | re.DOTALL,
            ) is None:
                raise GateReject(
                    f"required regex failed: {rel}: {pattern!r}"
                )

        for pattern in assertion.get("not_regex", []):
            if re.search(
                pattern,
                text,
                re.MULTILINE | re.DOTALL,
            ) is not None:
                raise GateReject(
                    f"forbidden regex matched: {rel}: {pattern!r}"
                )


def validate_contract(contract: dict[str, Any]) -> None:
    reject_forbidden_keys(contract)
    if contract.get("version") != 1:
        raise GateReject("contract.version must be 1")
    if not isinstance(contract.get("id"), str) or not contract["id"]:
        raise GateReject("contract.id required")
    if (
        not isinstance(contract.get("goal"), str)
        or not contract["goal"].strip()
    ):
        raise GateReject("contract.goal required")

    allowed = contract.get("allowed_files")
    if not isinstance(allowed, list) or not allowed:
        raise GateReject(
            "contract.allowed_files must be non-empty list"
        )

    roots = (
        "src/",
        "tests/",
        ".github/",
        "scripts/",
        "db/",
        "docs/",
        ".githooks/",
    )
    for rel in allowed:
        safe_rel_path(rel, roots=roots)
    for rel in contract.get("required_changed_files", []):
        safe_rel_path(rel, roots=roots)

    tests = contract.get("required_tests", [])
    if not isinstance(tests, list):
        raise GateReject("contract.required_tests must be list")
    for descriptor in tests:
        test_argv(descriptor)


def validate_contract_scope(
    contract: dict[str, Any],
    *,
    policy_update: bool,
) -> None:
    validate_contract(contract)
    allowed = {
        str(rel).replace("\\", "/")
        for rel in contract["allowed_files"]
    }
    required = {
        str(rel).replace("\\", "/")
        for rel in contract.get("required_changed_files", [])
    }
    if not required:
        raise GateReject(
            "contract.required_changed_files must be non-empty"
        )

    if policy_update:
        outside = sorted(allowed - PROTECTED_GATE_PATHS)
        if outside:
            raise GateReject(
                "policy_update may only modify protected gate paths: "
                f"{outside}"
            )

        pytest_paths: set[str] = set()
        for descriptor in contract.get("required_tests", []):
            if descriptor.get("kind") == "pytest":
                pytest_paths.update(
                    str(path).replace("\\", "/")
                    for path in descriptor.get("paths", [])
                )
        required_policy_tests = {
            "tests/operations/test_ai_workflow_gate.py",
            "tests/operations/test_ai_workflow_execution_guards.py",
        }
        missing_policy_tests = sorted(required_policy_tests - pytest_paths)
        if missing_policy_tests:
            raise GateReject(
                "policy_update requires gate tests: "
                f"{missing_policy_tests}"
            )
    else:
        protected = sorted(allowed & PROTECTED_GATE_PATHS)
        if protected:
            raise GateReject(
                "apply_change cannot modify protected gate paths: "
                f"{protected}"
            )


def validate_next_action(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GateReject("plan.next_action required")

    allowed_keys = {
        "instruction",
        "expected_result",
        "state_change",
    }
    extra = sorted(set(value) - allowed_keys)
    if extra:
        raise GateReject(
            f"unsupported next_action keys: {extra}"
        )

    instruction = value.get("instruction")
    expected_result = value.get("expected_result")
    state_change = value.get("state_change")

    if not isinstance(instruction, str) or not instruction.strip():
        raise GateReject(
            "plan.next_action.instruction required"
        )
    if (
        not isinstance(expected_result, str)
        or not expected_result.strip()
    ):
        raise GateReject(
            "plan.next_action.expected_result required"
        )
    if not isinstance(state_change, bool):
        raise GateReject(
            "plan.next_action.state_change must be boolean"
        )

    for name, text in (
        ("instruction", instruction),
        ("expected_result", expected_result),
    ):
        if "\n" in text or "\r" in text:
            raise GateReject(
                f"plan.next_action.{name} must be one line"
            )
        if len(text) > 500:
            raise GateReject(
                f"plan.next_action.{name} is too long"
            )

    return value


def validate_plan(plan: dict[str, Any]) -> None:
    reject_forbidden_keys(plan)

    allowed_keys = {
        "version",
        "job_id",
        "purpose",
        "operation",
        "contract_id",
        "commit_message",
        "next_action",
    }
    extra = sorted(set(plan) - allowed_keys)
    if extra:
        raise GateReject(f"unsupported plan keys: {extra}")

    if plan.get("version") != 1:
        raise GateReject("plan.version must be 1")

    job_id = plan.get("job_id")
    if (
        not isinstance(job_id, str)
        or re.fullmatch(r"[A-Za-z0-9._-]{1,80}", job_id) is None
    ):
        raise GateReject("plan.job_id invalid")

    purpose = plan.get("purpose")
    if not isinstance(purpose, str) or not purpose.strip():
        raise GateReject("plan.purpose required")

    allowed_operations = {
        "inspect",
        "validate_existing_change",
        "apply_change",
        "policy_update",
        "commit_validated_change",
        "deploy_test",
    }
    if plan.get("operation") not in allowed_operations:
        raise GateReject("plan.operation is not approved")

    validate_next_action(plan.get("next_action"))


def extract_job(zip_path: Path, temp_dir: Path) -> JobPaths:
    if not zip_path.is_file():
        raise GateReject(f"job bundle not found: {zip_path}")

    try:
        with zipfile.ZipFile(zip_path) as archive:
            names = archive.namelist()
            if not names:
                raise GateReject("job bundle is empty")

            for name in names:
                path = Path(name)
                if path.is_absolute() or ".." in path.parts:
                    raise GateReject(f"unsafe zip path: {name}")

            allowed_names = {
                "manifest.json",
                "plan.json",
                "contract.json",
                "operations.json",
            }
            unexpected = sorted(set(names) - allowed_names)
            if unexpected:
                raise GateReject(
                    f"unexpected file(s) in job bundle: {unexpected}"
                )

            archive.extractall(temp_dir)
    except zipfile.BadZipFile as exc:
        raise GateReject(
            "job bundle is not a valid zip"
        ) from exc

    manifest = temp_dir / "manifest.json"
    plan = temp_dir / "plan.json"
    contract = temp_dir / "contract.json"
    operations = temp_dir / "operations.json"

    if not manifest.is_file() or not plan.is_file():
        raise GateReject(
            "job bundle requires manifest.json and plan.json"
        )

    manifest_data = load_utf8_json(manifest)
    if manifest_data.get("version") != 1:
        raise GateReject("manifest.version must be 1")

    hashes = manifest_data.get("sha256")
    if not isinstance(hashes, dict):
        raise GateReject("manifest.sha256 must be object")

    allowed_hash_names = {
        "plan.json",
        "contract.json",
        "operations.json",
    }
    for name, expected in hashes.items():
        if name not in allowed_hash_names:
            raise GateReject(
                f"manifest hashes unexpected file: {name}"
            )
        path = temp_dir / name
        if not path.is_file():
            raise GateReject(
                f"manifest references missing file: {name}"
            )
        actual = sha256_file(path)
        if actual != expected:
            raise GateReject(
                f"job bundle hash mismatch: {name}: "
                f"expected {expected}, got {actual}"
            )

    return JobPaths(
        root=temp_dir,
        manifest=manifest,
        plan=plan,
        contract=contract if contract.is_file() else None,
        operations=operations if operations.is_file() else None,
    )


def validate_operation_text(value: Any, *, field: str) -> str:
    if not isinstance(value, str):
        raise GateReject(f"{field} must be string")
    if "\r" in value:
        raise GateReject(
            f"{field} must use LF newlines only"
        )
    if "\x00" in value:
        raise GateReject(f"{field} contains NUL")
    return value


def validate_operations_document(
    document: dict[str, Any],
    contract: dict[str, Any],
    *,
    policy_update: bool,
) -> None:
    reject_forbidden_keys(document)

    allowed_top = {
        "format_version",
        "project",
        "purpose",
        "base_commit",
        "target_branch",
        "operations",
        "post_checks",
    }
    extra = sorted(set(document) - allowed_top)
    if extra:
        raise GateReject(
            f"unsupported operations document keys: {extra}"
        )

    if document.get("format_version") != 1:
        raise GateReject(
            "operations.format_version must be 1"
        )
    if document.get("project") != "kanade-orchestra":
        raise GateReject(
            "operations.project must be 'kanade-orchestra'"
        )
    if (
        not isinstance(document.get("purpose"), str)
        or not document["purpose"].strip()
    ):
        raise GateReject("operations.purpose required")

    base_commit = document.get("base_commit")
    if (
        not isinstance(base_commit, str)
        or re.fullmatch(r"[0-9a-f]{40}", base_commit) is None
    ):
        raise GateReject(
            "operations.base_commit must be a 40-character lowercase SHA"
        )
    actual_head = git_head(cwd=ROOT)
    if base_commit != actual_head:
        raise GateReject(
            "operations.base_commit does not match HEAD: "
            f"{base_commit} != {actual_head}"
        )

    target_branch = document.get("target_branch")
    if (
        not isinstance(target_branch, str)
        or not target_branch.strip()
    ):
        raise GateReject(
            "operations.target_branch required"
        )
    actual_branch = git_branch(cwd=ROOT)
    if target_branch != actual_branch:
        raise GateReject(
            "operations.target_branch does not match current branch: "
            f"{target_branch!r} != {actual_branch!r}"
        )

    post_checks = document.get("post_checks")
    if not isinstance(post_checks, list):
        raise GateReject(
            "operations.post_checks must be list"
        )
    if any(not isinstance(item, str) for item in post_checks):
        raise GateReject(
            "operations.post_checks entries must be strings"
        )
    check_set = set(post_checks)
    unknown = sorted(check_set - REQUIRED_POST_CHECKS)
    if unknown:
        raise GateReject(
            f"unsupported post_checks: {unknown}"
        )
    missing = sorted(REQUIRED_POST_CHECKS - check_set)
    if missing:
        raise GateReject(
            f"required post_checks missing: {missing}"
        )

    operations = document.get("operations")
    if not isinstance(operations, list) or not operations:
        raise GateReject(
            "operations.operations must be non-empty list"
        )

    validate_contract_scope(
        contract,
        policy_update=policy_update,
    )
    allowed_files = {
        str(rel).replace("\\", "/")
        for rel in contract["allowed_files"]
    }

    roots = (
        "src/",
        "tests/",
        ".github/",
        "scripts/",
        "db/",
        "docs/",
        ".githooks/",
    )

    for index, operation in enumerate(operations):
        where = f"operations.operations[{index}]"
        if not isinstance(operation, dict):
            raise GateReject(f"{where} must be object")

        op_type = operation.get("operation")
        if op_type not in ALLOWED_OPERATION_TYPES:
            raise GateReject(
                f"{where}.operation is not approved: {op_type!r}"
            )

        rel = safe_rel_path(
            operation.get("path"),
            roots=roots,
        )
        if rel not in allowed_files:
            raise GateReject(
                f"{where}.path is outside contract.allowed_files: {rel}"
            )

        if policy_update:
            if rel not in PROTECTED_GATE_PATHS:
                raise GateReject(
                    f"policy_update path is not protected: {rel}"
                )
        elif rel in PROTECTED_GATE_PATHS:
            raise GateReject(
                f"apply_change cannot modify protected file: {rel}"
            )

        if op_type == "create_text_file":
            allowed_keys = {
                "path",
                "operation",
                "expected_absent",
                "content",
                "eol",
            }
            extra_keys = sorted(set(operation) - allowed_keys)
            if extra_keys:
                raise GateReject(
                    f"unsupported keys for {where}: {extra_keys}"
                )
            if operation.get("expected_absent") is not True:
                raise GateReject(
                    f"{where}.expected_absent must be true"
                )
            validate_operation_text(
                operation.get("content"),
                field=f"{where}.content",
            )
            if operation.get("eol", "LF") not in {"LF", "CRLF"}:
                raise GateReject(
                    f"{where}.eol must be LF or CRLF"
                )
            continue

        allowed_keys = {
            "path",
            "operation",
            "expected_sha256",
            "expected_occurrences",
            "old_text",
            "new_text",
            "anchor",
            "content",
        }
        extra_keys = sorted(set(operation) - allowed_keys)
        if extra_keys:
            raise GateReject(
                f"unsupported keys for {where}: {extra_keys}"
            )

        expected_sha = operation.get("expected_sha256")
        if (
            not isinstance(expected_sha, str)
            or re.fullmatch(r"[0-9a-f]{64}", expected_sha) is None
        ):
            raise GateReject(
                f"{where}.expected_sha256 must be lowercase SHA-256"
            )

        expected_count = operation.get("expected_occurrences")
        if not isinstance(expected_count, int) or expected_count < 1:
            raise GateReject(
                f"{where}.expected_occurrences must be integer >= 1"
            )

        if op_type == "replace_exact":
            validate_operation_text(
                operation.get("old_text"),
                field=f"{where}.old_text",
            )
            validate_operation_text(
                operation.get("new_text"),
                field=f"{where}.new_text",
            )
        elif op_type in {
            "insert_before_exact",
            "insert_after_exact",
        }:
            validate_operation_text(
                operation.get("anchor"),
                field=f"{where}.anchor",
            )
            validate_operation_text(
                operation.get("content"),
                field=f"{where}.content",
            )
        elif op_type == "delete_exact":
            validate_operation_text(
                operation.get("old_text"),
                field=f"{where}.old_text",
            )


def apply_operations(
    document: dict[str, Any],
    *,
    cwd: Path,
) -> None:
    for index, operation in enumerate(document["operations"]):
        rel = operation["path"].replace("\\", "/")
        full = cwd / rel
        op_type = operation["operation"]

        if op_type == "create_text_file":
            if full.exists():
                raise GateReject(
                    f"create target already exists: {rel}"
                )
            content = validate_operation_text(
                operation["content"],
                field=f"operations.operations[{index}].content",
            )
            eol = operation.get("eol", "LF")
            data = encode_text_file(
                content,
                eol=eol,
                rel=rel,
            )
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_bytes(data)
            continue

        if not full.is_file():
            raise GateReject(
                f"operation target missing: {rel}"
            )

        raw = full.read_bytes()
        actual_sha = sha256_bytes(raw)
        if actual_sha != operation["expected_sha256"]:
            raise GateReject(
                f"source SHA-256 mismatch: {rel}: "
                f"expected {operation['expected_sha256']}, "
                f"got {actual_sha}"
            )

        text, eol = decode_text_file(raw, rel=rel)
        expected_count = operation["expected_occurrences"]

        if op_type == "replace_exact":
            old = operation["old_text"]
            new = operation["new_text"]
            count = text.count(old)
            if count != expected_count:
                raise GateReject(
                    f"replace occurrence mismatch: {rel}: "
                    f"expected {expected_count}, got {count}"
                )
            text = text.replace(old, new)
        elif op_type == "insert_before_exact":
            anchor = operation["anchor"]
            content = operation["content"]
            count = text.count(anchor)
            if count != expected_count:
                raise GateReject(
                    f"insert-before occurrence mismatch: {rel}: "
                    f"expected {expected_count}, got {count}"
                )
            text = text.replace(
                anchor,
                content + anchor,
            )
        elif op_type == "insert_after_exact":
            anchor = operation["anchor"]
            content = operation["content"]
            count = text.count(anchor)
            if count != expected_count:
                raise GateReject(
                    f"insert-after occurrence mismatch: {rel}: "
                    f"expected {expected_count}, got {count}"
                )
            text = text.replace(
                anchor,
                anchor + content,
            )
        elif op_type == "delete_exact":
            old = operation["old_text"]
            count = text.count(old)
            if count != expected_count:
                raise GateReject(
                    f"delete occurrence mismatch: {rel}: "
                    f"expected {expected_count}, got {count}"
                )
            text = text.replace(old, "")
        else:
            raise GateReject(
                f"internal error: unsupported operation: {op_type}"
            )

        full.write_bytes(
            encode_text_file(text, eol=eol, rel=rel)
        )


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

    allowed = {
        rel.replace("\\", "/")
        for rel in contract["allowed_files"]
    }
    unexpected = sorted(set(files) - allowed)
    if unexpected:
        raise GateReject(
            f"changed files outside contract: {unexpected}"
        )

    required = {
        rel.replace("\\", "/")
        for rel in contract.get("required_changed_files", [])
    }
    missing = sorted(required - set(files))
    if missing:
        raise GateReject(
            f"required changed files missing: {missing}"
        )

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
            "core.whitespace=trailing-space,space-before-tab",
            "diff",
            "--check",
            base_ref,
        ],
        cwd=cwd,
    )
    if diff_check.returncode != 0:
        raise GateReject(
            "git diff --check failed:\n"
            f"{diff_check.stdout}{diff_check.stderr}"
        )

    test_results: list[dict[str, Any]] = []
    if run_tests:
        for descriptor in contract.get("required_tests", []):
            argv = test_argv(descriptor, cwd=cwd)
            proc = run(
                argv,
                cwd=cwd,
                capture=False,
            )
            test_results.append(
                {
                    "kind": descriptor["kind"],
                    "returncode": proc.returncode,
                    "argv": argv,
                }
            )
            if proc.returncode != 0:
                raise GateReject(
                    f"required test failed ({proc.returncode}): "
                    f"{descriptor['kind']}"
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
    source_operation: str,
) -> Path:
    if source_operation not in {"apply_change", "policy_update"}:
        raise GateReject(
            "committable evidence cannot be created by "
            f"{source_operation!r}"
        )

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    path = EVIDENCE_DIR / f"{job_id}.json"
    unsigned_payload = {
        "version": 1,
        "runner_version": 4,
        "source_operation": source_operation,
        "job_id": job_id,
        "contract_id": contract["id"],
        "goal": contract["goal"],
        "files": verification["files"],
        "content_hash": verification["content_hash"],
        "integrity": verification["integrity"],
        "tests": verification["tests"],
        "gate": "PASS",
    }
    canonical = json.dumps(
        unsigned_payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    signature = hashlib.blake2b(
        canonical,
        key=bytes.fromhex(publish_guard_token()),
        digest_size=32,
    ).hexdigest()
    payload = dict(unsigned_payload)
    payload["evidence_signature"] = signature
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return path


def print_verification_summary(
    verification: dict[str, Any],
) -> None:
    print("ENCODING_CHECK=PASS")
    print("EOL_CHECK=PASS")
    print("SYNTAX_CHECK=PASS")
    print("CONTRACT_CHECK=PASS")
    print("DIFF_CHECK=PASS")
    print("TESTS=PASS")
    print(f"CONTENT_HASH={verification['content_hash']}")


def copy_verified_files(
    files: list[str],
    *,
    source_root: Path,
    target_root: Path,
) -> None:
    backups: dict[str, bytes | None] = {}
    written: list[str] = []

    try:
        for rel in files:
            target = target_root / rel
            backups[rel] = (
                target.read_bytes() if target.is_file() else None
            )

        for rel in files:
            source = source_root / rel
            target = target_root / rel
            if source.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
            elif target.exists():
                target.unlink()
            written.append(rel)
    except Exception:
        for rel in reversed(written):
            target = target_root / rel
            old = backups[rel]
            if old is None:
                if target.exists():
                    target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(old)
        raise


def apply_structured_change(
    job: JobPaths,
    plan: dict[str, Any],
    *,
    allow_state_change: bool,
    policy_update: bool,
) -> None:
    operation_name = "policy_update" if policy_update else "apply_change"

    if not allow_state_change:
        raise GateReject(
            f"{operation_name} requires --allow-state-change"
        )
    if job.contract is None or job.operations is None:
        raise GateReject(
            f"{operation_name} requires "
            "contract.json and operations.json"
        )
    if not repo_clean(cwd=ROOT):
        raise GateReject(
            f"real worktree must be clean before {operation_name}"
        )

    contract = load_utf8_json(job.contract)
    if plan.get("contract_id") != contract.get("id"):
        raise GateReject(
            "plan.contract_id does not match contract.id"
        )

    document = load_utf8_json(job.operations)
    validate_operations_document(
        document,
        contract,
        policy_update=policy_update,
    )

    base_head = git_head(cwd=ROOT)

    with tempfile.TemporaryDirectory(
        prefix="kanade-ai-v4-"
    ) as temp:
        temp_root = Path(temp) / "worktree"

        add = run(
            [
                executable("git"),
                "-c",
                "core.autocrlf=false",
                "worktree",
                "add",
                "--detach",
                str(temp_root),
                base_head,
            ],
            cwd=ROOT,
        )
        if add.returncode != 0:
            raise GateReject(
                "failed to create validation worktree:\n"
                f"{add.stdout}{add.stderr}"
            )

        try:
            apply_operations(document, cwd=temp_root)

            verification = verify_change_against_contract(
                contract,
                cwd=temp_root,
                base_ref="HEAD",
                run_tests=True,
            )

            if git_head(cwd=ROOT) != base_head:
                raise GateReject(
                    "real HEAD changed during validation"
                )
            if not repo_clean(cwd=ROOT):
                raise GateReject(
                    "real worktree changed during validation"
                )

            copy_verified_files(
                verification["files"],
                source_root=temp_root,
                target_root=ROOT,
            )

            try:
                real_verification = verify_change_against_contract(
                    contract,
                    cwd=ROOT,
                    base_ref="HEAD",
                    run_tests=False,
                )
                if (
                    real_verification["content_hash"]
                    != verification["content_hash"]
                ):
                    raise GateReject(
                        "real worktree content hash differs "
                        "from validated worktree"
                    )
            except Exception:
                tracked_files = [
                    rel
                    for rel in verification["files"]
                    if git_bytes("HEAD", rel, cwd=ROOT) is not None
                ]
                if tracked_files:
                    run(
                        [
                            executable("git"),
                            "restore",
                            "--source=HEAD",
                            "--staged",
                            "--worktree",
                            "--",
                            *tracked_files,
                        ],
                        cwd=ROOT,
                    )
                for rel in verification["files"]:
                    if git_bytes("HEAD", rel, cwd=ROOT) is None:
                        path = ROOT / rel
                        if path.exists():
                            path.unlink()
                raise

            evidence = write_evidence(
                job_id=plan["job_id"],
                contract=contract,
                verification=verification,
                source_operation=operation_name,
            )

            print("AI_WORKFLOW_GATE=PASS")
            print(f"RUNNER_VERSION=4")
            print(f"OPERATION={operation_name}")
            print(f"JOB_ID={plan['job_id']}")
            print(f"EVIDENCE={evidence.relative_to(ROOT)}")
            print_verification_summary(verification)
        finally:
            run(
                [
                    executable("git"),
                    "worktree",
                    "remove",
                    "--force",
                    str(temp_root),
                ],
                cwd=ROOT,
            )
            run(
                [executable("git"), "worktree", "prune"],
                cwd=ROOT,
            )


def validate_existing_change(
    job: JobPaths,
    plan: dict[str, Any],
) -> None:
    if job.contract is None:
        raise GateReject(
            "validate_existing_change requires contract.json"
        )
    if job.operations is not None:
        raise GateReject(
            "validate_existing_change must not contain operations.json"
        )

    contract = load_utf8_json(job.contract)
    if plan.get("contract_id") != contract.get("id"):
        raise GateReject(
            "plan.contract_id does not match contract.id"
        )

    verification = verify_change_against_contract(
        contract,
        cwd=ROOT,
        base_ref="HEAD",
        run_tests=True,
    )

    print("AI_WORKFLOW_GATE=PASS")
    print("RUNNER_VERSION=4")
    print("OPERATION=validate_existing_change")
    print(f"JOB_ID={plan['job_id']}")
    print("COMMIT_EVIDENCE=NOT_CREATED")
    print_verification_summary(verification)


def publish_guard_token() -> str:
    proc = run(
        [executable("git"), "rev-parse", "--git-common-dir"],
        cwd=ROOT,
        check=True,
    )
    common_raw = proc.stdout.strip()
    if not common_raw:
        raise GateReject("Git common directory is empty")

    common_dir = Path(common_raw)
    if not common_dir.is_absolute():
        common_dir = (ROOT / common_dir).resolve()

    token_path = common_dir / "kanade-ai-publish-token"
    try:
        token = token_path.read_text(
            encoding="utf-8"
        ).strip()
    except FileNotFoundError as exc:
        raise GateReject(
            "publish guard token is missing; "
            "run through scripts/run_ai_job.ps1"
        ) from exc

    if re.fullmatch(r"[0-9a-f]{64}", token) is None:
        raise GateReject("publish guard token is invalid")
    return token


def require_runner_authorization() -> None:
    expected = publish_guard_token()
    actual = os.environ.get("KANADE_AI_RUNNER_TOKEN", "")
    if not actual or actual != expected:
        raise GateReject(
            "state-changing AI jobs must run through "
            "scripts/run_ai_job.ps1"
        )


def evidence_for_job(job_id: str) -> dict[str, Any]:
    path = EVIDENCE_DIR / f"{job_id}.json"
    evidence = load_utf8_json(path)
    if evidence.get("gate") != "PASS":
        raise GateReject("evidence gate is not PASS")

    if evidence.get("runner_version") != 4:
        raise GateReject(
            "evidence was not created by JSON-only runner version 4"
        )
    if evidence.get("source_operation") not in {
        "apply_change",
        "policy_update",
    }:
        raise GateReject(
            "evidence source operation is not committable"
        )

    signature = evidence.get("evidence_signature")
    if not isinstance(signature, str):
        raise GateReject("evidence signature is missing")

    unsigned = dict(evidence)
    unsigned.pop("evidence_signature", None)
    canonical = json.dumps(
        unsigned,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    expected_signature = hashlib.blake2b(
        canonical,
        key=bytes.fromhex(publish_guard_token()),
        digest_size=32,
    ).hexdigest()
    if signature != expected_signature:
        raise GateReject("evidence signature is invalid")

    return evidence


def commit_validated_change(
    plan: dict[str, Any],
    *,
    allow_state_change: bool,
) -> None:
    if not allow_state_change:
        raise GateReject(
            "commit_validated_change requires --allow-state-change"
        )

    message = plan.get("commit_message")
    if not isinstance(message, str) or not message.strip():
        raise GateReject("commit_message required")
    if "\n" in message or "\r" in message or len(message) > 120:
        raise GateReject(
            "commit_message must be one line <= 120 chars"
        )

    evidence = evidence_for_job(plan["job_id"])
    files = changed_files(cwd=ROOT, base="HEAD")
    if files != evidence.get("files"):
        raise GateReject(
            "current changed files differ from validated evidence"
        )

    current_hash = worktree_hash(files, cwd=ROOT)
    if current_hash != evidence.get("content_hash"):
        raise GateReject(
            "current content hash differs from validated evidence"
        )

    for rel in files:
        run(
            [executable("git"), "add", "--", rel],
            cwd=ROOT,
            check=True,
        )

    check = run(
        [
            executable("git"),
            "-c",
            "core.whitespace=trailing-space,space-before-tab",
            "diff",
            "--cached",
            "--check",
        ],
        cwd=ROOT,
    )
    if check.returncode != 0:
        raise GateReject(
            "staged diff check failed:\n"
            f"{check.stdout}{check.stderr}"
        )

    commit = run(
        [
            executable("git"),
            "commit",
            "-m",
            message,
        ],
        cwd=ROOT,
    )
    if commit.returncode != 0:
        raise GateReject(
            f"git commit failed:\n{commit.stdout}{commit.stderr}"
        )

    evidence_path = EVIDENCE_DIR / f"{plan['job_id']}.json"
    if evidence_path.is_file():
        evidence_path.unlink()

    print("AI_WORKFLOW_GATE=PASS")
    print("RUNNER_VERSION=4")
    print("OPERATION=commit_validated_change")
    print(f"JOB_ID={plan['job_id']}")


def deploy_test(
    plan: dict[str, Any],
    *,
    allow_state_change: bool,
) -> None:
    if not allow_state_change:
        raise GateReject(
            "deploy_test requires --allow-state-change"
        )
    if not repo_clean(cwd=ROOT):
        raise GateReject(
            "worktree must be clean before deploy_test"
        )

    script = ROOT / "scripts" / "deploy_to_test.ps1"
    if not script.is_file():
        raise GateReject(
            "approved deploy script missing: "
            "scripts/deploy_to_test.ps1"
        )

    if os.name == "nt":
        ps = shutil.which("powershell.exe") or shutil.which(
            "powershell"
        )
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
        argv = [
            pwsh,
            "-NoLogo",
            "-NoProfile",
            "-File",
            str(script),
        ]

    deploy_env = os.environ.copy()
    deploy_env["KANADE_AI_PUBLISH_TOKEN"] = publish_guard_token()
    proc = run(
        argv,
        cwd=ROOT,
        capture=False,
        env=deploy_env,
    )
    if proc.returncode != 0:
        raise GateReject(
            f"deploy_test failed ({proc.returncode})"
        )

    print("AI_WORKFLOW_GATE=PASS")
    print("RUNNER_VERSION=4")
    print("OPERATION=deploy_test")
    print(f"JOB_ID={plan['job_id']}")


def inspect(plan: dict[str, Any]) -> None:
    status = run(
        [
            executable("git"),
            "status",
            "--short",
            "--branch",
        ],
        cwd=ROOT,
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
        check=True,
    )
    print("AI_WORKFLOW_GATE=PASS")
    print("RUNNER_VERSION=4")
    print("OPERATION=inspect")
    print(f"JOB_ID={plan['job_id']}")
    print(status.stdout, end="")
    print(head.stdout, end="")


def print_next_action(plan: dict[str, Any]) -> None:
    action = validate_next_action(plan.get("next_action"))
    print("NEXT_ACTION_REQUIRED=1")
    print(
        "NEXT_ACTION_INSTRUCTION="
        f"{action['instruction']}"
    )
    print(
        "NEXT_ACTION_EXPECTED_RESULT="
        f"{action['expected_result']}"
    )
    print(
        "NEXT_ACTION_STATE_CHANGE="
        + ("true" if action["state_change"] else "false")
    )


def print_failure_next_action() -> None:
    print("NEXT_ACTION_REQUIRED=1", file=sys.stderr)
    print(
        "NEXT_ACTION_INSTRUCTION=Paste the complete output into "
        "ChatGPT. Do not run another repository-changing operation "
        "until a concrete next step is provided.",
        file=sys.stderr,
    )
    print(
        "NEXT_ACTION_EXPECTED_RESULT=The failure is reviewed and "
        "the next required concrete operation is provided.",
        file=sys.stderr,
    )
    print(
        "NEXT_ACTION_STATE_CHANGE=false",
        file=sys.stderr,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("job_zip", type=Path)
    parser.add_argument(
        "--allow-state-change",
        action="store_true",
    )
    ns = parser.parse_args()

    try:
        with tempfile.TemporaryDirectory(
            prefix="kanade-job-v4-"
        ) as temp:
            job = extract_job(
                ns.job_zip.resolve(),
                Path(temp),
            )
            plan = load_utf8_json(job.plan)
            validate_plan(plan)

            operation = plan["operation"]
            state_changing = operation in {
                "apply_change",
                "policy_update",
                "commit_validated_change",
                "deploy_test",
            }
            if state_changing:
                if not ns.allow_state_change:
                    raise GateReject(
                        f"{operation} requires --allow-state-change"
                    )
                require_runner_authorization()

            if operation == "inspect":
                inspect(plan)
            elif operation == "validate_existing_change":
                validate_existing_change(job, plan)
            elif operation == "apply_change":
                apply_structured_change(
                    job,
                    plan,
                    allow_state_change=ns.allow_state_change,
                    policy_update=False,
                )
            elif operation == "policy_update":
                apply_structured_change(
                    job,
                    plan,
                    allow_state_change=ns.allow_state_change,
                    policy_update=True,
                )
            elif operation == "commit_validated_change":
                commit_validated_change(
                    plan,
                    allow_state_change=ns.allow_state_change,
                )
            elif operation == "deploy_test":
                deploy_test(
                    plan,
                    allow_state_change=ns.allow_state_change,
                )
            else:
                raise GateReject(
                    f"unsupported operation: {operation}"
                )

            print_next_action(plan)
        return 0

    except GateReject as exc:
        print("AI_WORKFLOW_GATE=REJECT", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        print_failure_next_action()
        return 2
    except Exception as exc:
        print("AI_WORKFLOW_GATE=ERROR", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        print_failure_next_action()
        return 3


def apply_change(*_args: Any, **_kwargs: Any) -> None:
    raise GateReject("legacy change.patch apply path is disabled")


if __name__ == "__main__":
    raise SystemExit(main())
