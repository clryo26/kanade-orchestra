#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from typing import Any

PROJECT = "kanade-orchestra"
REGION = "asia-northeast2"
SERVICE = "kanade-orchestra-test"
HEALTH_PATH = "/api/health"
DRAIN_SECONDS = 310
READY_TIMEOUT_SECONDS = 300
READY_POLL_SECONDS = 5


class MaintenanceOperationError(RuntimeError):
    """Raised when a maintenance transition cannot be proved safe."""


def _run_json(command: Sequence[str]) -> Mapping[str, Any]:
    completed = subprocess.run(command, check=True, capture_output=True, text=True)
    value = json.loads(completed.stdout)
    if not isinstance(value, Mapping):
        raise MaintenanceOperationError("gcloud response is not a JSON object")
    return value


def _run_command(command: Sequence[str]) -> None:
    """Run a state-changing command whose response is not part of verification."""
    subprocess.run(command, check=True, capture_output=True, text=True)


def _revision_name(service: Mapping[str, Any], field: str) -> str:
    value = service.get("status", {}).get(field)
    if not isinstance(value, str) or not value:
        raise MaintenanceOperationError(f"Cloud Run {field} is unavailable")
    return value


def _env_value(resource: Mapping[str, Any], name: str) -> str:
    containers = resource.get("spec", {}).get("containers")
    if containers is None:
        containers = resource.get("spec", {}).get("template", {}).get("spec", {}).get("containers")
    if not isinstance(containers, list) or len(containers) != 1:
        raise MaintenanceOperationError("Cloud Run resource must contain exactly one container")
    env = containers[0].get("env", [])
    entries = [item for item in env if isinstance(item, Mapping) and item.get("name") == name]
    if len(entries) != 1 or "valueFrom" in entries[0] or "value" not in entries[0]:
        raise MaintenanceOperationError(f"{name} must be one plain environment value")
    return str(entries[0]["value"]).strip().lower()


def _condition_status(resource: Mapping[str, Any], condition_type: str) -> str:
    conditions = resource.get("status", {}).get("conditions", [])
    if not isinstance(conditions, list):
        raise MaintenanceOperationError("Cloud Run revision conditions are invalid")
    matches = [item for item in conditions if isinstance(item, Mapping) and item.get("type") == condition_type]
    if not matches:
        return "Unknown"
    if len(matches) != 1:
        raise MaintenanceOperationError(f"Cloud Run revision has multiple {condition_type} conditions")
    value = matches[0].get("status")
    if value not in {"True", "False", "Unknown"}:
        raise MaintenanceOperationError(f"Cloud Run revision {condition_type} condition is invalid")
    return str(value)


def validate_target(project: str, region: str, service: str, confirmation: str) -> None:
    expected_confirmation = f"{project}/{region}/{service}"
    if (project, region, service) != (PROJECT, REGION, SERVICE):
        raise MaintenanceOperationError("maintenance operation target is not the fixed test service")
    if confirmation != expected_confirmation:
        raise MaintenanceOperationError("confirmation does not exactly match the test target")


def _service_url(service: Mapping[str, Any]) -> str:
    value = service.get("status", {}).get("url")
    if not isinstance(value, str) or not value.startswith("https://"):
        raise MaintenanceOperationError("Cloud Run service URL is unavailable or invalid")
    return value


def _health_state(url: str) -> str:
    request = urllib.request.Request(f"{url}{HEALTH_PATH}", method="GET")
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    if not isinstance(payload, Mapping) or payload.get("status") != "healthy":
        raise MaintenanceOperationError("health response is not healthy")
    state = payload.get("maintenance")
    if state not in {"enabled", "disabled"}:
        raise MaintenanceOperationError("health maintenance state is invalid")
    return str(state)


def execute_transition(
    action: str,
    expected_revision: str,
    *,
    run_json: Callable[[Sequence[str]], Mapping[str, Any]] = _run_json,
    run_command: Callable[[Sequence[str]], None] = _run_command,
    health_state: Callable[[str], str] = _health_state,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> str:
    describe = ["gcloud", "run", "services", "describe", SERVICE, "--project", PROJECT, "--region", REGION, "--format=json"]
    before = run_json(describe)
    current = _revision_name(before, "latestReadyRevisionName")
    if current != expected_revision:
        raise MaintenanceOperationError("current ready revision does not match the approved revision")
    current_mode = _env_value(before, "MAINTENANCE_MODE")
    desired_value = "true" if action == "enable" else "false"
    desired_health = "enabled" if action == "enable" else "disabled"
    if current_mode == desired_value:
        raise MaintenanceOperationError(f"maintenance is already {desired_health}")
    if current_mode not in {"true", "false"}:
        raise MaintenanceOperationError("current MAINTENANCE_MODE is invalid")

    run_json([
        "gcloud", "run", "services", "update", SERVICE,
        "--project", PROJECT, "--region", REGION,
        "--update-env-vars", f"MAINTENANCE_MODE={desired_value}",
        "--no-traffic", "--format=json",
    ])
    # Cloud Run updates the service and revision status asynchronously. Identify
    # the new no-traffic revision from the service, then inspect that revision's
    # own Ready condition. A Ready no-traffic revision can be Retired and does
    # not necessarily become the service's latestReadyRevisionName.
    deadline = monotonic() + READY_TIMEOUT_SECONDS
    revision: str | None = None
    revision_resource: Mapping[str, Any] | None = None
    ready_condition = "Unknown"
    while True:
        staged = run_json(describe)
        created = _revision_name(staged, "latestCreatedRevisionName")
        if revision is None and created != current:
            revision = created
        elif revision is not None and created != revision:
            raise MaintenanceOperationError(
                f"a newer revision appeared while waiting for {revision} to become ready: {created}"
            )

        if revision is not None:
            revision_resource = run_json([
                "gcloud", "run", "revisions", "describe", revision,
                "--project", PROJECT, "--region", REGION, "--format=json",
            ])
            ready_condition = _condition_status(revision_resource, "Ready")
            if ready_condition == "True":
                break
        if monotonic() >= deadline:
            raise MaintenanceOperationError(
                "new maintenance revision did not become ready before timeout "
                f"(created={created}, ready_condition={ready_condition})"
            )
        sleep(READY_POLL_SECONDS)

    assert revision is not None
    assert revision_resource is not None
    if _env_value(revision_resource, "MAINTENANCE_MODE") != desired_value:
        raise MaintenanceOperationError("new revision has an unexpected maintenance value")

    run_command([
        "gcloud", "run", "services", "update-traffic", SERVICE,
        "--project", PROJECT, "--region", REGION,
        "--to-revisions", f"{revision}=100",
    ])
    after = run_json(describe)
    traffic = after.get("status", {}).get("traffic")
    if not isinstance(traffic, list) or len(traffic) != 1 or traffic[0].get("revisionName") != revision or traffic[0].get("percent") != 100:
        raise MaintenanceOperationError("traffic is not exclusively assigned to the new revision")
    if health_state(_service_url(after)) != desired_health:
        raise MaintenanceOperationError("health does not report the requested maintenance state")
    if action == "enable":
        sleep(DRAIN_SECONDS)
        if health_state(_service_url(run_json(describe))) != "enabled":
            raise MaintenanceOperationError("maintenance was not preserved during request drain")
    return revision


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("enable", "disable"))
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--service", required=True)
    parser.add_argument("--confirmation", required=True)
    parser.add_argument("--expected-revision", required=True)
    parser.add_argument("--execute", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        validate_target(args.project, args.region, args.service, args.confirmation)
        if not args.execute:
            raise MaintenanceOperationError("--execute is required; dry invocation performs no change")
        revision = execute_transition(args.action, args.expected_revision)
    except (MaintenanceOperationError, subprocess.CalledProcessError, json.JSONDecodeError, OSError) as exc:
        print(f"::error::Test maintenance operation stopped: {exc}", file=sys.stderr)
        return 1
    print(f"maintenance_{args.action}_revision={revision}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
