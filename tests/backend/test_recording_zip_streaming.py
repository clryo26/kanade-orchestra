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
