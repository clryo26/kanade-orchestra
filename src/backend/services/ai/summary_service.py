from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SummaryService:
    """Placeholder service for future AI summary features."""

    def summarize(self, text: str) -> str:
        # Keep compatibility: no AI behavior yet.
        return text
