from __future__ import annotations

import io
import zipfile

from src.backend.services import sheet_service


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


def test_stream_sheets_zip_reads_cloud_pdf_in_fixed_chunks(monkeypatch):
    data = b"%PDF-1.7\n" + b"a" * (
        sheet_service.SHEET_ZIP_STREAM_CHUNK_SIZE * 2 + 123
    )
    blob = _FakeBlob(data)
    bucket = _FakeBucket({"sheets/performance/piece/test.pdf": blob})

    monkeypatch.setattr(sheet_service, "get_storage_bucket", lambda: bucket)

    payload = b"".join(
        sheet_service._stream_sheets_zip(
            [
                {
                    "source": "google_cloud_storage",
                    "object_name": "sheets/performance/piece/test.pdf",
                    "name": "test.pdf",
                    "piece": "Symphony",
                }
            ]
        )
    )

    assert blob.sources
    assert blob.sources[0].read_sizes
    assert all(
        size == sheet_service.SHEET_ZIP_STREAM_CHUNK_SIZE
        for size in blob.sources[0].read_sizes
    )

    with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
        assert archive.namelist() == ["Symphony/test.pdf"]
        assert archive.read("Symphony/test.pdf") == data


def test_download_sheets_zip_returns_streaming_response(monkeypatch):
    item = {
        "source": "google_cloud_storage",
        "object_name": "sheets/performance/piece/test.pdf",
        "name": "test.pdf",
        "performance_id": "1",
        "performance_title": "Concert",
        "piece": "Symphony",
        "part": "Cl",
    }

    monkeypatch.setattr(
        sheet_service,
        "load_json_data",
        lambda name: [item] if name == "sheet_library" else [],
    )
    monkeypatch.setattr(sheet_service, "_sheet_exists", lambda _: True)

    response = sheet_service.download_sheets_zip(
        performance_id="1",
        piece="Symphony",
        part="Cl",
    )

    assert response.media_type == "application/zip"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["cache-control"] == "private, max-age=60"
    assert response.__class__.__name__ == "StreamingResponse"
