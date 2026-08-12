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



def test_crlf_diff_and_eol_integrity_guards(tmp_path):
    import subprocess
    gate = _load_gate()
    def init_repo(name, eol=None):
        repo = tmp_path / name; repo.mkdir()
        for argv in (["git", "init", "-q"], ["git", "config", "core.autocrlf", "false"], ["git", "config", "user.email", "gate@example.test"], ["git", "config", "user.name", "Gate Test"]):
            subprocess.run(argv, cwd=repo, check=True)
        if eol: subprocess.run(["git", "config", "core.eol", eol], cwd=repo, check=True)
        return repo
    repo_a = init_repo("crlf")
    target_a = repo_a / "sample.py"; target_a.write_bytes(b"a\r\nb\r\n")
    subprocess.run(["git", "add", "sample.py"], cwd=repo_a, check=True); subprocess.run(["git", "commit", "-qm", "base"], cwd=repo_a, check=True)
    target_a.write_bytes(b"a\r\nc\r\n")
    assert subprocess.run(["git", "-c", "core.whitespace=trailing-space,space-before-tab,cr-at-eol", "diff", "--check", "HEAD"], cwd=repo_a).returncode == 0
    target_a.write_bytes(b"a \r\nc\r\n")
    assert subprocess.run(["git", "-c", "core.whitespace=trailing-space,space-before-tab,cr-at-eol", "diff", "--check", "HEAD"], cwd=repo_a).returncode != 0
    with pytest.raises(gate.GateReject, match="mixed line endings"): gate.decode_text_file(b"a\r\nb\n", rel="sample.py")
    with pytest.raises(gate.GateReject, match="mixed line endings: sample.py"): gate.decode_text_file(b"a\rb", rel="sample.py")
    repo_b = init_repo("lf", "lf")
    target_b = repo_b / "sample.py"; target_b.write_bytes(b"a\nb\n")
    subprocess.run(["git", "add", "sample.py"], cwd=repo_b, check=True); subprocess.run(["git", "commit", "-qm", "base"], cwd=repo_b, check=True)
    assert subprocess.run(["git", "show", "HEAD:sample.py"], cwd=repo_b, capture_output=True, check=True).stdout == b"a\nb\n"
    target_b.write_bytes(b"a\r\nb\r\n")
    with pytest.raises(gate.GateReject, match="EOL changed unexpectedly"): gate.verify_text_file(target_b, "sample.py", base_ref="HEAD", cwd=repo_b)


def test_pre_commit_requires_v4_signed_evidence_and_runner_token():
    hook = Path(".githooks/pre-commit").read_text(encoding="utf-8")

    assert "KANADE_AI_RUNNER_TOKEN" in hook
    assert 'evidence.get("runner_version") != 4' in hook
    assert (
        'evidence.get("source_operation") not in '
        '{"apply_change", "policy_update", "validate_existing_change"}'
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


def test_final_main_passes_allow_state_change_to_existing_validation():
    import ast
    module = ast.parse(Path("scripts/ai_workflow_gate.py").read_text(encoding="utf-8"))
    validators = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "validate_existing_change"]
    mains = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "main"]
    assert len(validators) == 2 and validators[-1].args.kwonlyargs[-1].arg == "allow_state_change"
    calls = [node for node in ast.walk(mains[-1]) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "validate_existing_change"]
    assert len(calls) == 1 and any(keyword.arg == "allow_state_change" for keyword in calls[0].keywords)


def test_existing_change_evidence_is_signed_only_after_verification(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace
    gate = _load_gate(); monkeypatch.setattr(gate, "EVIDENCE_DIR", gate.ROOT / ".ai-gate" / "evidence"); monkeypatch.setattr(gate, "publish_guard_token", lambda: "a" * 64)
    contract = tmp_path / "contract.json"; contract.write_text(json.dumps({"id":"c","goal":"g"}), encoding="utf-8")
    result = {"files":["src/index.html"],"content_hash":"b"*64,"integrity":{},"tests":[{"returncode":0}]}
    monkeypatch.setattr(gate, "verify_change_against_contract", lambda *args, **kwargs: result)
    gate.validate_existing_change(SimpleNamespace(contract=contract, operations=None), {"job_id":"ok","contract_id":"c"}, allow_state_change=True)
    evidence = json.loads((gate.EVIDENCE_DIR / "ok.json").read_text(encoding="utf-8"))
    assert evidence["runner_version"] == 4 and evidence["source_operation"] == "validate_existing_change" and evidence["files"] == result["files"] and evidence["content_hash"] == result["content_hash"] and evidence["evidence_signature"]
    monkeypatch.setattr(gate, "verify_change_against_contract", lambda *args, **kwargs: (_ for _ in ()).throw(gate.GateReject("required test failed")))
    with pytest.raises(gate.GateReject): gate.validate_existing_change(SimpleNamespace(contract=contract, operations=None), {"job_id":"bad","contract_id":"c"}, allow_state_change=True)
    assert not (gate.EVIDENCE_DIR / "bad.json").exists()


def test_existing_change_commit_and_rejection_paths_use_isolated_repo(tmp_path, monkeypatch):
    import json
    import subprocess
    from types import SimpleNamespace

    gate = _load_gate()

    def make_repo(name, *, required_tests=None):
        repo = tmp_path / name; (repo / "src").mkdir(parents=True)
        for argv in (["git", "init", "-q"], ["git", "config", "user.email", "gate@example.test"], ["git", "config", "user.name", "Gate Test"]): subprocess.run(argv, cwd=repo, check=True)
        target = repo / "src" / "changed.txt"; target.write_bytes(b"base\n")
        subprocess.run(["git", "add", "."], cwd=repo, check=True); subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
        target.write_bytes(b"changed\n")
        contract = {"version": 1, "id": "existing", "goal": "existing", "allowed_files": ["src/changed.txt"], "required_changed_files": ["src/changed.txt"], "required_tests": required_tests or [], "assertions": []}
        path = repo.parent / "contract.json"; path.write_text(json.dumps(contract), encoding="utf-8")
        return repo, target, SimpleNamespace(contract=path, operations=None), {"job_id": "existing", "contract_id": "existing"}

    monkeypatch.setattr(gate, "publish_guard_token", lambda: "a" * 64)
    repo, target, job, plan = make_repo("success")
    monkeypatch.setattr(gate, "ROOT", repo); monkeypatch.setattr(gate, "EVIDENCE_DIR", repo / ".ai-gate" / "evidence")
    gate.validate_existing_change(job, plan, allow_state_change=True)
    assert (gate.EVIDENCE_DIR / "existing.json").is_file()
    gate.commit_validated_change({**plan, "commit_message": "test: isolated evidence"}, allow_state_change=True)
    assert subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True).stdout == ""

    for name, mutate, message in [("content", lambda r, p: p.write_text("tampered\n", encoding="utf-8"), "content hash differs"), ("extra", lambda r, p: (r / "src" / "other.txt").write_text("extra\n", encoding="utf-8"), "changed files differ")]:
        repo, target, job, plan = make_repo(name); monkeypatch.setattr(gate, "ROOT", repo); monkeypatch.setattr(gate, "EVIDENCE_DIR", repo / ".ai-gate" / "evidence")
        gate.validate_existing_change(job, plan, allow_state_change=True); mutate(repo, target)
        with pytest.raises(gate.GateReject, match=message): gate.commit_validated_change({**plan, "commit_message": "test: reject"}, allow_state_change=True)


def test_existing_change_validation_rejects_outside_no_change_and_test_failure(tmp_path, monkeypatch):
    import json
    import subprocess
    from types import SimpleNamespace
    gate = _load_gate(); monkeypatch.setattr(gate, "publish_guard_token", lambda: "a" * 64)
    def repo(name, change=True, tests=None, outside=False):
        r = tmp_path / name; (r / "src").mkdir(parents=True); subprocess.run(["git", "init", "-q"], cwd=r, check=True); subprocess.run(["git", "config", "user.email", "x@y.z"], cwd=r, check=True); subprocess.run(["git", "config", "user.name", "x"], cwd=r, check=True)
        p=r/"src"/"one.txt"; p.write_bytes(b"base\n"); subprocess.run(["git", "add", "."], cwd=r, check=True); subprocess.run(["git", "commit", "-qm", "base"], cwd=r, check=True)
        if change: p.write_bytes(b"changed\n")
        if outside: (r/"src"/"other.txt").write_text("outside\n")
        c={"version":1,"id":"c","goal":"g","allowed_files":["src/one.txt"],"required_changed_files":["src/one.txt"],"required_tests":tests or [],"assertions":[]}; cp=r.parent/"contract.json"; cp.write_text(json.dumps(c)); return r,SimpleNamespace(contract=cp,operations=None)
    for name,kwargs in [("outside",{"outside":True}),("none",{"change":False}),("failed",{"tests":[{"kind":"pytest","paths":["tests/missing.py"]}]})]:
        r,j=repo(name,**kwargs); monkeypatch.setattr(gate,"ROOT",r); monkeypatch.setattr(gate,"EVIDENCE_DIR",r/".ai-gate"/"evidence")
        with pytest.raises(gate.GateReject): gate.validate_existing_change(j,{"job_id":name,"contract_id":"c"},allow_state_change=True)
        assert not (gate.EVIDENCE_DIR/f"{name}.json").exists()


def test_existing_change_evidence_precommit_accepts_only_matching_signed_staged_content(tmp_path):
    import hashlib, json, os, subprocess, sys
    repo=tmp_path/"hook"; (repo/".githooks").mkdir(parents=True); (repo/"src").mkdir()
    for argv in (["git","init","-q"],["git","config","user.email","x@y.z"],["git","config","user.name","x"]): subprocess.run(argv,cwd=repo,check=True)
    target=repo/"src"/"one.txt"; target.write_text("base\n"); subprocess.run(["git","add","."],cwd=repo,check=True); subprocess.run(["git","commit","-qm","base"],cwd=repo,check=True); target.write_text("changed\n"); subprocess.run(["git","add","src/one.txt"],cwd=repo,check=True)
    hook=(repo/".githooks"/"pre-commit"); hook.write_text(Path(".githooks/pre-commit").read_text(encoding="utf-8"),encoding="utf-8")
    files=["src/one.txt"]; token="a"*64; h=hashlib.sha256(); h.update(b"src/one.txt\0"); h.update(target.read_bytes()); h.update(b"\0")
    payload={"version":1,"runner_version":4,"source_operation":"validate_existing_change","job_id":"ok","contract_id":"c","goal":"g","files":files,"content_hash":h.hexdigest(),"integrity":{},"tests":[],"gate":"PASS"}; canonical=json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(",",":"),).encode(); payload["evidence_signature"]=hashlib.blake2b(canonical,key=bytes.fromhex(token),digest_size=32).hexdigest(); evidence=repo/".ai-gate"/"evidence"; evidence.mkdir(parents=True); (evidence/"ok.json").write_text(json.dumps(payload),encoding="utf-8")
    env={**os.environ,"KANADE_AI_RUNNER_TOKEN":token}; assert subprocess.run([sys.executable,str(hook)],cwd=repo,env=env).returncode==0
    target.write_text("tampered\n"); assert subprocess.run([sys.executable,str(hook)],cwd=repo,env=env).returncode!=0
    target.write_text("changed\n"); (repo/"src"/"two.txt").write_text("x\n"); subprocess.run(["git","add","src/two.txt"],cwd=repo,check=True); assert subprocess.run([sys.executable,str(hook)],cwd=repo,env=env).returncode!=0
    (evidence/"ok.json").write_text(json.dumps({**payload,"evidence_signature":"0"*64}),encoding="utf-8"); assert subprocess.run([sys.executable,str(hook)],cwd=repo,env=env).returncode!=0


def test_existing_change_prints_pass_only_after_evidence(capsys, tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace
    gate=_load_gate(); contract=tmp_path/"contract.json"; contract.write_text(json.dumps({"id":"c","goal":"g"}),encoding="utf-8")
    monkeypatch.setattr(gate,"verify_change_against_contract",lambda *a,**k:{"files":[],"content_hash":"x","integrity":{},"tests":[]}); monkeypatch.setattr(gate,"write_evidence",lambda **k: (_ for _ in ()).throw(gate.GateReject("evidence failed")))
    with pytest.raises(gate.GateReject): gate.validate_existing_change(SimpleNamespace(contract=contract,operations=None),{"job_id":"x","contract_id":"c"},allow_state_change=True)
    assert "AI_WORKFLOW_GATE=PASS" not in capsys.readouterr().out
