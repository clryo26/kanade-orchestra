from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts" / "ai_workflow_gate.py"


def _load_gate():
    spec = importlib.util.spec_from_file_location(
        "ai_workflow_gate_for_eol_test", RUNNER
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


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


def test_verify_text_file_rejects_mixed_eol_by_default(tmp_path, monkeypatch):
    gate = _load_gate()
    path = tmp_path / "mixed.txt"
    path.write_bytes(b"first\r\nsecond\n")
    monkeypatch.setattr(gate, "git_bytes", lambda *args, **kwargs: path.read_bytes())

    with pytest.raises(gate.GateReject, match="mixed line endings"):
        gate.verify_text_file(path, "mixed.txt", base_ref="HEAD", cwd=tmp_path)


def test_verify_text_file_allows_existing_mixed_eol_only(tmp_path, monkeypatch):
    gate = _load_gate()
    path = tmp_path / "mixed.txt"
    base = b"first\r\nsecond\n"
    path.write_bytes(b"first\r\nupdated\n")
    monkeypatch.setattr(gate, "git_bytes", lambda *args, **kwargs: base)

    result = gate.verify_text_file(
        path,
        "mixed.txt",
        base_ref="HEAD",
        cwd=tmp_path,
        allow_mixed_eol=True,
    )

    assert result["eol"] == "MIXED"
    assert result["base_eol"] == "MIXED"


@pytest.mark.parametrize(
    ("base", "current"),
    [
        (b"first\nsecond\n", b"first\r\nupdated\n"),
        (b"first\r\nsecond\n", b"first\nupdated\n"),
    ],
    ids=["lf-base-to-mixed", "mixed-base-to-lf"],
)
def test_verify_text_file_rejects_other_mixed_eol_transitions(
    tmp_path, monkeypatch, base, current
):
    gate = _load_gate()
    path = tmp_path / "mixed.txt"
    path.write_bytes(current)
    monkeypatch.setattr(gate, "git_bytes", lambda *args, **kwargs: base)

    with pytest.raises(gate.GateReject):
        gate.verify_text_file(
            path,
            "mixed.txt",
            base_ref="HEAD",
            cwd=tmp_path,
            allow_mixed_eol=True,
        )
