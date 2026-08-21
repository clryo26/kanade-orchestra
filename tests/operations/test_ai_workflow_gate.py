from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts" / "ai_workflow_gate.py"


def make_job(
    tmp_path: Path,
    *,
    plan: dict,
    contract: dict | None = None,
    operations: dict | None = None,
) -> Path:
    files: dict[str, bytes] = {
        "plan.json": (
            json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
    }
    if contract is not None:
        files["contract.json"] = (
            json.dumps(contract, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
    if operations is not None:
        files["operations.json"] = (
            json.dumps(operations, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")

    manifest = {
        "version": 1,
        "sha256": {
            name: hashlib.sha256(data).hexdigest()
            for name, data in files.items()
        },
    }
    files["manifest.json"] = (
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")

    job = tmp_path / "job.zip"
    with zipfile.ZipFile(job, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return job


def run_job(job: Path, *extra: str):
    return subprocess.run(
        [sys.executable, str(RUNNER), str(job), *extra],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def test_rejects_raw_command_key(tmp_path):
    job = make_job(
        tmp_path,
        plan={
            "version": 1,
            "job_id": "bad-command",
            "purpose": "must reject raw command",
            "operation": "inspect",
            "command": "Remove-Item -Recurse -Force .",
        },
    )
    result = run_job(job)
    assert result.returncode == 2
    assert "raw command/shell field forbidden" in result.stderr


def test_rejects_unknown_zip_member(tmp_path):
    job = make_job(
        tmp_path,
        plan={
            "version": 1,
            "job_id": "extra-file",
            "purpose": "reject unexpected file",
            "operation": "inspect",
        },
    )
    with zipfile.ZipFile(job, "a") as zf:
        zf.writestr("evil.ps1", "Write-Host bad")
    result = run_job(job)
    assert result.returncode == 2
    assert "unexpected file(s)" in result.stderr


def test_rejects_change_patch_member(tmp_path):
    job = make_job(
        tmp_path,
        plan={
            "version": 1,
            "job_id": "reject-patch",
            "purpose": "patch files must be physically rejected",
            "operation": "inspect",
            "next_action": {
                "instruction": "Do not apply repository changes.",
                "expected_result": "The patch member is rejected.",
                "state_change": False,
            },
        },
    )
    with zipfile.ZipFile(job, "a") as zf:
        zf.writestr("change.patch", "forbidden")
    result = run_job(job)
    assert result.returncode == 2
    assert "unexpected file(s)" in result.stderr


def test_rejects_hash_tampering(tmp_path):
    job = make_job(
        tmp_path,
        plan={
            "version": 1,
            "job_id": "tamper",
            "purpose": "detect modified plan",
            "operation": "inspect",
        },
    )
    with zipfile.ZipFile(job, "a") as zf:
        zf.writestr(
            "plan.json",
            json.dumps(
                {
                    "version": 1,
                    "job_id": "tamper",
                    "purpose": "modified",
                    "operation": "inspect",
                }
            ),
        )
    result = run_job(job)
    assert result.returncode == 2


def test_apply_change_requires_state_change_flag(tmp_path):
    contract = {
        "version": 1,
        "id": "demo",
        "goal": "demo",
        "allowed_files": ["src/index.html"],
        "required_changed_files": ["src/index.html"],
        "required_tests": [],
        "assertions": [],
    }
    operations = {
        "format_version": 1,
        "project": "kanade-orchestra",
        "purpose": "demo",
        "base_commit": "0" * 40,
        "target_branch": "demo",
        "operations": [
            {
                "path": "src/index.html",
                "operation": "replace_exact",
                "expected_sha256": "0" * 64,
                "expected_occurrences": 1,
                "old": "a",
                "new": "b",
            }
        ],
        "post_checks": [
            "encoding_eol",
            "syntax",
            "contract",
            "diff",
            "tests",
        ],
    }
    job = make_job(
        tmp_path,
        plan={
            "version": 1,
            "job_id": "apply-no-flag",
            "purpose": "must require explicit state change",
            "operation": "apply_change",
            "contract_id": "demo",
            "next_action": {
                "instruction": "Do not apply any repository change.",
                "expected_result": "The missing state-change flag is rejected before applying changes.",
                "state_change": False,
            },
        },
        contract=contract,
        operations=operations,
    )
    result = run_job(job)
    assert result.returncode == 2
    assert "requires --allow-state-change" in result.stderr


def test_validate_existing_change_requires_runner_authorization_in_active_main(
    tmp_path,
    monkeypatch,
):
    monkeypatch.delenv("KANADE_AI_RUNNER_TOKEN", raising=False)
    contract = {
        "version": 1,
        "id": "validate-existing-demo",
        "goal": "validate existing change only through the runner",
        "allowed_files": ["src/index.html"],
        "required_changed_files": ["src/index.html"],
        "required_tests": [],
        "assertions": [],
    }
    job = make_job(
        tmp_path,
        plan={
            "version": 1,
            "job_id": "validate-existing-no-runner",
            "purpose": "must require the state-changing runner path",
            "operation": "validate_existing_change",
            "contract_id": "validate-existing-demo",
            "next_action": {
                "instruction": "Do not create commit evidence directly.",
                "expected_result": "The runner authorization check rejects direct execution.",
                "state_change": False,
            },
        },
        contract=contract,
    )

    no_flag = run_job(job)
    assert no_flag.returncode == 2
    assert "validate_existing_change requires --allow-state-change" in no_flag.stderr

    # Use an isolated Git repository so this assertion never depends on a
    # developer-local publish token in the real repository common directory.
    isolated_repo = tmp_path / "isolated-gate-repo"
    (isolated_repo / "scripts").mkdir(parents=True)
    shutil.copy2(RUNNER, isolated_repo / "scripts" / "ai_workflow_gate.py")
    subprocess.run(["git", "init"], cwd=isolated_repo, check=True, capture_output=True)
    (isolated_repo / ".git" / "kanade-ai-publish-token").write_text(
        "a" * 64, encoding="ascii"
    )
    environment = dict(os.environ)
    environment.pop("KANADE_AI_RUNNER_TOKEN", None)
    no_runner = subprocess.run(
        [
            sys.executable,
            str(isolated_repo / "scripts" / "ai_workflow_gate.py"),
            str(job),
            "--allow-state-change",
        ],
        cwd=isolated_repo,
        capture_output=True,
        text=True,
        env=environment,
    )
    assert no_runner.returncode == 2
    assert "must run through scripts/run_ai_job.ps1" in no_runner.stderr


def test_inspect_job_passes(tmp_path):
    job = make_job(
        tmp_path,
        plan={
            "version": 1,
            "job_id": "inspect-pass",
            "purpose": "read current git state",
            "operation": "inspect",
            "next_action": {
                "instruction": "Continue with the next reviewed read-only step.",
                "expected_result": "Inspect succeeds and returns a concrete next-action contract.",
                "state_change": False,
            },
        },
    )
    result = run_job(job)
    assert result.returncode == 0
    assert "AI_WORKFLOW_GATE=PASS" in result.stdout
    assert "OPERATION=inspect" in result.stdout


def _load_gate_module():
    import importlib.util

    module_name = "ai_workflow_gate_mixed_eol_test"
    spec = importlib.util.spec_from_file_location(module_name, RUNNER)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def test_mixed_crlf_lf_input_is_classified_as_mixed():
    gate = _load_gate_module()
    data = b"alpha\r\nbeta\n"

    assert gate.eol_kind(data) == "MIXED"
    text, eol = gate.decode_text_file(data, rel="src/demo.py")

    assert text == "alpha\r\nbeta\n"
    assert "\r" in text
    assert eol == "MIXED"


def test_pure_crlf_input_still_preserves_crlf_policy():
    gate = _load_gate_module()
    data = b"alpha\r\nbeta\r\n"

    assert gate.eol_kind(data) == "CRLF"
    text, eol = gate.decode_text_file(data, rel="src/demo.py")

    assert text == "alpha\nbeta\n"
    assert eol == "CRLF"


def test_diff_check_accepts_preserved_crlf_line_endings(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()

    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "gate-test@example.invalid"],
        cwd=repo,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Gate Test"],
        cwd=repo,
        check=True,
    )

    target = repo / "demo.py"
    target.write_bytes(b"alpha\r\n")
    subprocess.run(["git", "add", "demo.py"], cwd=repo, check=True)
    subprocess.run(
        ["git", "commit", "-m", "base"],
        cwd=repo,
        check=True,
        capture_output=True,
    )

    target.write_bytes(b"alpha\r\nbeta\r\n")
    result = subprocess.run(
        [
            "git",
            "-c",
            "core.whitespace=trailing-space,space-before-tab,cr-at-eol",
            "diff",
            "--check",
            "HEAD",
        ],
        cwd=repo,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr


def test_structured_apply_rejects_mixed_eol_without_writing(tmp_path):
    gate = _load_gate_module()
    target = tmp_path / "src" / "demo.py"
    target.parent.mkdir()
    original = b"alpha\r\nbeta\n"
    target.write_bytes(original)

    operation = {
        "operations": [
            {
                "path": "src/demo.py",
                "operation": "replace_exact",
                "expected_sha256": hashlib.sha256(original).hexdigest(),
                "expected_occurrences": 1,
                "old_text": "alpha\nbeta\n",
                "new_text": "alpha\ngamma\n",
            }
        ]
    }

    with pytest.raises(
        gate.GateReject,
        match="structured apply rejects mixed EOL files; use validate_existing_change",
    ):
        gate.apply_operations(operation, cwd=tmp_path)

    assert target.read_bytes() == original


@pytest.mark.parametrize(
    ("base", "current", "allow", "passes"),
    [
        (b"alpha\r\nbeta\n", b"gamma\r\ndelta\n", True, True),
        (b"alpha\n", b"alpha\r\nbeta\n", True, False),
        (b"alpha\r\nbeta\n", b"alpha\n", True, False),
        (b"alpha\r\n", b"alpha\r\nbeta\n", True, False),
        (b"alpha\r\nbeta\n", b"alpha\r\n", True, False),
    ],
)
def test_verify_text_file_allows_only_existing_mixed_eol(
    tmp_path,
    monkeypatch,
    base,
    current,
    allow,
    passes,
):
    gate = _load_gate_module()
    target = tmp_path / "demo.py"
    target.write_bytes(current)
    monkeypatch.setattr(gate, "git_bytes", lambda *_args, **_kwargs: base)

    if passes:
        result = gate.verify_text_file(
            target,
            "src/demo.py",
            base_ref="HEAD",
            cwd=tmp_path,
            allow_mixed_eol=allow,
        )
        assert result["base_eol"] == "MIXED"
        assert result["eol"] == "MIXED"
    else:
        with pytest.raises(gate.GateReject, match="mixed EOL"):
            gate.verify_text_file(
                target,
                "src/demo.py",
                base_ref="HEAD",
                cwd=tmp_path,
                allow_mixed_eol=allow,
            )


def test_eol_correction_contract_pins_parent_head_current_and_eol(tmp_path):
    gate = _load_gate_module()
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "gate-test@example.invalid"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Gate Test"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "core.autocrlf", "false"],
        cwd=tmp_path,
        check=True,
    )
    target = tmp_path / "src" / "demo.py"
    target.parent.mkdir()
    parent_bytes = b"alpha\r\nbeta\n"
    target.write_bytes(parent_bytes)
    subprocess.run(["git", "add", "src/demo.py"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-m", "parent"], cwd=tmp_path, check=True)
    parent = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True
    ).strip()
    head_bytes = b"alpha\nbeta\n"
    target.write_bytes(head_bytes)
    subprocess.run(["git", "commit", "-am", "lf"], cwd=tmp_path, check=True)
    current_bytes = b"gamma\r\nbeta\n"
    target.write_bytes(current_bytes)

    entry = {
        "path": "src/demo.py",
        "parent_sha256": hashlib.sha256(parent_bytes).hexdigest(),
        "head_sha256": hashlib.sha256(head_bytes).hexdigest(),
        "current_sha256": hashlib.sha256(current_bytes).hexdigest(),
        "parent_eol": "MIXED",
        "head_eol": "LF",
        "current_eol": "MIXED",
    }
    contract = {"eol_correction": {"parent_ref": parent, "files": [entry]}}

    result = gate.validate_eol_correction_contract(
        contract,
        files=["src/demo.py"],
        cwd=tmp_path,
    )
    assert result == {"src/demo.py": {"head_eol": "LF", "current_eol": "MIXED"}}

    bad_parent = {"eol_correction": {"parent_ref": "0" * 40, "files": [entry]}}
    with pytest.raises(gate.GateReject, match="parent_ref"):
        gate.validate_eol_correction_contract(
            bad_parent,
            files=["src/demo.py"],
            cwd=tmp_path,
        )

    wrong_hash = dict(entry)
    wrong_hash["current_sha256"] = "0" * 64
    with pytest.raises(gate.GateReject, match="current SHA mismatch"):
        gate.validate_eol_correction_contract(
            {"eol_correction": {"parent_ref": parent, "files": [wrong_hash]}},
            files=["src/demo.py"],
            cwd=tmp_path,
        )

    with pytest.raises(gate.GateReject, match="exactly match changed files"):
        gate.validate_eol_correction_contract(
            contract,
            files=[],
            cwd=tmp_path,
        )
