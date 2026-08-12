from __future__ import annotations

import importlib.util
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
