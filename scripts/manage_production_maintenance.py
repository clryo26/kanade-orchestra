"""Production-only traffic switch. Dry-run by default; never uses test maintenance.

The state file contains revision identities, never service environment/secrets.
Job shutdown and DB transaction inspection remain explicit operator checks.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time
import urllib.request
from pathlib import Path

PROJECT = "kanade-orchestra"
REGION = "asia-northeast2"
SERVICE = "kanade-orchestra"


def run(*args, json_result=False):
    result = subprocess.run(["gcloud", *args], check=True, capture_output=True, text=True, timeout=300)
    return json.loads(result.stdout) if json_result else None


def service():
    return run("run", "services", "describe", SERVICE, "--project", PROJECT, "--region", REGION,
               "--format=json", json_result=True)


def revision(name):
    return run("run", "revisions", "describe", name, "--project", PROJECT, "--region", REGION,
               "--format=json", json_result=True)


def traffic_only(description, name):
    traffic = description.get("status", {}).get("traffic", [])
    return bool(traffic) and not any(t.get("tag") for t in traffic) and all(
        t.get("revisionName") == name and t.get("percent") == 100 for t in traffic)


def health(url):
    with urllib.request.urlopen(url.rstrip("/") + "/api/health", timeout=15) as response:
        return json.load(response)


def verify_stopped(state):
    current = service()
    if not traffic_only(current, state["maintenance_revision"]):
        raise RuntimeError("Traffic or tags changed; do not delete data")
    if health(current["status"]["url"]).get("mode") != "production-maintenance":
        raise RuntimeError("Production maintenance entry point is not active")
    if time.time() < state["drained_after"]:
        raise RuntimeError("Old requests have not finished draining")
    return current


def execute(args):
    if (args.project, args.region, args.service) != (PROJECT, REGION, SERVICE):
        raise RuntimeError("This tool is restricted to the production service")
    path = Path(args.state_file)
    if args.action == "enable":
        if path.exists():
            raise RuntimeError("State file already exists; use verify or resume the recorded transition")
        before = service()
        traffic = before["status"].get("traffic", [])
        if not any(t.get("revisionName") == args.expected_revision and t.get("percent") == 100 for t in traffic):
            raise RuntimeError("Expected production revision is not serving all traffic")
        if not args.image or "@sha256:" not in args.image:
            raise RuntimeError("A maintenance image pinned by digest is required")
        drain = max([int(revision(t["revisionName"])["spec"].get("timeoutSeconds", 300)) for t in traffic] or [300])
        if not args.execute:
            return {"mode": "dry-run", "drain_seconds": drain, "old_revision": args.expected_revision}
        if not args.writers_stopped:
            raise RuntimeError("Stop deployments/sync/cleanup jobs before switching traffic")
        staged = run("run", "deploy", SERVICE, "--project", PROJECT, "--region", REGION,
                     "--image", args.image, "--command", ".venv/bin/uvicorn",
                     "--args", "src.backend.production_maintenance:app,--host,0.0.0.0,--port,8080",
                     "--no-traffic", "--format=json", json_result=True)
        name = staged["status"]["latestCreatedRevisionName"]
        info = revision(name)
        if not any(c.get("type") == "Ready" and c.get("status") == "True" for c in info["status"].get("conditions", [])):
            raise RuntimeError("Maintenance revision is not ready; traffic is unchanged")
        state = {"project": PROJECT, "region": REGION, "service": SERVICE, "url": before["status"]["url"],
                 "old_revision": args.expected_revision, "previous_traffic": traffic,
                 "maintenance_revision": name, "drained_after": time.time() + drain}
        # Save before mutation so an interrupted switch can be inspected safely.
        with path.open("x", encoding="utf-8", newline="\n") as output:
            json.dump(state, output, ensure_ascii=False, indent=2)
        run("run", "services", "update-traffic", SERVICE, "--project", PROJECT, "--region", REGION,
            "--to-revisions", f"{name}=100", "--clear-tags", "--quiet")
        # The deadline starts after the switch finishes, not before deployment.
        state["drained_after"] = time.time() + drain
        path.write_text(json.dumps(state, indent=2), encoding="utf-8")
        return {"state": "maintenance", "drained_after": state["drained_after"], "next": "wait, then verify and inspect DB writers/jobs"}
    state = json.loads(path.read_text(encoding="utf-8"))
    if (state.get("project"), state.get("region"), state.get("service")) != (PROJECT, REGION, SERVICE):
        raise RuntimeError("State identity mismatch")
    verify_stopped(state)
    if args.action == "verify":
        return {"state": "maintenance-drained", "note": "DB transactions and jobs must also be checked"}
    if not args.new_revision or not args.run_id or not args.db_name:
        raise RuntimeError("Disable requires the verified new revision, completed run ID and DB name")
    info = revision(args.new_revision)
    container = info["spec"]["containers"][0]
    if "src.backend.main:app" not in container.get("args", []) or container.get("command") != [".venv/bin/uvicorn"]:
        raise RuntimeError("New revision must explicitly restore the normal uvicorn entry point")
    if args.new_revision in {state["old_revision"], state["maintenance_revision"]}:
        raise RuntimeError("Release must use the verified new application revision")
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from src.backend import main as backend  # noqa: F401
    from src.backend.core.tenant_context import set_current_tenant_id
    from src.backend.repositories import promotion_repository as repo
    from src.backend.services.promotion_reset_service import locked_run
    import os
    if os.getenv("APP_ENV") != "production" or repo.local_json_fallback_enabled():
        raise RuntimeError("Production DB mode is required")
    set_current_tenant_id(args.organization)
    with repo.transaction() as cur:
        cur.execute("SELECT current_database() AS name")
        if cur.fetchone()["name"] != args.db_name:
            raise RuntimeError("Database identity mismatch")
        reset = locked_run(cur, args.run_id, f"production:{args.db_name}:{state['url'].rstrip('/')}")
        if reset["state"] != "completed":
            raise RuntimeError("Reset run is not complete")
    if not args.execute:
        return {"mode": "dry-run", "new_revision": args.new_revision}
    if not args.writers_stopped:
        raise RuntimeError("Confirm old writers/jobs remain stopped")
    run("run", "services", "update-traffic", SERVICE, "--project", PROJECT, "--region", REGION,
        "--to-revisions", f"{args.new_revision}=100", "--clear-tags", "--quiet")
    try:
        if not traffic_only(service(), args.new_revision) or health(state["url"]).get("mode") == "production-maintenance":
            raise RuntimeError("Release verification failed")
    except Exception:
        run("run", "services", "update-traffic", SERVICE, "--project", PROJECT, "--region", REGION,
            "--to-revisions", f"{state['maintenance_revision']}=100", "--clear-tags", "--quiet")
        raise
    return {"state": "released", "revision": args.new_revision}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("enable", "verify", "disable"))
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--service", required=True)
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--expected-revision")
    parser.add_argument("--image")
    parser.add_argument("--new-revision")
    parser.add_argument("--run-id")
    parser.add_argument("--db-name")
    parser.add_argument("--organization", default="default")
    parser.add_argument("--writers-stopped", action="store_true")
    parser.add_argument("--execute", action="store_true")
    print(json.dumps(execute(parser.parse_args()), ensure_ascii=False))


if __name__ == "__main__":
    main()
