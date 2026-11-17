# Pure tests for canonical YouTube video URLs.
import pytest
from fastapi import HTTPException

from src.backend.services.youtube_validation_service import normalize_youtube_url


def test_watch_url_keeps_only_video_id():
    result = normalize_youtube_url(
        "https://www.youtube.com/watch?v=AbCDef_12-3&si=share&t=90&list=x&feature=y#frag"
    )
    assert result.video_id == "AbCDef_12-3"
    assert result.canonical_url == "https://www.youtube.com/watch?v=AbCDef_12-3"


def test_all_allowed_hosts_with_http_output_https():
    for host in ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]:
        result = normalize_youtube_url(f"http://{host}/watch?v=AbCDef_12-3&t=5")
        assert result.video_id == "AbCDef_12-3"
        assert result.canonical_url == "https://www.youtube.com/watch?v=AbCDef_12-3"


def test_short_host_url():
    result = normalize_youtube_url("http://youtu.be/AbCDef_12-3?si=share&t=9")
    assert result.video_id == "AbCDef_12-3"
    assert result.canonical_url == "https://www.youtube.com/watch?v=AbCDef_12-3"


def test_shorts_embed_and_live_paths():
    for kind in ["shorts", "embed", "live"]:
        result = normalize_youtube_url(
            f"https://music.youtube.com/{kind}/AbCDef_12-3?list=sample#x"
        )
        assert result.video_id == "AbCDef_12-3"
        assert result.canonical_url == "https://www.youtube.com/watch?v=AbCDef_12-3"


def test_empty_url_rejected():
    with pytest.raises(HTTPException) as excinfo:
        normalize_youtube_url("   ")
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == "参考音源のURLが空です"


def test_bad_scheme_rejected():
    with pytest.raises(HTTPException) as excinfo:
        normalize_youtube_url("ftp://www.youtube.com/watch?v=AbCDef_12-3")
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == "参考音源はYouTubeのURLを入力してください"


def test_bad_host_rejected():
    with pytest.raises(HTTPException) as excinfo:
        normalize_youtube_url("https://example.com/watch?v=AbCDef_12-3")
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == "参考音源はYouTubeのURLを入力してください"


def test_bad_video_id_rejected():
    for bad in [
        "https://www.youtube.com/watch?v=short",
        "https://www.youtube.com/watch?v=AbCDef_12-$",
        "https://www.youtube.com/playlist?list=abc",
    ]:
        with pytest.raises(HTTPException) as excinfo:
            normalize_youtube_url(bad)
        assert excinfo.value.status_code == 400
        assert excinfo.value.detail == "参考音源はYouTubeの動画URLを入力してください"
