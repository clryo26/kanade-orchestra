from __future__ import annotations

import re
import shutil
from pathlib import Path

from fastapi import HTTPException, UploadFile


def safe_segment(value: str, default: str) -> str:
    text = (value or default).strip()
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text or default


def safe_upload_name(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    stem = safe_segment(Path(filename).stem, "audio")
    return f"{stem}{suffix}"


def ensure_audio_file(file: UploadFile) -> str:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".mp3", ".m4a"}:
        raise HTTPException(status_code=400, detail="Please upload an MP3 or M4A file")
    return suffix


def ensure_pdf_file(file: UploadFile) -> None:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix != ".pdf":
        raise HTTPException(status_code=400, detail="Please upload a PDF file")


def save_upload_to_path(file: UploadFile, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    output_path = directory / safe_upload_name(file.filename or "audio")
    with output_path.open("wb") as target:
        shutil.copyfileobj(file.file, target)
    return output_path


def format_duration(seconds: float | int | None) -> str:
    if seconds is None:
        return ""
    total = int(round(float(seconds)))
    minutes, sec = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{sec:02d}"
    return f"{minutes}:{sec:02d}"
