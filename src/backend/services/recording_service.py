from __future__ import annotations

import logging
from pathlib import Path

from .audio_processing_service import get_audio_duration_seconds
from .file_service import format_duration
from .recording_asset_service import recording_metadata_map, remember_recording_duration as persist_recording_duration
from .storage_service import load_json_data, save_json_data
from ..utils.collection_utils import next_id

logger = logging.getLogger(__name__)


def duration_seconds_for_file(path: Path) -> float | None:
    return get_audio_duration_seconds(path, logger=_LoggerProxy())


def recording_metadata_for_path(path_key: str) -> dict[str, object] | None:
    return recording_metadata_map(load_json_data=load_json_data).get(path_key)


def remember_recording_duration(path_key: str, duration_seconds: float | None) -> None:
    persist_recording_duration(
        path_key,
        duration_seconds,
        load_json_data=load_json_data,
        save_json_data=save_json_data,
        next_id=next_id,
        format_duration=format_duration,
    )


class _LoggerProxy:
    def warning(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        logger.warning(*args, **kwargs)

__all__ = [
    "duration_seconds_for_file",
    "format_duration",
    "recording_metadata_for_path",
    "remember_recording_duration",
]
