"""Dedicated JST release maintenance tool (spec R11, plan S16-A). gcloud/health/DB are faked."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from scripts import manage_datetime_maintenance as tool

TARGET = tool.TARGETS["test"]
DIGEST = "asia-northeast2-docker.pkg.dev/p/r/app@sha256:" + "a" * 64
NEW_DIGEST = "asia-northeast2-docker.pkg.dev/p/r/app@sha256:" + "b" * 64


def _args(tmp_path, action, **overrides):
    values = dict(
        action=action, environment="test", project=TARGET["project"], region=TARGET["region"], service=TARGET["service"],
        state_file=str(tmp_path / "state.json"), expected_revision="old-rev", image=DIGEST, old_revision_compatible=False,
        new_revision=None, new_image=None, db_name=None, db_url=None, migration_report=None, writers_stopped=True, execute=True,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


class FakeCloud:
    def __init__(self):
        self.serving = "old-rev"
        self.calls: list[tuple[str, ...]] = []
        self.health_mode = "normal"

    def run(self, *args, json_result=False):
        self.calls.append(args)
        if args[:3] == ("run", "services", "describe"):
            return {"status": {"url": "https://svc", "traffic": [{"revisionName": self.serving, "percent": 100}]}}
        if args[:3] == ("run", "revisions", "describe"):
            name = args[3]
            if name == "new-rev":
                return {"spec": {"containers": [{"image": NEW_DIGEST, "command": [".venv/bin/uvicorn"], "args": ["src.backend.main:app"]}]}}
            return {"spec": {"timeoutSeconds": 300}, "status": {"conditions": [{"type": "Ready", "status": "True"}]}}
        if args[:2] == ("run", "deploy"):
            return {"status": {"latestCreatedRevisionName": "maint-rev"}}
        if args[:3] == ("run", "services", "update-traffic"):
            self.serving = args[args.index("--to-revisions") + 1].split("=")[0]
            self.health_mode = tool.MAINTENANCE_MODE if self.serving == "maint-rev" else "normal"
            return None
        raise AssertionError(args)

    def health(self, url):
        return {"mode": self.health_mode}


def _facts(**overrides):
    facts = {"database": "portal", "active_transactions": 0, "migrations": ["021", "022"], "new_file_operations": 0, "new_file_assets": 0}
    facts.update(overrides)
    return facts


def test_target_identity_is_checked():
    args = SimpleNamespace(environment="production", project="x", region="y", service="z")
    with pytest.raises(tool.MaintenanceError):
        tool.check_target(args)


def test_full_sequence_enable_verify_release(tmp_path):
    cloud = FakeCloud()
    clock = {"t": 1000.0}
    kwargs = dict(run=cloud.run, health=cloud.health, facts_for=lambda url: _facts(), now=lambda: clock["t"])
    assert tool.execute(_args(tmp_path, "plan"), **kwargs)["mode"] == "dry-run"
    enabled = tool.execute(_args(tmp_path, "enable"), **kwargs)
    assert enabled["state"] == "maintenance" and cloud.serving == "maint-rev"
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert state["old_revision"] == "old-rev" and "env" not in json.dumps(state).lower().replace("environment", "")
    with pytest.raises(tool.MaintenanceError, match="draining"):
        tool.execute(_args(tmp_path, "verify", db_url="x"), **kwargs)
    clock["t"] += 301
    assert tool.execute(_args(tmp_path, "verify", db_url="x"), **kwargs)["state"] == "maintenance-drained"
    report = tmp_path / "report.json"
    report.write_text(json.dumps({"state": "completed", "unresolved": 0}), encoding="utf-8")
    released = tool.execute(
        _args(tmp_path, "release", new_revision="new-rev", new_image=NEW_DIGEST, db_name="portal", db_url="x", migration_report=str(report)),
        **kwargs,
    )
    assert released == {"state": "released", "revision": "new-rev"} and cloud.serving == "new-rev"


def _maintenance(tmp_path, cloud, clock):
    kwargs = dict(run=cloud.run, health=cloud.health, facts_for=lambda url: _facts(), now=lambda: clock["t"])
    tool.execute(_args(tmp_path, "enable"), **kwargs)
    clock["t"] += 301


@pytest.mark.parametrize(
    "facts,report,message",
    [
        (_facts(active_transactions=2), {"state": "completed", "unresolved": 0}, "transactions"),
        (_facts(migrations=["021"]), {"state": "completed", "unresolved": 0}, "022"),
        (_facts(), {"state": "incomplete", "unresolved": 3}, "migration"),
        (_facts(database="other"), {"state": "completed", "unresolved": 0}, "identity"),
    ],
)
def test_release_gates_refuse(tmp_path, facts, report, message):
    cloud, clock = FakeCloud(), {"t": 0.0}
    _maintenance(tmp_path, cloud, clock)
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(tool.MaintenanceError, match=message):
        tool.execute(
            _args(tmp_path, "release", new_revision="new-rev", new_image=NEW_DIGEST, db_name="portal", db_url="x", migration_report=str(path)),
            run=cloud.run, health=cloud.health, facts_for=lambda url: facts, now=lambda: clock["t"],
        )
    assert cloud.serving == "maint-rev"  # traffic untouched


def test_failed_release_verification_returns_to_maintenance(tmp_path):
    cloud, clock = FakeCloud(), {"t": 0.0}
    _maintenance(tmp_path, cloud, clock)
    report = tmp_path / "report.json"
    report.write_text(json.dumps({"state": "completed", "unresolved": 0}), encoding="utf-8")
    cloud.health = lambda url: {"mode": tool.MAINTENANCE_MODE}  # still maintenance after the switch -> failure
    with pytest.raises(tool.MaintenanceError, match="verification"):
        tool.execute(
            _args(tmp_path, "release", new_revision="new-rev", new_image=NEW_DIGEST, db_name="portal", db_url="x", migration_report=str(report)),
            run=cloud.run, health=cloud.health, facts_for=lambda url: _facts(), now=lambda: clock["t"],
        )
    assert cloud.serving == "maint-rev"
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert state["history"][-1]["event"] == "release-failed-restored-maintenance"


def test_rollback_to_old_revision_is_refused_after_new_file_references(tmp_path):
    cloud, clock = FakeCloud(), {"t": 0.0}
    kwargs = dict(run=cloud.run, health=cloud.health, now=lambda: clock["t"])
    tool.execute(_args(tmp_path, "enable", old_revision_compatible=True), facts_for=lambda url: _facts(), **kwargs)
    with pytest.raises(tool.MaintenanceError, match="forward-fix"):
        tool.execute(_args(tmp_path, "rollback-old", db_url="x"), facts_for=lambda url: _facts(new_file_assets=1), **kwargs)
    assert cloud.serving == "maint-rev"
    assert tool.execute(_args(tmp_path, "rollback-old", db_url="x"), facts_for=lambda url: _facts(), **kwargs)["revision"] == "old-rev"


def test_rollback_needs_recorded_compatibility(tmp_path):
    cloud, clock = FakeCloud(), {"t": 0.0}
    kwargs = dict(run=cloud.run, health=cloud.health, facts_for=lambda url: _facts(), now=lambda: clock["t"])
    tool.execute(_args(tmp_path, "enable"), **kwargs)
    with pytest.raises(tool.MaintenanceError, match="compatible"):
        tool.execute(_args(tmp_path, "rollback-old", db_url="x"), **kwargs)


def test_enable_requires_stopped_writers_and_never_reuses_a_state_file(tmp_path):
    cloud = FakeCloud()
    kwargs = dict(run=cloud.run, health=cloud.health, facts_for=lambda url: _facts(), now=lambda: 0.0)
    with pytest.raises(tool.MaintenanceError, match="Stop"):
        tool.execute(_args(tmp_path, "enable", writers_stopped=False), **kwargs)
    assert cloud.serving == "old-rev"
    tool.execute(_args(tmp_path, "enable"), **kwargs)
    with pytest.raises(tool.MaintenanceError, match="State file"):
        tool.execute(_args(tmp_path, "enable"), **kwargs)


def test_promotion_reset_tool_is_unchanged():
    from scripts import manage_production_maintenance as legacy

    source = open(legacy.__file__, encoding="utf-8").read()
    assert "locked_run" in source and 'reset["state"] != "completed"' in source
