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
    data_size = blob_streaming_service.MAX_RANGE_RESPONSE_BYTES * 2 + 123
    expected_data = bytes(index % 256 for index in range(data_size))
    blob = _Blob(expected_data)
    monkeypatch.setattr(blob_streaming_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(blob_streaming_service, "get_storage_bucket", lambda: _Bucket(blob))

    response = blob_streaming_service.stream_storage_blob("recording.mp3", False, _request("bytes=0-"))

    assert response.status_code == 206
    assert response.headers["accept-ranges"] == "bytes"
    max_end = blob_streaming_service.MAX_RANGE_RESPONSE_BYTES - 1
    assert response.headers["content-range"] == f"bytes 0-{max_end}/{data_size}"
    assert response.headers["content-length"] == str(blob_streaming_service.MAX_RANGE_RESPONSE_BYTES)
    assert _response_body(response) == expected_data[:blob_streaming_service.MAX_RANGE_RESPONSE_BYTES]
    assert not blob.download_as_bytes_called
    assert blob.reader.max_read_size <= blob_streaming_service.STREAM_CHUNK_SIZE
    assert blob.reader.read_calls >= 3


def test_open_ended_range_from_middle_is_limited(monkeypatch) -> None:
    data_size = blob_streaming_service.MAX_RANGE_RESPONSE_BYTES * 2 + 123
    expected_data = bytes(index % 256 for index in range(data_size))
    start = blob_streaming_service.STREAM_CHUNK_SIZE + 7
    blob = _Blob(expected_data)
    monkeypatch.setattr(blob_streaming_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(blob_streaming_service, "get_storage_bucket", lambda: _Bucket(blob))

    response = blob_streaming_service.stream_storage_blob("recording.mp3", False, _request(f"bytes={start}-"))

    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes {start}-{start + blob_streaming_service.MAX_RANGE_RESPONSE_BYTES - 1}/{data_size}"
    assert response.headers["content-length"] == str(blob_streaming_service.MAX_RANGE_RESPONSE_BYTES)
    assert _response_body(response) == expected_data[start:start + blob_streaming_service.MAX_RANGE_RESPONSE_BYTES]
    assert not blob.download_as_bytes_called
    assert blob.reader.max_read_size <= blob_streaming_service.STREAM_CHUNK_SIZE


def test_explicit_large_range_is_limited(monkeypatch) -> None:
    data_size = blob_streaming_service.MAX_RANGE_RESPONSE_BYTES * 2 + 123
    expected_data = bytes(index % 256 for index in range(data_size))
    start = 123
    blob = _Blob(expected_data)
    monkeypatch.setattr(blob_streaming_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(blob_streaming_service, "get_storage_bucket", lambda: _Bucket(blob))

    response = blob_streaming_service.stream_storage_blob("recording.mp3", False, _request(f"bytes={start}-{data_size - 1}"))

    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes {start}-{start + blob_streaming_service.MAX_RANGE_RESPONSE_BYTES - 1}/{data_size}"
    assert response.headers["content-length"] == str(blob_streaming_service.MAX_RANGE_RESPONSE_BYTES)
    assert _response_body(response) == expected_data[start:start + blob_streaming_service.MAX_RANGE_RESPONSE_BYTES]


def test_small_range_is_not_expanded(monkeypatch) -> None:
    expected_data = b"0123456789"
    blob = _Blob(expected_data)
    monkeypatch.setattr(blob_streaming_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(blob_streaming_service, "get_storage_bucket", lambda: _Bucket(blob))

    response = blob_streaming_service.stream_storage_blob("recording.mp3", False, _request("bytes=2-5"))

    assert response.headers["content-range"] == "bytes 2-5/10"
    assert response.headers["content-length"] == "4"
    assert _response_body(response) == b"2345"


def test_range_near_end_returns_only_remaining_bytes(monkeypatch) -> None:
    data_size = blob_streaming_service.MAX_RANGE_RESPONSE_BYTES + 123
    expected_data = bytes(index % 256 for index in range(data_size))
    start = data_size - 50
    blob = _Blob(expected_data)
    monkeypatch.setattr(blob_streaming_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(blob_streaming_service, "get_storage_bucket", lambda: _Bucket(blob))

    response = blob_streaming_service.stream_storage_blob("recording.mp3", False, _request(f"bytes={start}-"))

    assert response.headers["content-range"] == f"bytes {start}-{data_size - 1}/{data_size}"
    assert response.headers["content-length"] == "50"
    assert _response_body(response) == expected_data[start:]


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