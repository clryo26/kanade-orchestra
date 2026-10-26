"""The audit must fail closed and inspect application pins, not tool packages."""

import json
from pathlib import Path
import subprocess

import pytest

from scripts import audit_python_dependencies as module


@pytest.fixture
def project(tmp_path):
    (tmp_path / "Dockerfile").write_text("FROM python:3.10-slim\n", encoding="utf-8")
    (tmp_path / ".python-version").write_text("3.10\n", encoding="utf-8")
    return tmp_path


@pytest.mark.parametrize("text", ["", "# nothing", "pillow>=12", "pillow==12; python_version>'3'",
                                       "pkg @ https://example.invalid/pkg.whl", "--index-url secret"])
def test_rejects_unsafe_or_empty_profile(text):
    with pytest.raises(ValueError):
        module.pins(text)


def test_runtime_interpreters_must_agree(project):
    (project / ".python-version").write_text("3.12", encoding="utf-8")
    with pytest.raises(ValueError):
        module.runtime_python(project)


@pytest.mark.parametrize("case,expected", [
    ("clean", 0), ("findings", 1), ("export_failure", 2), ("compile_failure", 2),
    ("changed_pin", 2), ("empty", 2), ("skipped", 2), ("omitted", 2),
    ("malformed", 2), ("tool_failure", 2), ("timeout", 2),
])
def test_audits_explicit_target_and_preserves_failures(project, monkeypatch, capsys, case, expected):
    calls = []
    files = []
    monkeypatch.setattr(module.shutil, "which", lambda name: "uv")

    def run(command, **kwargs):
        calls.append(command)
        assert kwargs["cwd"] == project
        assert kwargs["capture_output"] and kwargs["timeout"] == 300
        if "export" in command or "compile" in command:
            stage = "export" if "export" in command else "compile"
            path = Path(command[command.index("--output-file") + 1])
            files.append(path)
            value = "pillow==12.3.0\n"
            if stage == "compile":
                assert command[command.index("--python-version") + 1] == "3.10"
                assert command[command.index("--python-platform") + 1] == "linux"
                if case == "changed_pin":
                    value = "pillow==13.0.0\n"
                if case == "empty":
                    value = ""
            path.write_text(value, encoding="utf-8")
            return subprocess.CompletedProcess(command, 7 if case == f"{stage}_failure" else 0,
                                               b"", b"private-index-password")
        assert command[command.index("--requirement") + 1] == str(files[-1])
        assert "--disable-pip" in command and "--no-deps" in command
        assert command[command.index("--python") + 1] == "3.11"
        assert "filelock>=4.2.1" in command
        if case == "timeout":
            raise subprocess.TimeoutExpired(command, 300)
        item = {"name": "pillow", "version": "12.3.0", "vulns": []}
        if case == "findings":
            item["vulns"] = [{"id": "TEST-ADVISORY"}]
        if case == "skipped":
            item["skip_reason"] = "not available"
        report = {"dependencies": [] if case == "omitted" else [item]}
        output = b"private-invalid-json" if case == "malformed" else json.dumps(report).encode()
        return subprocess.CompletedProcess(command, 2 if case == "tool_failure" else int(case == "findings"),
                                           output, b"private-index-password")

    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.audit(project) == expected
    if case in {"export_failure", "compile_failure", "changed_pin", "empty"}:
        assert not any("pip-audit" in command for command in calls)
    assert all(not path.exists() for path in files)
    captured = capsys.readouterr()
    assert "private-" not in captured.out + captured.err


def test_ci_keeps_audit_as_blocking_independent_job():
    workflow = (module.ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    job = workflow.split("  python-dependency-audit:\n", 1)[1].split("  backend-tests-local:\n", 1)[0]
    assert "python scripts/audit_python_dependencies.py" in job
    assert "continue-on-error" not in job
    assert "upload-artifact" not in job
    gate = workflow.split("  quality-gates:\n", 1)[1].split("    env:\n", 1)[0]
    assert "- python-dependency-audit" in gate
    backend = workflow.split("  backend-tests-local:\n", 1)[1].split("  pre-release-gate:\n", 1)[0]
    assert "pip-audit" not in backend
