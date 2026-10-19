from __future__ import annotations

import io
import zipfile

from src.backend.routers import recordings as recordings_router


class _TrackingSource(io.BytesIO):
    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.read_sizes: list[int] = []

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        return super().read(size)


class _FakeBlob:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.sources: list[_TrackingSource] = []

    def exists(self) -> bool:
        return True

    def open(self, mode: str):
        assert mode == "rb"
        source = _TrackingSource(self.data)
        self.sources.append(source)
        return source


class _FakeBucket:
    def __init__(self, blobs: dict[str, _FakeBlob]) -> None:
        self.blobs = blobs

    def blob(self, object_name: str) -> _FakeBlob:
        return self.blobs[object_name]


def test_stream_recordings_zip_reads_cloud_recording_in_fixed_chunks(monkeypatch):
    data = b"a" * (recordings_router.ZIP_STREAM_CHUNK_SIZE * 2 + 123)
    blob = _FakeBlob(data)
    bucket = _FakeBucket({"2026-09-06/piece/test.mp3": blob})

    monkeypatch.setattr(recordings_router, "get_storage_bucket", lambda: bucket)

    payload = b"".join(
        recordings_router._stream_recordings_zip(
            [
                {
                    "source": "google_cloud_storage",
                    "object_name": "2026-09-06/piece/test.mp3",
                    "name": "test.mp3",
                }
            ]
        )
    )

    assert blob.sources
    assert blob.sources[0].read_sizes
    assert all(
        size == recordings_router.ZIP_STREAM_CHUNK_SIZE
        for size in blob.sources[0].read_sizes
    )

    with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
        assert archive.namelist() == ["test.mp3"]
        assert archive.read("test.mp3") == data


def test_download_zip_returns_streaming_response(monkeypatch):
    item = {
        "source": "google_cloud_storage",
        "object_name": "2026-09-06/piece/test.mp3",
        "name": "test.mp3",
        "date": "2026-09-06",
        "piece": "piece",
    }

    monkeypatch.setattr(
        recordings_router,
        "recording_payload",
        lambda **_: {"files": [item]},
    )
    monkeypatch.setattr(recordings_router, "_recording_exists", lambda _: True)

    response = __import__("asyncio").run(
        recordings_router.download_recordings_zip(date="2026-09-06")
    )

    assert response.media_type == "application/zip"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.__class__.__name__ == "StreamingResponse"


class _SizedBlob:
    def __init__(self, size: int) -> None:
        self.size = size


class _SizedBucket:
    def __init__(self, sizes: dict[str, int]) -> None:
        self.sizes = sizes

    def get_blob(self, object_name: str, *, timeout: int, retry):
        assert timeout == 10
        assert retry is None
        size = self.sizes.get(object_name)
        return _SizedBlob(size) if size is not None else None


def test_zip_info_reports_size_before_download_and_skips_missing(monkeypatch):
    items = [
        {"source": "google_cloud_storage", "object_name": "d/p/a.mp3", "name": "a.mp3", "date": "d", "piece": "p"},
        {"source": "google_cloud_storage", "object_name": "d/p/b.mp3", "name": "b.mp3", "date": "d", "piece": "p"},
        {"source": "google_cloud_storage", "object_name": "d/q/c.mp3", "name": "c.mp3", "date": "d", "piece": "q"},
        {"source": "google_cloud_storage", "object_name": "e/p/gone.mp3", "name": "gone.mp3", "date": "d", "piece": "p"},
    ]
    monkeypatch.setattr(recordings_router, "recording_payload", lambda **_: {"files": items})
    monkeypatch.setattr(recordings_router, "storage_enabled", lambda: True)
    monkeypatch.setattr(
        recordings_router,
        "get_storage_bucket",
        lambda: _SizedBucket({"d/p/a.mp3": 1000, "d/p/b.mp3": 2500, "d/q/c.mp3": 7}),
    )

    assert recordings_router.recordings_zip_info(date="d", piece="p") == {
        "file_count": 2,
        "missing_count": 1,
        "total_bytes": 3500,
    }
    assert recordings_router.recordings_zip_info(date="d")["total_bytes"] == 3507


def test_zip_info_without_any_file_is_not_found(monkeypatch):
    from fastapi import HTTPException
    import pytest

    monkeypatch.setattr(recordings_router, "recording_payload", lambda **_: {"files": []})
    with pytest.raises(HTTPException) as caught:
        recordings_router.recordings_zip_info(date="none")
    assert caught.value.status_code == 404
