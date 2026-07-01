from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

try:
    import imageio_ffmpeg
except ImportError:  # pragma: no cover
    imageio_ffmpeg = None

try:
    from pydub import AudioSegment
except ImportError:  # pragma: no cover
    AudioSegment = None


if AudioSegment is not None and imageio_ffmpeg is not None:
    AudioSegment.converter = imageio_ffmpeg.get_ffmpeg_exe()


def convert_path_to_mp3(source_path: Path, suffix: str, bitrate: int, *, logger) -> Path:
    output_path = source_path.with_suffix(".mp3")
    if suffix == ".mp3":
        if source_path != output_path:
            source_path.replace(output_path)
        return output_path

    if AudioSegment is None:
        raise HTTPException(status_code=500, detail="pydub is not available")

    try:
        audio = AudioSegment.from_file(source_path, format=suffix.lstrip("."))
        audio.export(output_path, format="mp3", bitrate=f"{bitrate}k")
        source_path.unlink(missing_ok=True)
    except Exception as exc:
        logger.exception("Audio conversion failed")
        raise HTTPException(
            status_code=500,
            detail="Audio conversion failed. Make sure ffmpeg is installed.",
        ) from exc

    return output_path


def get_audio_duration_seconds(path: Path, *, logger) -> float | None:
    if AudioSegment is None:
        return None
    try:
        audio = AudioSegment.from_file(path)
        return round(len(audio) / 1000, 1)
    except Exception:
        logger.warning("Failed to get audio duration: %s", path, exc_info=True)
        return None