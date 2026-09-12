from __future__ import annotations

import asyncio
import io
from types import SimpleNamespace

from src.backend.services import blob_streaming_service


class _BlobReader(io.BytesIO):
    def __init__(self, content: bytes) -> None:
        super().__init__(content)
        self.max_read_size = 0
        self.read_calls = 0

    def read(self, size: int = -1) -> bytes:
        self.read_calls += 1
        self.max_read_size = max(self.max_read_size, size)
        return super().read(size)


class _Blob:
    def __init__(self, content: bytes) -> None:
        self.content = content
        self.size = len(content)
        self.content_type = "audio/mpeg"
        self.reader = _BlobReader(content)
        self.download_as_bytes_called = False

    def exists(self) -> bool:
        return True

    def reload(self) -> None:
        return None

    def open(self, mode: str):
        assert mode == "rb"
        self.reader.seek(0)
        return self.reader

    def download_as_bytes(self, **_kwargs):
        self.download_as_bytes_called = True
        raise AssertionError("streaming must not use download_as_bytes")


class _Bucket:
    def __init__(self, blob: _Blob) -> None:
        self.blob_instance = blob

    def blob(self, _object_name: str) -> _Blob:
        return self.blob_instance


def _request(range_header: str = "") -> SimpleNamespace:
    return SimpleNamespace(headers={"range": range_header} if range_header else {})


def _response_body(response) -> bytes:
    async def collect() -> bytes:
        return b"".join([chunk async for chunk in response.body_iterator])

    return asyncio.run(collect())


def test_open_ended_range_streams_fixed_chunks(monkeypatch) -> None:
    data_size = blob_streaming_service.STREAM_CHUNK_SIZE * 2 + 123
    expected_data = bytes(index % 256 for index in range(data_size))
    blob = _Blob(expected_data)
    monkeypatch.setattr(blob_streaming_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(blob_streaming_service, "get_storage_bucket", lambda: _Bucket(blob))

    response = blob_streaming_service.stream_storage_blob("recording.mp3", False, _request("bytes=0-"))

    assert response.status_code == 206
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-range"] == f"bytes 0-{data_size - 1}/{data_size}"
    assert response.headers["content-length"] == str(data_size)
    assert _response_body(response) == expected_data
    assert not blob.download_as_bytes_called
    assert blob.reader.max_read_size <= blob_streaming_service.STREAM_CHUNK_SIZE
    assert blob.reader.read_calls >= 3


def test_explicit_range_streams_only_requested_bytes(monkeypatch) -> None:
    blob = _Blob(b"0123456789")
    monkeypatch.setattr(blob_streaming_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(blob_streaming_service, "get_storage_bucket", lambda: _Bucket(blob))

    response = blob_streaming_service.stream_storage_blob("recording.mp3", False, _request("bytes=2-5"))

    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert response.headers["content-length"] == "4"
    assert _response_body(response) == b"2345"
    assert not blob.download_as_bytes_called


def test_non_range_playback_streams_entire_object(monkeypatch) -> None:
    blob = _Blob(b"0123456789")
    monkeypatch.setattr(blob_streaming_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(blob_streaming_service, "get_storage_bucket", lambda: _Bucket(blob))

    response = blob_streaming_service.stream_storage_blob("recording.mp3", False, _request())

    assert response.status_code == 200
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-length"] == "10"
    assert _response_body(response) == b"0123456789"


def test_download_ignores_range_and_preserves_attachment(monkeypatch) -> None:
    blob = _Blob(b"0123456789")
    monkeypatch.setattr(blob_streaming_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(blob_streaming_service, "get_storage_bucket", lambda: _Bucket(blob))

    response = blob_streaming_service.stream_storage_blob("recording.mp3", True, _request("bytes=2-5"))

    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith("attachment;")
    assert "content-range" not in response.headers
    assert _response_body(response) == b"0123456789"