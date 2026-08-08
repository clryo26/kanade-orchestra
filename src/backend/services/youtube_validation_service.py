from __future__ import annotations

import socket
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

from fastapi import HTTPException


_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}


@dataclass(frozen=True)
class YouTubeLookupResult:
    video_id: str
    canonical_url: str


def _extract_video_id_from_query(url: str) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    return str(query.get("v", [""])[0] or "").strip()


def _extract_video_id(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.strip("/")

    if host == "youtu.be":
        return path.split("/", 1)[0].strip()

    if host in _YOUTUBE_HOSTS:
        if path == "watch":
            return _extract_video_id_from_query(url)
        segments = [segment for segment in path.split("/") if segment]
        if len(segments) >= 2 and segments[0] in {"embed", "shorts", "live"}:
            return segments[1].strip()

    return ""


def _canonical_youtube_url(url: str, video_id: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if host == "youtu.be":
        return f"https://www.youtube.com/watch?v={video_id}"
    return url.strip()


def normalize_youtube_url(url: str) -> YouTubeLookupResult:
    text = str(url or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="参考音源のURLが空です")

    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="参考音源はYouTubeのURLを入力してください")

    if parsed.netloc.lower() not in _YOUTUBE_HOSTS:
        raise HTTPException(status_code=400, detail="参考音源はYouTubeのURLを入力してください")

    video_id = _extract_video_id(text)
    if len(video_id) != 11 or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for char in video_id):
        raise HTTPException(status_code=400, detail="参考音源はYouTubeの動画URLを入力してください")

    return YouTubeLookupResult(video_id=video_id, canonical_url=_canonical_youtube_url(text, video_id))


def _youtube_oembed_request(url: str) -> Any:
    query = urlencode({"url": url, "format": "json"})
    request = Request(
        f"https://www.youtube.com/oembed?{query}",
        headers={"User-Agent": "Mozilla/5.0"},
    )
    return urlopen(request, timeout=5)


def validate_youtube_url(url: str) -> str:
    text = str(url or "").strip()
    if not text:
        return ""

    lookup = normalize_youtube_url(text)
    try:
        with _youtube_oembed_request(lookup.canonical_url) as response:
            if getattr(response, "status", 200) >= 400:
                raise HTTPException(status_code=503, detail="YouTube動画の存在確認に失敗しました")
            response.read()
    except HTTPError as exc:
        if exc.code in {404, 410}:
            raise HTTPException(status_code=400, detail="指定されたYouTube動画が見つかりません") from exc
        if exc.code == 400:
            raise HTTPException(status_code=400, detail="参考音源はYouTubeの動画URLを入力してください") from exc
        raise HTTPException(status_code=503, detail="YouTube動画の存在確認に失敗しました") from exc
    except (URLError, TimeoutError, socket.timeout, ValueError) as exc:
        raise HTTPException(status_code=503, detail="YouTube動画の存在確認に失敗しました") from exc
    return lookup.canonical_url
