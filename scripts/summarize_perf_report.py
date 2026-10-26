"""Keep reproducible aggregates in Git; retain raw synthetic traces outside Git.

This is a representation change of recorded measurements, not a new benchmark.
Missing/null measurements remain missing and are never counted as zero.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
from statistics import median

DIMENSIONS = ("scale", "path", "cache_state", "state", "display_count", "count",
              "permission", "workload", "outcome", "model", "status")
TRACES = {"events", "first_request_events", "operations", "acquisitions", "body_sha256"}


def numbers(value, prefix=""):
    if isinstance(value, dict):
        for key, child in value.items():
            if key not in TRACES and key not in {"repeat", *DIMENSIONS}:
                yield from numbers(child, f"{prefix}.{key}".strip("."))
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        yield prefix, value


def aggregate(records):
    groups = defaultdict(list)
    for record in records:
        dimensions = {k: record[k] for k in DIMENSIONS
                      if k in record and isinstance(record[k], (str, int, float))}
        groups[json.dumps(dimensions, sort_keys=True)].append(record)
    result = []
    for key, rows in sorted(groups.items()):
        metrics = defaultdict(list)
        for row in rows:
            for metric, value in numbers(row):
                metrics[metric].append(value)
            # Gallery totals must be measured per batch, not per HTTP request.
            if isinstance(row.get("requests"), list):
                totals = defaultdict(float)
                for request in row["requests"]:
                    for metric, value in numbers(request):
                        totals[metric] += value
                for metric, value in totals.items():
                    metrics["requests_total." + metric].append(value)
        result.append({"dimensions": json.loads(key), "sample_count": len(rows),
                       "metrics": {k: {"count": len(v), "min": min(v),
                                       "median": median(v), "max": max(v)}
                                   for k, v in sorted(metrics.items())}})
    return result


def summarize(raw: bytes, source: str):
    original = json.loads(raw)
    metadata, measurements = {}, {}
    for key, value in original.items():
        if isinstance(value, list) and value and all(isinstance(x, dict) for x in value):
            measurements[key] = aggregate(value)
        else:
            metadata[key] = value
    return {"summary_schema": 1, "source": source,
            "raw_sha256": hashlib.sha256(raw).hexdigest(), "raw_bytes": len(raw),
            "note": "Historical aggregates, not rerun results. Null/unmeasured values are not zero.",
            "metadata": metadata, "measurements": measurements}


def write_summary(target: Path, result):
    # One compact group per line keeps both the diff and shared ZIP small.
    header = {k: v for k, v in result.items() if k != "measurements"}
    lines = json.dumps(header, ensure_ascii=False, indent=2).splitlines()
    lines[-1] = ', "measurements": {'
    items = list(result["measurements"].items())
    for index, (name, groups) in enumerate(items):
        lines.append("  " + json.dumps(name) + ": [")
        lines.extend("    " + json.dumps(group, ensure_ascii=False, separators=(",", ":"))
                     + ("," if i < len(groups) - 1 else "") for i, group in enumerate(groups))
        lines.append("  ]" + ("," if index < len(items) - 1 else ""))
    lines.extend(["}", "}"])
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source", required=True, help="Immutable source commit and path")
    args = parser.parse_args()
    write_summary(args.output, summarize(args.input.read_bytes(), args.source))
