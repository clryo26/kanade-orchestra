from __future__ import annotations

from .. import app_core

duration_seconds_for_file = app_core.duration_seconds_for_file
format_duration = app_core.format_duration
recording_metadata_for_path = app_core.recording_metadata_for_path
remember_recording_duration = app_core.remember_recording_duration

__all__ = [
    "duration_seconds_for_file",
    "format_duration",
    "recording_metadata_for_path",
    "remember_recording_duration",
]
