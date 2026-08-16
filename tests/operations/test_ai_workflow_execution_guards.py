from __future__ import annotations

import base64
import importlib.util
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


def _load_gate():
    path = Path("scripts/ai_workflow_gate.py")
    spec = importlib.util.spec_from_file_location("ai_workflow_gate_for_guard_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _powershell_executable() -> str | None:
    return shutil.which("powershell.exe") or shutil.which("powershell")


def _git_utf8_stdout_from_runner(repo: Path) -> str:
    """Invoke the runner's actual helper without invoking its state-changing main."""
    powershell = _powershell_executable()
    if powershell is None:
        pytest.skip("Windows PowerShell is unavailable")

    runner = Path("scripts/run_ai_job.ps1").resolve()
    command = """
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $env:KANADE_TEST_RUNNER,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -ne 0) { throw "runner parser error" }
$function = $ast.Find(
    {
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "Get-GitUtf8Stdout"
    },
    $true
)
if ($null -eq $function) { throw "Get-GitUtf8Stdout not found" }
. ([scriptblock]::Create($function.Extent.Text))
Get-GitUtf8Stdout -Repo $env:KANADE_TEST_REPO -GitArguments @("rev-parse", "--git-common-dir")
"""
    environment = dict(
        os.environ,
        KANADE_TEST_RUNNER=str(runner),
        KANADE_TEST_REPO=str(repo),
    )
    encoded_command = base64.b64encode(command.encode("utf-16le")).decode("ascii")
    result = subprocess.run(
        [
            powershell,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encoded_command,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=environment,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def _git(*arguments: str, cwd: Path) -> str:
    result = subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return result.stdout.strip()


def _resolve_git_dir(raw: str, repo: Path) -> Path:
    path = Path(raw)
    return (path if path.is_absolute() else repo / path).resolve()


def _run_runner_token_probe(repo: Path) -> subprocess.CompletedProcess[str]:
    powershell = _powershell_executable()
    if powershell is None:
        pytest.skip("Windows PowerShell is unavailable")

    source_root = Path.cwd()
    (repo / "scripts").mkdir(exist_ok=True)
    (repo / ".githooks").mkdir(exist_ok=True)
    shutil.copy2(source_root / "scripts" / "run_ai_job.ps1", repo / "scripts")
    shutil.copy2(source_root / ".githooks" / "pre-commit", repo / ".githooks")
    (repo / "scripts" / "ai_workflow_gate.py").write_text(
        """import os
import subprocess
import sys
from pathlib import Path

if "--allow-state-change" not in sys.argv:
    raise SystemExit(10)
common = subprocess.check_output(
    ["git", "rev-parse", "--git-common-dir"], text=True, encoding="utf-8"
).strip()
common_path = Path(common)
if not common_path.is_absolute():
    common_path = Path.cwd() / common_path
expected = (common_path / "kanade-ai-publish-token").read_text(encoding="utf-8").strip()
raise SystemExit(0 if os.environ.get("KANADE_AI_RUNNER_TOKEN") == expected else 11)
""",
        encoding="utf-8",
    )
    job = repo / "token-probe.zip"
    job.write_bytes(b"token probe")
    venv_scripts = Path(sys.executable).parent
    environment = dict(os.environ, PATH=str(venv_scripts) + os.pathsep + os.environ["PATH"])
    return subprocess.run(
        [powershell, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(repo / "scripts" / "run_ai_job.ps1"), "-JobZip", str(job), "-AllowStateChange"],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=environment,
    )


@pytest.mark.skipif(sys.platform != "win32", reason="Windows PowerShell encoding regression")
def test_runner_git_utf8_stdout_handles_ascii_normal_worktree(tmp_path):
    repo = tmp_path / "ascii-runner-repo"
    repo.mkdir()
    _git("init", cwd=repo)

    common = _resolve_git_dir(_git_utf8_stdout_from_runner(repo), repo)
    assert common == (repo / ".git").resolve()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows PowerShell encoding regression")
def test_runner_git_utf8_stdout_handles_japanese_normal_and_linked_worktrees(tmp_path):
    main_repo = tmp_path / "日本語リポジトリ"
    main_repo.mkdir()
    _git("init", cwd=main_repo)
    _git("config", "user.email", "gate-test@example.invalid", cwd=main_repo)
    _git("config", "user.name", "Gate Test", cwd=main_repo)
    (main_repo / "README.txt").write_text("test\n", encoding="utf-8")
    _git("add", "README.txt", cwd=main_repo)
    _git("commit", "-m", "initial", cwd=main_repo)

    expected_common = (main_repo / ".git").resolve()
    normal_common = _resolve_git_dir(
        _git_utf8_stdout_from_runner(main_repo), main_repo
    )
    assert normal_common == expected_common

    linked_repo = tmp_path / "日本語linked-worktree"
    _git("worktree", "add", "-b", "utf8-linked-test", str(linked_repo), cwd=main_repo)
    linked_common = _resolve_git_dir(
        _git_utf8_stdout_from_runner(linked_repo), linked_repo
    )
    assert linked_common == expected_common

    correct_token = "a" * 64
    (expected_common / "kanade-ai-publish-token").write_text(
        correct_token, encoding="ascii"
    )
    decoy_common = tmp_path / "繧ｪ繧ｱ繝昴・繧ｿ繝ｫ" / ".git"
    decoy_common.mkdir(parents=True)
    (decoy_common / "kanade-ai-publish-token").write_text("f" * 64, encoding="ascii")
    assert linked_common != decoy_common.resolve()
    assert hashlib.sha256(
        (linked_common / "kanade-ai-publish-token").read_bytes()
    ).hexdigest() == hashlib.sha256(correct_token.encode("ascii")).hexdigest()


def test_runner_utf8_helper_reads_streams_concurrently():
    runner = Path("scripts/run_ai_job.ps1").read_text(encoding="utf-8")
    assert "$stdoutTask = $process.StandardOutput.ReadToEndAsync()" in runner
    assert "$stderrTask = $process.StandardError.ReadToEndAsync()" in runner
    assert "$process.WaitForExit()" in runner
    assert "$stdout = $stdoutTask.GetAwaiter().GetResult()" in runner
    assert "$stderr = $stderrTask.GetAwaiter().GetResult()" in runner


@pytest.mark.skipif(sys.platform != "win32", reason="Windows PowerShell runner integration")
@pytest.mark.parametrize("initial", [None, "existing-runner-token"])
def test_runner_restores_calling_powershell_environment(tmp_path, initial):
    repo = tmp_path / "runner-env-repo"
    repo.mkdir()
    _git("init", cwd=repo)
    _git("config", "user.email", "gate-test@example.invalid", cwd=repo)
    _git("config", "user.name", "Gate Test", cwd=repo)
    (repo / "README.txt").write_text("test\n", encoding="utf-8")
    _git("add", "README.txt", cwd=repo)
    _git("commit", "-m", "initial", cwd=repo)

    powershell = _powershell_executable()
    assert powershell is not None
    _run_runner_token_probe(repo)  # install the isolated runner files
    runner = repo / "scripts" / "run_ai_job.ps1"
    command = """
$env:KANADE_AI_RUNNER_TOKEN = $env:KANADE_TEST_INITIAL
if ($env:KANADE_TEST_INITIAL -eq "__UNSET__") { Remove-Item Env:KANADE_AI_RUNNER_TOKEN -ErrorAction SilentlyContinue }
& $env:KANADE_TEST_RUNNER -JobZip $env:KANADE_TEST_JOB -AllowStateChange
if ($null -eq $env:KANADE_AI_RUNNER_TOKEN) { Write-Output "AFTER=UNSET" } else { Write-Output ("AFTER=" + $env:KANADE_AI_RUNNER_TOKEN) }
"""
    environment = dict(os.environ, KANADE_TEST_INITIAL=initial or "__UNSET__", KANADE_TEST_RUNNER=str(runner), KANADE_TEST_JOB=str(repo / "token-probe.zip"), PATH=str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"])
    encoded = base64.b64encode(command.encode("utf-16le")).decode("ascii")
    result = subprocess.run([powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], capture_output=True, text=True, encoding="utf-8", errors="replace", env=environment, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
    assert ("AFTER=UNSET" if initial is None else f"AFTER={initial}") in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows PowerShell encoding regression")
def test_runner_utf8_helper_rejects_nonzero_git_with_stderr_without_hanging(tmp_path):
    repo = tmp_path / "git-failure-repo"
    repo.mkdir()
    _git("init", cwd=repo)
    powershell = _powershell_executable()
    assert powershell is not None
    runner = Path("scripts/run_ai_job.ps1").resolve()
    command = """
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:KANADE_TEST_RUNNER,[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Get-GitUtf8Stdout"},$true)
. ([scriptblock]::Create($function.Extent.Text))
try { Get-GitUtf8Stdout -Repo $env:KANADE_TEST_REPO -GitArguments @("status", "--definitely-invalid-option") } catch { Write-Output ("ERROR=" + $_.Exception.Message); exit 7 }
exit 8
"""
    environment = dict(os.environ, KANADE_TEST_RUNNER=str(runner), KANADE_TEST_REPO=str(repo))
    encoded = base64.b64encode(command.encode("utf-16le")).decode("ascii")
    result = subprocess.run([powershell, "-NoProfile", "-EncodedCommand", encoded], capture_output=True, text=True, encoding="utf-8", errors="replace", env=environment, timeout=15)
    assert result.returncode == 7
    assert "Git command failed:" in result.stdout
    assert "unknown option" in result.stdout.lower() or "unknown switch" in result.stdout.lower()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows PowerShell runner integration")
def test_runner_authorizes_token_in_japanese_normal_and_linked_worktrees(tmp_path):
    main_repo = tmp_path / "日本語runner-repo"
    main_repo.mkdir()
    _git("init", cwd=main_repo)
    _git("config", "user.email", "gate-test@example.invalid", cwd=main_repo)
    _git("config", "user.name", "Gate Test", cwd=main_repo)
    (main_repo / "README.txt").write_text("test\n", encoding="utf-8")
    _git("add", "README.txt", cwd=main_repo)
    _git("commit", "-m", "initial", cwd=main_repo)

    normal = _run_runner_token_probe(main_repo)
    assert normal.returncode == 0, normal.stdout + normal.stderr
    assert "PUBLISH_GUARD=ACTIVE" in normal.stdout

    linked_repo = tmp_path / "日本語runner-linked"
    _git("worktree", "add", "-b", "runner-linked-test", str(linked_repo), cwd=main_repo)
    linked = _run_runner_token_probe(linked_repo)
    assert linked.returncode == 0, linked.stdout + linked.stderr
    assert "PUBLISH_GUARD=ACTIVE" in linked.stdout


def _valid_plan() -> dict[str, object]:
    return {
        "version": 1,
        "job_id": "guard-test",
        "purpose": "verify physical workflow guards",
        "operation": "inspect",
        "next_action": {
            "instruction": "Paste the complete output into ChatGPT.",
            "expected_result": "A concrete next operation is provided.",
            "state_change": False,
        },
    }


def test_safe_rel_path_allows_only_dependency_root_files():
    gate = _load_gate()
    roots = (
        "src/",
        "tests/",
        ".github/",
        "scripts/",
        "db/",
        "docs/",
        ".githooks/",
    )

    assert gate.safe_rel_path("pyproject.toml", roots=roots) == "pyproject.toml"
    assert gate.safe_rel_path("uv.lock", roots=roots) == "uv.lock"
    assert ".toml" in gate.TEXT_SUFFIXES
    assert ".lock" in gate.TEXT_SUFFIXES

    with pytest.raises(gate.GateReject, match="path outside approved roots"):
        gate.safe_rel_path("package.json", roots=roots)
    with pytest.raises(gate.GateReject, match="path outside approved roots"):
        gate.safe_rel_path("pyproject.toml.bak", roots=roots)


def test_remote_gate_allows_protected_only_policy_changes_with_guard_tests():
    workflow = Path(".github/workflows/ai-workflow-gate.yml").read_text(
        encoding="utf-8",
    )

    assert 'echo "policy_update=false" >> "${GITHUB_OUTPUT}"' in workflow
    assert 'echo "policy_update=true" >> "${GITHUB_OUTPUT}"' in workflow
    assert "Protected AI gate changes must not include non-protected files:" in workflow
    assert "ref: ${{ github.event.pull_request.head.sha }}" in workflow
    assert "persist-credentials: false" in workflow
    assert "tests/operations/test_ai_workflow_gate.py" in workflow
    assert "tests/operations/test_ai_workflow_execution_guards.py" in workflow
    assert "--confcutdir=tests/operations" in workflow
    assert 'GH_TOKEN: \'\'' in workflow
    assert 'echo "AI_WORKFLOW_REMOTE_GATE=PASS"' in workflow


def test_plan_requires_next_action():
    gate = _load_gate()
    plan = _valid_plan()
    plan.pop("next_action")

    with pytest.raises(gate.GateReject, match="plan.next_action required"):
        gate.validate_plan(plan)


def test_plan_rejects_multiline_next_action():
    gate = _load_gate()
    plan = _valid_plan()
    plan["next_action"] = {
        "instruction": "first line\nsecond line",
        "expected_result": "result",
        "state_change": False,
    }

    with pytest.raises(gate.GateReject, match="must be one line"):
        gate.validate_plan(plan)


def test_plan_prints_required_next_action(capsys):
    gate = _load_gate()
    plan = _valid_plan()

    gate.validate_plan(plan)
    gate.print_next_action(plan)

    output = capsys.readouterr().out
    assert "NEXT_ACTION_REQUIRED=1" in output
    assert "NEXT_ACTION_INSTRUCTION=Paste the complete output into ChatGPT." in output
    assert "NEXT_ACTION_EXPECTED_RESULT=A concrete next operation is provided." in output
    assert "NEXT_ACTION_STATE_CHANGE=false" in output


def test_state_change_requires_runner_authorization(monkeypatch):
    gate = _load_gate()
    monkeypatch.setattr(gate, "publish_guard_token", lambda: "a" * 64)
    monkeypatch.delenv("KANADE_AI_RUNNER_TOKEN", raising=False)

    with pytest.raises(gate.GateReject, match="must run through scripts/run_ai_job.ps1"):
        gate.require_runner_authorization()

    monkeypatch.setenv("KANADE_AI_RUNNER_TOKEN", "a" * 64)
    gate.require_runner_authorization()


def test_runner_never_exports_publish_token_directly():
    runner = Path("scripts/run_ai_job.ps1").read_text(encoding="utf-8")

    assert "KANADE_AI_RUNNER_TOKEN" in runner
    assert 'SetEnvironmentVariable("KANADE_AI_PUBLISH_TOKEN"' not in runner
    assert "Install-PublishGuard -Repo $repo" in runner
    assert "NEXT_ACTION_REQUIRED=1" in runner


def test_publish_token_is_scoped_to_deploy_subprocess():
    gate_source = Path("scripts/ai_workflow_gate.py").read_text(encoding="utf-8")

    assert 'deploy_env["KANADE_AI_PUBLISH_TOKEN"] = publish_guard_token()' in gate_source
    assert "run(argv, cwd=ROOT, capture=False, env=deploy_env)" in gate_source
    assert "require_runner_authorization()" in gate_source



def test_write_evidence_is_keyed_and_signed(tmp_path, monkeypatch):
    import hashlib
    import json

    gate = _load_gate()
    monkeypatch.setattr(gate, "EVIDENCE_DIR", tmp_path)
    monkeypatch.setattr(gate, "publish_guard_token", lambda: "a" * 64)

    path = gate.write_evidence(
        job_id="signed-evidence",
        contract={"id": "contract", "goal": "goal"},
        verification={
            "files": ["src/index.html"],
            "content_hash": "b" * 64,
            "integrity": {},
            "tests": [],
        },
        source_operation="policy_update",
    )

    evidence = json.loads(path.read_text(encoding="utf-8"))
    signature = evidence.pop("evidence_signature")
    canonical = json.dumps(
        evidence,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    expected = hashlib.blake2b(
        canonical,
        key=bytes.fromhex("a" * 64),
        digest_size=32,
    ).hexdigest()

    assert signature == expected


def test_validate_existing_change_evidence_is_committable(tmp_path, monkeypatch):
    gate = _load_gate()
    monkeypatch.setattr(gate, "EVIDENCE_DIR", tmp_path)
    monkeypatch.setattr(gate, "publish_guard_token", lambda: "a" * 64)

    path = gate.write_evidence(
        job_id="validated-existing",
        contract={"id": "contract", "goal": "goal"},
        verification={
            "files": ["src/index.html"],
            "content_hash": "b" * 64,
            "integrity": {},
            "tests": [],
        },
        source_operation="validate_existing_change",
    )

    assert gate.evidence_for_job("validated-existing")["source_operation"] == (
        "validate_existing_change"
    )
    assert path.is_file()



def test_gate_requires_cr_at_eol_compatibility():
    gate_source = Path("scripts/ai_workflow_gate.py").read_text(encoding="utf-8")
    expected = "core.whitespace=trailing-space,space-before-tab,cr-at-eol"
    assert gate_source.count(expected) == 4


def test_pre_commit_requires_v4_signed_evidence_and_runner_token():
    hook = Path(".githooks/pre-commit").read_text(encoding="utf-8")

    assert "KANADE_AI_RUNNER_TOKEN" in hook
    assert 'evidence.get("runner_version") != 4' in hook
    assert '"validate_existing_change"' in hook
    assert '"apply_change"' in hook
    assert '"policy_update"' in hook
    assert 'evidence.get("job_id") != evidence_path.stem' in hook
    assert 'signature = evidence.get("evidence_signature")' in hook
    assert "hashlib.blake2b(" in hook
    assert "key=bytes.fromhex(runner_token)" in hook



def test_evidence_for_job_requires_valid_signature(tmp_path, monkeypatch):
    import hashlib
    import json

    gate = _load_gate()
    monkeypatch.setattr(gate, "EVIDENCE_DIR", tmp_path)
    monkeypatch.setattr(gate, "publish_guard_token", lambda: "a" * 64)

    unsigned = {
        "version": 1,
        "runner_version": 4,
        "source_operation": "policy_update",
        "job_id": "signed-job",
        "contract_id": "contract",
        "goal": "goal",
        "files": ["src/index.html"],
        "content_hash": "b" * 64,
        "integrity": {},
        "tests": [],
        "gate": "PASS",
    }
    canonical = json.dumps(
        unsigned,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    signature = hashlib.blake2b(
        canonical,
        key=bytes.fromhex("a" * 64),
        digest_size=32,
    ).hexdigest()
    payload = dict(unsigned)
    payload["evidence_signature"] = signature

    evidence_path = tmp_path / "signed-job.json"
    evidence_path.write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )

    evidence = gate.evidence_for_job("signed-job")
    assert evidence["evidence_signature"] == signature

    payload["evidence_signature"] = "0" * 64
    evidence_path.write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )
    with pytest.raises(gate.GateReject, match="evidence signature is invalid"):
        gate.evidence_for_job("signed-job")


def test_evidence_for_job_rejects_unsigned_legacy_shape(
    tmp_path,
    monkeypatch,
):
    import json

    gate = _load_gate()
    monkeypatch.setattr(gate, "EVIDENCE_DIR", tmp_path)
    monkeypatch.setattr(gate, "publish_guard_token", lambda: "a" * 64)

    legacy = {
        "version": 1,
        "job_id": "bootstrap-json-only-gate-v4-20260812",
        "contract_id": "bootstrap-json-only-gate-v4",
        "files": [
            "scripts/ai_workflow_gate.py",
            "tests/operations/test_ai_workflow_gate.py",
        ],
        "content_hash": "b" * 64,
        "gate": "PASS",
    }
    (tmp_path / "legacy.json").write_text(
        json.dumps(legacy, ensure_ascii=False),
        encoding="utf-8",
    )

    with pytest.raises(
        gate.GateReject,
        match="evidence was not created by JSON-only runner version 4",
    ):
        gate.evidence_for_job("legacy")


def test_pre_commit_accepts_only_matching_signed_validate_evidence(tmp_path):
    repo = tmp_path / "repo"
    hook_dir = repo / ".githooks"
    evidence_dir = repo / ".ai-gate" / "evidence"
    hook_dir.mkdir(parents=True)
    evidence_dir.mkdir(parents=True)
    hook = hook_dir / "pre-commit"
    hook.write_bytes(Path(".githooks/pre-commit").read_bytes())

    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    for key, value in (
        ("user.email", "gate-test@example.invalid"),
        ("user.name", "Gate Test"),
        ("core.autocrlf", "false"),
    ):
        subprocess.run(["git", "config", key, value], cwd=repo, check=True)
    target = repo / "src" / "demo.py"
    target.parent.mkdir()
    target.write_text("before\n", encoding="utf-8", newline="\n")
    subprocess.run(["git", "add", "src/demo.py"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True)
    target.write_text("after\n", encoding="utf-8", newline="\n")
    subprocess.run(["git", "add", "src/demo.py"], cwd=repo, check=True)

    files = ["src/demo.py"]
    digest = hashlib.sha256()
    for rel in files:
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update((repo / rel).read_bytes())
        digest.update(b"\0")

    def write_evidence(name: str, payload: dict[str, object]) -> None:
        unsigned = dict(payload)
        canonical = json.dumps(
            unsigned,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        payload["evidence_signature"] = hashlib.blake2b(
            canonical,
            key=bytes.fromhex("a" * 64),
            digest_size=32,
        ).hexdigest()
        (evidence_dir / f"{name}.json").write_text(
            json.dumps(payload, ensure_ascii=False),
            encoding="utf-8",
        )

    payload = {
        "gate": "PASS",
        "runner_version": 4,
        "source_operation": "validate_existing_change",
        "job_id": "validated-job",
        "files": files,
        "content_hash": digest.hexdigest(),
    }
    write_evidence("validated-job", payload)
    environment = dict(os.environ, KANADE_AI_RUNNER_TOKEN="a" * 64)
    accepted = subprocess.run(
        [sys.executable, str(hook)], cwd=repo, env=environment, capture_output=True, text=True
    )
    assert accepted.returncode == 0, accepted.stderr

    for field, value in (
        ("content_hash", "0" * 64),
        ("files", []),
        ("job_id", "other-job"),
    ):
        tampered = dict(payload)
        tampered[field] = value
        tampered.pop("evidence_signature", None)
        write_evidence("validated-job", tampered)
        rejected = subprocess.run(
            [sys.executable, str(hook)], cwd=repo, env=environment, capture_output=True, text=True
        )
        assert rejected.returncode == 2

    invalid_signature = dict(payload)
    invalid_signature["evidence_signature"] = "0" * 64
    (evidence_dir / "validated-job.json").write_text(
        json.dumps(invalid_signature, ensure_ascii=False), encoding="utf-8"
    )
    rejected = subprocess.run(
        [sys.executable, str(hook)], cwd=repo, env=environment, capture_output=True, text=True
    )
    assert rejected.returncode == 2



def test_validate_plan_allows_publish_branch_only_with_publish_keys():
    gate = _load_gate()

    plan = {
        "version": 1,
        "job_id": "publish-branch-test",
        "purpose": "Publish validated branch",
        "operation": "publish_branch",
        "target_branch": "feat/example",
        "expected_head": "1" * 40,
        "remote": "origin",
        "next_action": {
            "instruction": "Inspect publish result.",
            "expected_result": "Remote branch matches expected HEAD.",
            "state_change": False,
        },
    }
    gate.validate_plan(plan)

    invalid = dict(plan)
    invalid.pop("expected_head")
    with pytest.raises(
        gate.GateReject,
        match="publish_branch missing plan keys",
    ):
        gate.validate_plan(invalid)

    inspect_plan = {
        "version": 1,
        "job_id": "inspect-with-publish-key",
        "purpose": "Inspect",
        "operation": "inspect",
        "target_branch": "feat/example",
        "next_action": {
            "instruction": "Inspect result.",
            "expected_result": "Repository state is shown.",
            "state_change": False,
        },
    }
    with pytest.raises(
        gate.GateReject,
        match="publish-only plan keys are not allowed",
    ):
        gate.validate_plan(inspect_plan)


def test_publish_branch_scopes_token_and_verifies_remote(monkeypatch):
    from types import SimpleNamespace

    gate = _load_gate()
    monkeypatch.setattr(gate, "repo_clean", lambda **_kwargs: True)
    monkeypatch.setattr(
        gate,
        "git_branch",
        lambda **_kwargs: "feat/example",
    )
    monkeypatch.setattr(
        gate,
        "git_head",
        lambda **_kwargs: "1" * 40,
    )
    monkeypatch.setattr(
        gate,
        "publish_guard_token",
        lambda: "a" * 64,
    )
    monkeypatch.setattr(gate, "executable", lambda name: name)

    calls = []

    def fake_run(argv, **kwargs):
        calls.append((list(argv), dict(kwargs)))
        if argv[1:3] == ["check-ref-format", "--branch"]:
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if argv[1:4] == ["config", "--get", "remote.origin.url"]:
            return SimpleNamespace(
                returncode=0,
                stdout=(
                    "https://github.com/clryo26/"
                    "kanade-orchestra.git\n"
                ),
                stderr="",
            )
        if argv[1:3] == ["push", "origin"]:
            assert (
                kwargs["env"]["KANADE_AI_PUBLISH_TOKEN"]
                == "a" * 64
            )
            assert "--force" not in argv
            assert "--force-with-lease" not in argv
            assert argv[-1] == "HEAD:refs/heads/feat/example"
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if argv[1:3] == ["ls-remote", "--heads"]:
            assert "env" not in kwargs
            return SimpleNamespace(
                returncode=0,
                stdout=(
                    ("1" * 40)
                    + "\trefs/heads/feat/example\n"
                ),
                stderr="",
            )
        raise AssertionError(f"unexpected git argv: {argv!r}")

    monkeypatch.setattr(gate, "run", fake_run)

    gate.publish_branch(
        {
            "job_id": "publish-branch-test",
            "target_branch": "feat/example",
            "expected_head": "1" * 40,
            "remote": "origin",
        },
        allow_state_change=True,
    )

    assert any(
        call[0][1:3] == ["push", "origin"]
        for call in calls
    )
    assert any(
        call[0][1:3] == ["ls-remote", "--heads"]
        for call in calls
    )


def test_publish_branch_rejects_base_branch_and_head_mismatch(
    monkeypatch,
):
    gate = _load_gate()
    monkeypatch.setattr(gate, "repo_clean", lambda **_kwargs: True)

    with pytest.raises(
        gate.GateReject,
        match="refuses protected base branch",
    ):
        gate.publish_branch(
            {
                "job_id": "publish-main",
                "target_branch": "main",
                "expected_head": "1" * 40,
                "remote": "origin",
            },
            allow_state_change=True,
        )

    monkeypatch.setattr(gate, "executable", lambda name: name)
    monkeypatch.setattr(
        gate,
        "run",
        lambda *_args, **_kwargs: type(
            "Result",
            (),
            {"returncode": 0, "stdout": "", "stderr": ""},
        )(),
    )
    monkeypatch.setattr(
        gate,
        "git_branch",
        lambda **_kwargs: "feat/example",
    )
    monkeypatch.setattr(
        gate,
        "git_head",
        lambda **_kwargs: "2" * 40,
    )

    with pytest.raises(
        gate.GateReject,
        match="publish_branch HEAD mismatch",
    ):
        gate.publish_branch(
            {
                "job_id": "publish-head-mismatch",
                "target_branch": "feat/example",
                "expected_head": "1" * 40,
                "remote": "origin",
            },
            allow_state_change=True,
        )
