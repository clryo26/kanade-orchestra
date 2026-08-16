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


def test_validate_existing_change_creates_commit_evidence():
    gate_source = Path("scripts/ai_workflow_gate.py").read_text(encoding="utf-8")
    start = gate_source.index("def validate_existing_change(")
    end = gate_source.index("\ndef publish_guard_token", start)
    section = gate_source[start:end]

    assert 'source_operation="apply_change"' in section
    assert 'print(f"EVIDENCE={evidence.relative_to(ROOT)}")' in section
    assert "COMMIT_EVIDENCE=NOT_CREATED" not in section



def test_gate_has_no_cr_at_eol_compatibility():
    gate_source = Path("scripts/ai_workflow_gate.py").read_text(encoding="utf-8")
    assert "cr-at-eol" not in gate_source


def test_pre_commit_requires_v4_signed_evidence_and_runner_token():
    hook = Path(".githooks/pre-commit").read_text(encoding="utf-8")

    assert "KANADE_AI_RUNNER_TOKEN" in hook
    assert 'evidence.get("runner_version") != 4' in hook
    assert (
        'evidence.get("source_operation") not in '
        '{"apply_change", "policy_update"}'
    ) in hook
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
