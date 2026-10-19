"""Maintenance switch for the JST date/time remediation release (spec R11, plan 9.3/S16-A).

Dry-run by default (``--execute`` performs changes). Separate from
``manage_production_maintenance.py`` on purpose: that tool's release gate
requires a completed *promotion reset* run, which is unrelated here. Its
safety rules are neither weakened nor reused through a fake reset run.

Sequence (spec 1.6 / plan 9.2):
  1. ``plan``    - read-only checks of the target and the planned switch.
  2. ``enable``  - deploy the maintenance entry point without traffic, write the
                   state file *before* switching, switch 100 % traffic, start drain.
  3. ``verify``  - traffic/tag/health, drain deadline, no other active DB
                   transactions, writer jobs confirmed stopped.
  4. ``release`` - new revision (normal entry point, image digest), DB identity,
                   migration 022 applied, legacy reference migration report
                   completed; switch 100 % and re-verify; on failure the
                   traffic goes back to maintenance.
  5. ``restore-maintenance`` - put traffic back on the maintenance revision.
  6. ``rollback-old`` - only while no new file operations/assets exist and the
                   state records the old revision as compatible; otherwise refused
                   (forward fix instead, spec R11).

The state file holds revision identities and timestamps only; never service
environment values or secrets. TEST must be exercised before production.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable

TARGETS = {
    "production": {"project": "kanade-orchestra", "region": "asia-northeast2", "service": "kanade-orchestra"},
    "test": {"project": "kanade-orchestra", "region": "asia-northeast2", "service": "kanade-orchestra-test"},
}
MAINTENANCE_MODE = "production-maintenance"
REQUIRED_MIGRATION = "022"  # schema_migrations.version of 022_portal_file_assets.sql


class MaintenanceError(RuntimeError):
    pass


# --------------------------------------------------------------------------- environment adapters


def gcloud(*args: str, json_result: bool = False) -> Any:
    result = subprocess.run(["gcloud", *args], check=True, capture_output=True, text=True, timeout=300)
    return json.loads(result.stdout) if json_result else None


def http_health(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url.rstrip("/") + "/api/health", timeout=15) as response:
        return json.load(response)


def db_facts(db_url: str) -> dict[str, Any]:
    """Read-only facts used by the gates (no writes, READ ONLY transaction)."""
    import psycopg

    with psycopg.connect(db_url, autocommit=False, connect_timeout=10) as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        database = conn.execute("SELECT current_database()").fetchone()[0]
        active = conn.execute(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() "
            "AND backend_type = 'client backend' AND state NOT IN ('idle')"
        ).fetchone()[0]
        migrations = {str(row[0]) for row in conn.execute("SELECT version FROM schema_migrations").fetchall()}
        has_tables = conn.execute("SELECT to_regclass('public.portal_file_operations') IS NOT NULL").fetchone()[0]
        new_operations = conn.execute("SELECT count(*) FROM portal_file_operations").fetchone()[0] if has_tables else 0
        new_assets = conn.execute("SELECT count(*) FROM portal_file_assets WHERE NOT legacy").fetchone()[0] if has_tables else 0
        conn.rollback()
    return {
        "database": database,
        "active_transactions": int(active),
        "migrations": sorted(migrations),
        "new_file_operations": int(new_operations),
        "new_file_assets": int(new_assets),
    }


# --------------------------------------------------------------------------- pure checks


def traffic_only(description: dict[str, Any], revision_name: str) -> bool:
    traffic = description.get("status", {}).get("traffic", [])
    return bool(traffic) and not any(t.get("tag") for t in traffic) and all(
        t.get("revisionName") == revision_name and t.get("percent") == 100 for t in traffic
    )


def check_target(args: argparse.Namespace) -> dict[str, str]:
    target = TARGETS.get(args.environment)
    if not target or (args.project, args.region, args.service) != (target["project"], target["region"], target["service"]):
        raise MaintenanceError("Target identity does not match the selected environment")
    return target


def check_release_gates(
    state: dict[str, Any],
    *,
    new_revision_info: dict[str, Any],
    new_revision: str,
    image: str,
    facts: dict[str, Any],
    db_name: str,
    migration_report: dict[str, Any] | None,
) -> None:
    container = new_revision_info["spec"]["containers"][0]
    if "src.backend.main:app" not in (container.get("args") or []) or container.get("command") != [".venv/bin/uvicorn"]:
        raise MaintenanceError("New revision must explicitly use the normal uvicorn entry point")
    if new_revision in {state["old_revision"], state["maintenance_revision"]}:
        raise MaintenanceError("Release must use the verified new application revision")
    if "@sha256:" not in image or container.get("image") != image:
        raise MaintenanceError("New revision image must match the pinned digest")
    if facts["database"] != db_name:
        raise MaintenanceError("Database identity mismatch")
    if REQUIRED_MIGRATION not in facts["migrations"]:
        raise MaintenanceError("Migration 022 is not applied")
    if facts["active_transactions"] != 0:
        raise MaintenanceError("Other DB transactions are still active")
    if not migration_report or migration_report.get("state") != "completed" or migration_report.get("unresolved", 1) != 0:
        raise MaintenanceError("Legacy reference migration is not completed (plan S17)")


def check_rollback_old(state: dict[str, Any], facts: dict[str, Any]) -> None:
    if state.get("old_revision_compatible") is not True:
        raise MaintenanceError("The old revision was not recorded as compatible; forward-fix instead")
    if facts["new_file_operations"] or facts["new_file_assets"]:
        raise MaintenanceError("New file references/operations exist; the old revision cannot read them (forward-fix)")


# --------------------------------------------------------------------------- actions


def execute(
    args: argparse.Namespace,
    *,
    run: Callable[..., Any] = gcloud,
    health: Callable[[str], dict[str, Any]] = http_health,
    facts_for: Callable[[str], dict[str, Any]] = db_facts,
    now: Callable[[], float] = time.time,
) -> dict[str, Any]:
    target = check_target(args)
    project, region, service_name = target["project"], target["region"], target["service"]
    path = Path(args.state_file)

    def service() -> dict[str, Any]:
        return run("run", "services", "describe", service_name, "--project", project, "--region", region, "--format=json", json_result=True)

    def revision(name: str) -> dict[str, Any]:
        return run("run", "revisions", "describe", name, "--project", project, "--region", region, "--format=json", json_result=True)

    def switch(name: str) -> None:
        run("run", "services", "update-traffic", service_name, "--project", project, "--region", region,
            "--to-revisions", f"{name}=100", "--clear-tags", "--quiet")

    if args.action in {"plan", "enable"}:
        if path.exists():
            raise MaintenanceError("State file already exists; continue with verify/release or inspect it")
        before = service()
        traffic = before["status"].get("traffic", [])
        if not any(t.get("revisionName") == args.expected_revision and t.get("percent") == 100 for t in traffic):
            raise MaintenanceError("Expected revision is not serving all traffic")
        if not args.image or "@sha256:" not in args.image:
            raise MaintenanceError("A maintenance image pinned by digest is required")
        drain = max([int(revision(t["revisionName"])["spec"].get("timeoutSeconds", 300)) for t in traffic] or [300])
        if args.action == "plan" or not args.execute:
            return {"mode": "dry-run", "drain_seconds": drain, "old_revision": args.expected_revision}
        if not args.writers_stopped:
            raise MaintenanceError("Stop deployments/sync/cleanup jobs before switching traffic")
        staged = run("run", "deploy", service_name, "--project", project, "--region", region,
                     "--image", args.image, "--command", ".venv/bin/uvicorn",
                     "--args", "src.backend.production_maintenance:app,--host,0.0.0.0,--port,8080",
                     "--no-traffic", "--format=json", json_result=True)
        name = staged["status"]["latestCreatedRevisionName"]
        info = revision(name)
        if not any(c.get("type") == "Ready" and c.get("status") == "True" for c in info["status"].get("conditions", [])):
            raise MaintenanceError("Maintenance revision is not ready; traffic is unchanged")
        state = {
            **target, "environment": args.environment, "url": before["status"]["url"],
            "old_revision": args.expected_revision, "old_revision_compatible": bool(args.old_revision_compatible),
            "previous_traffic": traffic, "maintenance_revision": name, "drain_seconds": drain,
            "drained_after": None, "history": [{"event": "staged", "at": now()}],
        }
        # Written before the traffic switch so an interrupted switch is inspectable.
        with path.open("x", encoding="utf-8", newline="\n") as output:
            json.dump(state, output, ensure_ascii=False, indent=2)
        switch(name)
        state["drained_after"] = now() + drain  # the drain starts after the switch
        state["history"].append({"event": "maintenance", "at": now()})
        path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"state": "maintenance", "drained_after": state["drained_after"]}

    state = json.loads(path.read_text(encoding="utf-8"))
    if (state.get("project"), state.get("region"), state.get("service")) != (project, region, service_name):
        raise MaintenanceError("State identity mismatch")

    def save(event: str) -> None:
        state["history"].append({"event": event, "at": now()})
        path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.action == "restore-maintenance":
        if args.execute:
            switch(state["maintenance_revision"])
            save("restored-maintenance")
        return {"state": "maintenance", "mode": "executed" if args.execute else "dry-run"}

    current = service()
    if args.action in {"verify", "release"}:
        if not traffic_only(current, state["maintenance_revision"]):
            raise MaintenanceError("Traffic or tags changed; stop and inspect")
        if health(current["status"]["url"]).get("mode") != MAINTENANCE_MODE:
            raise MaintenanceError("Maintenance entry point is not active")
        if state.get("drained_after") is None or now() < state["drained_after"]:
            raise MaintenanceError("Old requests have not finished draining")
        if not args.writers_stopped:
            raise MaintenanceError("Confirm deploy/sync/cleanup writers remain stopped")
    facts = facts_for(args.db_url) if args.db_url else None
    if args.action == "verify":
        if facts is None or facts["active_transactions"] != 0:
            raise MaintenanceError("DB transactions not confirmed idle (pass --db-url)")
        save("verified")
        return {"state": "maintenance-drained", "db": facts}

    if args.action == "release":
        if facts is None or not args.new_revision or not args.db_name or not args.new_image:
            raise MaintenanceError("Release requires --new-revision, --new-image, --db-name and --db-url")
        report = json.loads(Path(args.migration_report).read_text(encoding="utf-8")) if args.migration_report else None
        check_release_gates(
            state, new_revision_info=revision(args.new_revision), new_revision=args.new_revision,
            image=args.new_image, facts=facts, db_name=args.db_name, migration_report=report,
        )
        if not args.execute:
            return {"mode": "dry-run", "new_revision": args.new_revision}
        switch(args.new_revision)
        try:
            if not traffic_only(service(), args.new_revision) or health(state["url"]).get("mode") == MAINTENANCE_MODE:
                raise MaintenanceError("Release verification failed")
        except Exception:
            switch(state["maintenance_revision"])
            save("release-failed-restored-maintenance")
            raise
        state["released_revision"] = args.new_revision
        save("released")
        return {"state": "released", "revision": args.new_revision}

    if args.action == "rollback-old":
        if facts is None:
            raise MaintenanceError("Rollback requires --db-url")
        check_rollback_old(state, facts)
        if not args.execute:
            return {"mode": "dry-run", "old_revision": state["old_revision"]}
        switch(state["old_revision"])
        save("rolled-back-old")
        return {"state": "old-revision", "revision": state["old_revision"]}
    raise MaintenanceError(f"Unknown action {args.action}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=("plan", "enable", "verify", "release", "restore-maintenance", "rollback-old"))
    parser.add_argument("--environment", choices=sorted(TARGETS), required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--service", required=True)
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--expected-revision")
    parser.add_argument("--image", help="maintenance image pinned by digest")
    parser.add_argument("--old-revision-compatible", action="store_true", help="record that the old revision may be restored")
    parser.add_argument("--new-revision")
    parser.add_argument("--new-image", help="new application image pinned by digest")
    parser.add_argument("--db-name")
    parser.add_argument("--db-url", help="read-only connection for the gates (never logged)")
    parser.add_argument("--migration-report", help="report JSON from scripts/migrate_reference_assets.py")
    parser.add_argument("--writers-stopped", action="store_true")
    parser.add_argument("--execute", action="store_true")
    return parser


def main() -> None:
    print(json.dumps(execute(build_parser().parse_args()), ensure_ascii=False))


if __name__ == "__main__":
    main()
