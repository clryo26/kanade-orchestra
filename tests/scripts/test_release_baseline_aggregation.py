"""Aggregate semantics and redaction for a read-only operational report."""
import importlib.util
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
import re

import pytest


spec = importlib.util.spec_from_file_location(
    "capture_test_release_baseline", Path(__file__).parents[2] / "scripts/capture_test_release_baseline.py")
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)
NOW = datetime(2026, 10, 26, tzinfo=timezone.utc)


def request(method="PUT", status=200, latency="0.2s", url="https://example.invalid/api/extra/albums/23?private=secret"):
    return {"timestamp": (NOW - timedelta(minutes=1)).isoformat(),
            "logName": "projects/example/logs/run.googleapis.com%2Frequests",
            "httpRequest": {"requestMethod": method, "requestUrl": url,
                            "status": status, "latency": latency}}


def report(entries):
    return baseline.aggregate(entries, NOW - timedelta(days=1), NOW,
                              [(re.compile(r"^/api/extra/[^/]+/[^/]+$"), "/api/extra/{name}/{item_id}")])


def test_empty_is_not_zero_latency_or_zero_unobservable_failures():
    result = report([])
    assert result["save_requests"] == 0
    assert result["save_p50_ms"] is None and result["save_p95_ms"] is None
    assert result["save_busy_count"] is None and result["save_timeout_count"] is None


def test_template_only_and_percentiles_exclude_missing_latency():
    rows = [request(latency=value) for value in ("0.1s", "0.3s", "")]
    result = report(rows)
    assert result["save_p50_ms"] == 200 and result["save_p95_ms"] == 290
    assert result["by_api"][0]["missing_latency"] == 1
    text = json.dumps(result)
    assert "private" not in text and "secret" not in text and "example.invalid" not in text
    assert "/api/extra/albums/23" not in text
    assert result["by_api"][0]["api_template"] == "PUT /api/extra/{name}/{item_id}"


def test_errors_timeouts_and_signal_entries_are_different_counts():
    rows = [request(status=503), request(status=504), request(method="GET", status=500),
            request(url="https://example.invalid/api/auth/session", status=401)]
    rows.append({"timestamp": (NOW - timedelta(minutes=1)).isoformat(),
                 "textPayload": "Exception in ASGI application: No response returned. secret"})
    result = report(rows)
    assert result["http_5xx"] == 3 and result["save_http_5xx"] == 2
    assert result["save_http_504"] == 1 and result["save_timeout_count"] is None
    assert result["save_busy_count"] is None  # A 503 does not identify save_busy.
    assert result["application_signal_log_entries"]["no_response_returned"] == 1
    assert "secret" not in json.dumps(result)


def test_window_end_is_exclusive_and_unknown_path_is_masked():
    row = request(url="https://example.invalid/api/personal-name/private-file.jpg")
    excluded = request()
    excluded["timestamp"] = NOW.isoformat()
    result = report([row, excluded])
    assert result["save_requests"] == 1
    assert result["by_api"][0]["api_template"] == "PUT /api/(unclassified)"
    assert "personal-name" not in json.dumps(result)


@pytest.mark.parametrize("environment,service", [
    ("test", "kanade-orchestra-test"), ("production", "kanade-orchestra"),
])
def test_capture_selects_only_target_revision_and_equal_length_window(monkeypatch, tmp_path, environment, service):
    calls = []

    def cloud_read(arguments):
        calls.append(arguments)
        if arguments[:3] == ["run", "services", "describe"]:
            return {"status": {"traffic": [{"revisionName": "private-revision", "percent": 100}]}}
        return []

    monkeypatch.setattr(baseline, "read_json", cloud_read)
    monkeypatch.setattr(baseline, "routes", lambda: [])
    output = tmp_path / "aggregates.json"
    baseline.capture(output, environment, 6)
    result = json.loads(output.read_text(encoding="utf-8"))
    assert calls[0][3] == service
    assert calls[1][:2] == ["logging", "read"]
    assert f'service_name="{service}"' in calls[1][2]
    assert 'revision_name="private-revision"' in calls[1][2]
    assert "--freshness=6h" in calls[1]
    window = result["windows"][0]
    assert datetime.fromisoformat(window["end_utc"]) - datetime.fromisoformat(window["start_utc"]) == timedelta(hours=6)
    assert result["service"] == environment and result["enumeration_complete"]
    assert b"\r\n" not in output.read_bytes()


def test_invalid_window_is_rejected_before_cloud_access(monkeypatch, tmp_path):
    def unexpected_cloud_access(arguments):
        pytest.fail("Invalid observation window must not access Cloud Logging")

    monkeypatch.setattr(baseline, "read_json", unexpected_cloud_access)
    with pytest.raises(ValueError):
        baseline.capture(tmp_path / "unused.json", "production", 0)
