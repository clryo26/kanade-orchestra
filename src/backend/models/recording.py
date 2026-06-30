from __future__ import annotations

from pydantic import BaseModel


class RecordingFile(BaseModel):
    name: str
    path: str = ""
    date: str = ""
    piece: str = ""
    size: int = 0
    play_url: str = ""
    download_url: str = ""
