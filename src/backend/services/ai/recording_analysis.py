from __future__ import annotations

from dataclasses import dataclass


@dataclass
class RecordingAnalysisService:
    """Placeholder service for future recording analysis."""

    def analyze(self, recording_id: str) -> dict[str, str]:
        return {"recording_id": recording_id, "status": "not_implemented"}
