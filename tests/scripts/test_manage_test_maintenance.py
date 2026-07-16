from __future__ import annotations

from typing import Any

import pytest

from scripts.manage_test_maintenance import (
    DRAIN_SECONDS,
    MaintenanceOperationError,
    READY_POLL_SECONDS,
    execute_transition,
    validate_target,
)


def service(created: str, ready: str, mode: str, *, traffic: list[dict[str, Any]] | None = None):
    status: dict[str, Any] = {
        "latestCreatedRevisionName": created,
        "latestReadyRevisionName": ready,
        "url": "https://test.example",
    }
    if traffic is not None:
        status["traffic"] = traffic
    return {
        "spec": {"template": {"spec": {"containers": [{"env": [{"name": "MAINTENANCE_MODE", "value": mode}]}]}}},
        "status": status,
    }


@pytest.mark.parametrize("values", [
    ("wrong", "asia-northeast2", "kanade-orchestra-test", "wrong/asia-northeast2/kanade-orchestra-test"),
    ("kanade-orchestra", "wrong", "kanade-orchestra-test", "kanade-orchestra/wrong/kanade-orchestra-test"),
    ("kanade-orchestra", "asia-northeast2", "wrong", "kanade-orchestra/asia-northeast2/wrong"),
])
def test_wrong_target_fails(values):
    with pytest.raises(MaintenanceOperationError):
        validate_target(*values)


def test_wrong_confirmation_fails():
    with pytest.raises(MaintenanceOperationError):
        validate_target("kanade-orchestra", "asia-northeast2", "kanade-orchestra-test", "no")


def test_enable_stages_routes_checks_health_and_drains():
    responses = iter([
        service("rev1", "rev1", "false"),
        {},
        service("rev2", "rev2", "true"),
        {"spec": {"containers": [{"env": [{"name": "MAINTENANCE_MODE", "value": "true"}]}]}},
        {},
        service("rev2", "rev2", "true", traffic=[{"revisionName": "rev2", "percent": 100}]),
        service("rev2", "rev2", "true", traffic=[{"revisionName": "rev2", "percent": 100}]),
    ])
    commands = []
    sleeps = []

    def run(command):
        commands.append(command)
        return next(responses)

    revision = execute_transition("enable", "rev1", run_json=run, health_state=lambda _: "enabled", sleep=sleeps.append)
    assert revision == "rev2"
    assert sleeps == [DRAIN_SECONDS]
    assert any("--no-traffic" in command and "MAINTENANCE_MODE=true" in command for command in commands)
    assert any("update-traffic" in command and "rev2=100" in command for command in commands)


def test_revision_race_fails_before_update():
    commands = []

    def run(command):
        commands.append(command)
        return service("rev2", "rev2", "false")

    with pytest.raises(MaintenanceOperationError, match="approved revision"):
        execute_transition("enable", "rev1", run_json=run)
    assert len(commands) == 1


def test_disable_does_not_drain():
    responses = iter([
        service("rev1", "rev1", "true"), {}, service("rev2", "rev2", "false"),
        {"spec": {"containers": [{"env": [{"name": "MAINTENANCE_MODE", "value": "false"}]}]}}, {},
        service("rev2", "rev2", "false", traffic=[{"revisionName": "rev2", "percent": 100}]),
    ])
    sleeps = []
    revision = execute_transition("disable", "rev1", run_json=lambda _: next(responses), health_state=lambda _: "disabled", sleep=sleeps.append)
    assert revision == "rev2"
    assert sleeps == []


def test_waits_for_new_revision_to_become_ready_before_routing():
    responses = iter([
        service("rev1", "rev1", "true"),
        {},
        service("rev2", "rev1", "false"),
        service("rev2", "rev2", "false"),
        {"spec": {"containers": [{"env": [{"name": "MAINTENANCE_MODE", "value": "false"}]}]}},
        {},
        service("rev2", "rev2", "false", traffic=[{"revisionName": "rev2", "percent": 100}]),
    ])
    sleeps = []

    revision = execute_transition(
        "disable",
        "rev1",
        run_json=lambda _: next(responses),
        health_state=lambda _: "disabled",
        sleep=sleeps.append,
    )

    assert revision == "rev2"
    assert sleeps == [READY_POLL_SECONDS]


def test_ready_timeout_reports_created_and_ready_revisions_before_routing():
    responses = iter([
        service("rev1", "rev1", "false"),
        {},
        service("rev2", "rev1", "true"),
    ])
    times = iter([0.0, 301.0])
    commands = []

    def run(command):
        commands.append(command)
        return next(responses)

    with pytest.raises(
        MaintenanceOperationError,
        match=r"before timeout \(created=rev2, ready=rev1\)",
    ):
        execute_transition(
            "enable",
            "rev1",
            run_json=run,
            sleep=lambda _: None,
            monotonic=lambda: next(times),
        )

    assert not any("update-traffic" in command for command in commands)


def test_health_failure_never_triggers_automatic_disable():
    responses = iter([
        service("rev1", "rev1", "false"), {}, service("rev2", "rev2", "true"),
        {"spec": {"containers": [{"env": [{"name": "MAINTENANCE_MODE", "value": "true"}]}]}}, {},
        service("rev2", "rev2", "true", traffic=[{"revisionName": "rev2", "percent": 100}]),
    ])
    commands = []

    def run(command):
        commands.append(command)
        return next(responses)

    with pytest.raises(MaintenanceOperationError, match="health"):
        execute_transition("enable", "rev1", run_json=run, health_state=lambda _: "disabled")
    assert not any("MAINTENANCE_MODE=false" in command for command in commands)
