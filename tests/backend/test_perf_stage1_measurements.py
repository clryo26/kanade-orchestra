"""PERF-R28 local synthetic API probe; opt-in, never a live DB/GCS benchmark."""
from __future__ import annotations

import json
import os
from pathlib import Path
from statistics import median
from time import perf_counter

import pytest

from src.backend.services import youtube_validation_service


@pytest.mark.skipif(not os.getenv("PORTAL_PERF_REPORT"), reason="opt-in measurement artifact")
def test_stage1_desired_piece_communications(client, seed_device_fn, monkeypatch):
    output = Path(os.environ["PORTAL_PERF_REPORT"]).resolve()
    output.relative_to(Path(__file__).resolve().parents[2] / ".tmp")
    seed_device_fn(device_id="perf-owner", permission="一般", member_id="perf-member", member_name="Synthetic Owner")
    calls = []

    class Reply:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b"{}"

    def lookup(url):
        calls.append(url)
        return Reply()

    monkeypatch.setattr(youtube_validation_service, "_youtube_oembed_request", lookup)
    headers = {"X-Device-Id": "perf-owner"}
    runs = []
    for index in range(40):
        payload = {"title": f"Synthetic Wish {index}", "composer": "Composer", "duration": "5:00",
                   "genre": "クラシック", "formation": "Orchestra", "notes": "memo", "votes": [],
                   "reference_audio_url": "https://youtu.be/abcdefghijk", "reference_score_url": ""}
        created = client.post("/api/extra/desired_pieces", headers=headers, json=payload)
        assert created.status_code == 200, created.text
        current = created.json()
        start_calls = len(calls)
        started = perf_counter()
        vote = client.put(f"/api/extra/desired_pieces/{current['id']}", headers=headers,
                          json={"payload": {**current, "votes": [{"member_id": "perf-member", "name": "Synthetic Owner"}]},
                                "expected_updated_at": current["updated_at"]})
        assert vote.status_code == 200, vote.text
        current = vote.json()
        edited = client.put(f"/api/extra/desired_pieces/{current['id']}", headers=headers,
                            json={"payload": {**current, "notes": "Updated memo"}, "expected_updated_at": current["updated_at"]})
        assert edited.status_code == 200, edited.text
        runs.append({"durationMs": (perf_counter() - started) * 1000, "youtubeLookups": len(calls) - start_calls})
    values = sorted(row["durationMs"] for row in runs)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"scope": "isolated local JSON fixture and mocked YouTube; NOT PostgreSQL/GCS performance",
                                  "runs": runs, "p50Ms": median(values), "p95Ms": values[37],
                                  "sqlCalls": None, "gcsCalls": None}, indent=2), encoding="utf-8")
