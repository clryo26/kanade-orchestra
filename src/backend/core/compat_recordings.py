from __future__ import annotations

from pathlib import Path
from typing import Any, Callable


def local_recording_metadata(path: Path, *, compat_func: Callable[..., dict[str, Any]], recording_metadata_map: Callable[[], dict[str, dict[str, Any]]], format_duration: Callable[[Any], str]) -> dict[str, Any]:
    return compat_func(path, metadata_by_key=recording_metadata_map(), format_duration=format_duration)


def cloud_recording_metadata(item: dict[str, Any], *, compat_func: Callable[..., dict[str, Any]], recording_metadata_map: Callable[[], dict[str, dict[str, Any]]]) -> dict[str, Any]:
    return compat_func(item, metadata_by_key=recording_metadata_map())


def remember_drive_file(item: dict[str, Any], *, compat_func: Callable[..., None], load_json_data: Callable[[str], list[dict[str, Any]]], save_json_data: Callable[[str, list[dict[str, Any]]], None]) -> None:
    compat_func(item, load_json_data=load_json_data, save_json_data=save_json_data)


def forget_drive_file(object_name: str, *, compat_func: Callable[..., None], load_json_data: Callable[[str], list[dict[str, Any]]], save_json_data: Callable[[str, list[dict[str, Any]]], None]) -> None:
    compat_func(object_name, load_json_data=load_json_data, save_json_data=save_json_data)


def recording_file_bytes(item: dict[str, Any], *, compat_func: Callable[..., bytes | None]) -> bytes | None:
    return compat_func(item)


def recording_metadata_map(*, compat_func: Callable[..., dict[str, dict[str, Any]]], load_json_data: Callable[[str], list[dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    return compat_func(load_json_data=load_json_data)


def remember_recording_duration(
    path_key: str,
    duration_seconds: float | None,
    *,
    compat_func: Callable[..., None],
    load_json_data: Callable[[str], list[dict[str, Any]]],
    save_json_data: Callable[[str, list[dict[str, Any]]], None],
    next_id: Callable[[list[dict[str, Any]]], int],
    format_duration: Callable[[Any], str],
) -> None:
    compat_func(
        path_key,
        duration_seconds,
        load_json_data=load_json_data,
        save_json_data=save_json_data,
        next_id=next_id,
        format_duration=format_duration,
    )


def recording_payload(*, compat_func: Callable[..., dict[str, list[dict[str, Any]]]], load_json_data: Callable[[str], list[dict[str, Any]]], format_duration: Callable[[Any], str]) -> dict[str, list[dict[str, Any]]]:
    return compat_func(load_json_data=load_json_data, format_duration=format_duration)


def local_recording_path(path: str, *, compat_func: Callable[[str], Path]) -> Path:
    return compat_func(path)