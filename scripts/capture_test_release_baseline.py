"""Read TEST/production Cloud Logging; write only aggregates, never request contents.

No DB connection, application request, workflow dispatch or deployment is made.
The result counts observed log entries, not all possible client-side failures.
"""
from __future__ import annotations

import argparse
import ast
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "kanade-orchestra"
SERVICES = {"test": "kanade-orchestra-test", "production": "kanade-orchestra"}
REGION = "asia-northeast2"
LIMIT = 100000


def read_json(arguments):
    result = subprocess.run([shutil.which("gcloud") or "gcloud", *arguments],
                            capture_output=True, timeout=180)
    if result.returncode:
        # CLI diagnostics and raw logs can contain connection/request values.
        raise RuntimeError("Read-only Google Cloud query failed; no raw diagnostics emitted")
    return json.loads(result.stdout)


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower, upper = math.floor(position), math.ceil(position)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower), 3)


def routes():
    patterns = set()
    for source in (ROOT / "src/backend/routers").glob("*.py"):
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8-sig"))):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in {"get", "post", "put", "patch", "delete"}
                    and node.args and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str) and node.args[0].value.startswith("/api/")):
                patterns.add(node.args[0].value)
    result = []
    for path in sorted(patterns, key=lambda item: (item.count("{"), -len(item), item)):
        pieces = re.split(r"(\{[^}]+\})", path)
        pattern = "".join(".+" if ":path}" in p else "[^/]+" if p.startswith("{")
                          else re.escape(p) for p in pieces)
        result.append((re.compile("^" + pattern + "$"), path))
    return result


def aggregate(entries, start, end, route_patterns):
    saves = defaultdict(list)
    statuses = defaultdict(Counter)
    save_statuses = Counter()
    all_statuses = Counter()
    app_signals = Counter()
    missing_latency = Counter()
    request_count = 0
    for entry in entries:
        timestamp = datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00"))
        if not start <= timestamp < end:
            continue
        # Never return or persist payload text, identifiers, URLs or timestamps
        # from individual entries. A single exception can span several entries.
        message = str(entry.get("textPayload", ""))
        payload = entry.get("jsonPayload")
        if isinstance(payload, dict):
            message += " " + str(payload.get("message", ""))
        for label, needle in (("asgi_exception", "Exception in ASGI application"),
                              ("no_response_returned", "No response returned"),
                              ("save_busy_text", "save_busy"),
                              ("timeout_text", "timed out")):
            app_signals[label] += int(needle.lower() in message.lower())
        request = entry.get("httpRequest")
        if not isinstance(request, dict) or not entry.get("logName", "").endswith("run.googleapis.com%2Frequests"):
            continue
        request_count += 1
        status = request.get("status")
        all_statuses[str(status) if status is not None else "missing"] += 1
        method = request.get("requestMethod", "").upper()
        try:
            path = urlsplit(request.get("requestUrl", "")).path
        except ValueError:
            path = ""
        if method not in {"POST", "PUT", "PATCH", "DELETE"} or not path.startswith("/api/") or path.startswith("/api/auth/"):
            continue
        # Only source-defined templates are exported. Unrecognized/variable
        # path contents (names, file names, IDs, query strings) are not exported.
        template = next((label for pattern, label in route_patterns if pattern.fullmatch(path)),
                        "/api/(unclassified)")
        group = method + " " + template
        statuses[group][str(status) if status is not None else "missing"] += 1
        save_statuses[str(status) if status is not None else "missing"] += 1
        latency = str(request.get("latency", ""))
        if re.fullmatch(r"\d+(?:\.\d+)?s", latency):
            saves[group].append(float(latency[:-1]) * 1000)
        else:
            missing_latency[group] += 1
    groups = []
    for group in sorted(statuses):
        values = saves[group]
        groups.append({"api_template": group, "requests": sum(statuses[group].values()),
                       "latency_samples": len(values), "missing_latency": missing_latency[group],
                       "p50_ms": percentile(values, .5), "p95_ms": percentile(values, .95),
                       "status_counts": dict(sorted(statuses[group].items()))})
    combined = [v for values in saves.values() for v in values]
    return {"start_utc": start.isoformat(), "end_utc": end.isoformat(),
            "http_requests": request_count, "http_status_counts": dict(sorted(all_statuses.items())),
            "http_5xx": sum(v for k, v in all_statuses.items() if k.isdigit() and 500 <= int(k) < 600),
            "save_requests": sum(save_statuses.values()), "save_status_counts": dict(sorted(save_statuses.items())),
            "save_p50_ms": percentile(combined, .5), "save_p95_ms": percentile(combined, .95),
            "save_http_4xx": sum(v for k, v in save_statuses.items() if k.isdigit() and 400 <= int(k) < 500),
            "save_http_5xx": sum(v for k, v in save_statuses.items() if k.isdigit() and 500 <= int(k) < 600),
            "save_http_504": save_statuses["504"],
            "save_busy_count": None,
            "save_timeout_count": None,
            "application_signal_log_entries": dict(app_signals), "by_api": groups}


def capture(output: Path, environment="test", hours=24):
    service_name = SERVICES[environment]
    if not isinstance(hours, int) or isinstance(hours, bool) or hours < 1:
        raise ValueError("Observation hours must be a positive integer")
    end = datetime.now(timezone.utc).replace(microsecond=0)
    start = end - timedelta(hours=hours)
    service = read_json(["run", "services", "describe", service_name, "--project", PROJECT,
                         "--region", REGION, "--format=json"])
    traffic = [row for row in service["status"]["traffic"] if int(row.get("percent", 0)) > 0]
    if len(traffic) != 1 or traffic[0].get("percent") != 100:
        raise RuntimeError("Target traffic is not on a single 100-percent revision")
    revision = traffic[0]["revisionName"]
    selector = (f'resource.type="cloud_run_revision" AND resource.labels.service_name="{service_name}" '
                f'AND resource.labels.revision_name="{revision}" '
                f'AND timestamp>="{start.isoformat()}" AND timestamp<"{end.isoformat()}"')
    entries = read_json(["logging", "read", selector, "--project", PROJECT,
                         "--order=asc", f"--freshness={hours}h", f"--limit={LIMIT}", "--format=json"])
    patterns = routes()
    result = {"schema_version": 1, "captured_at_utc": end.isoformat(),
              "service": environment, "revision": revision, "release_candidate": "ac5b4e3",
              "returned_entries": len(entries), "query_limit": LIMIT,
              "enumeration_complete": len(entries) < LIMIT,
              "percentile_method": "linear interpolation at (n-1)*p; Cloud Run httpRequest.latency, not app Server-Timing or browser elapsed",
              "save_scope": "POST/PUT/PATCH/DELETE /api/* excluding /api/auth/*; HTTP requests, not logical saves",
              "windows": [aggregate(entries, start, end, patterns)],
              "limitations": ["No live writes or load test; only existing logs are read",
                              "Zero requests means no baseline latency, not zero latency",
                              "save_busy response detail and non-504/client/DB timeouts are not systematically logged; counts remain null",
                              "Signal entry counts are not unique exception/request counts; absence of text is not zero failures",
                              "No guarantee against logging exclusions/sampling or client failures before Cloud Run",
                              "Different API mix/sample count/observation duration must be considered in before-after comparison",
                              "If enumeration_complete is false, counts/percentiles are partial and must not be accepted"]}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"output": str(output), "enumeration_complete": result["enumeration_complete"],
                      "windows": [{k: w[k] for k in ("start_utc", "end_utc", "http_requests", "save_requests",
                                                     "save_p50_ms", "save_p95_ms", "http_5xx", "save_busy_count")}
                                  for w in result["windows"]]}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=tuple(SERVICES), default="test")
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        capture(args.output, args.environment, args.hours)
    except (RuntimeError, KeyError, ValueError, OSError, subprocess.TimeoutExpired) as exc:
        raise SystemExit(f"Release baseline capture failed: {type(exc).__name__}") from None
