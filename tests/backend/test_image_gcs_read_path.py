from __future__ import annotations

import pytest
from fastapi import HTTPException
from google.api_core.exceptions import NotFound

from src.backend.services import album_service, image_asset_service


class _Blob:
    def __init__(self, content: bytes = b"image-bytes", *, missing: bool = False) -> None:
        self._content = content
        self._missing = missing
        self.download_calls = 0

    def exists(self) -> bool:
        raise AssertionError("a read path must not perform a separate exists() request")

    def download_as_bytes(self) -> bytes:
        self.download_calls += 1
        if self._missing:
            raise NotFound("missing")
        return self._content


class _Bucket:
    def __init__(self, blob: _Blob) -> None:
        self._blob = blob

    def blob(self, _object_name: str) -> _Blob:
        return self._blob


def test_stored_image_reads_gcs_content_without_exists_round_trip(monkeypatch) -> None:
    blob = _Blob()
    monkeypatch.setattr(image_asset_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(image_asset_service, "get_storage_bucket", lambda: _Bucket(blob))

    response = image_asset_service.serve_stored_image(
        "/api/members/1/photo?ext=png",
        object_prefix="member-images/1/photo",
    )

    assert response.body == b"image-bytes"
    assert blob.download_calls == 1


def test_stored_image_maps_gcs_not_found_to_404(monkeypatch) -> None:
    monkeypatch.setattr(image_asset_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(image_asset_service, "get_storage_bucket", lambda: _Bucket(_Blob(missing=True)))

    with pytest.raises(HTTPException) as raised:
        image_asset_service.serve_stored_image(
            "/api/members/1/photo?ext=png",
            object_prefix="member-images/1/photo",
        )

    assert raised.value.status_code == 404
    assert raised.value.detail == "Image not found"


def test_album_photo_reads_gcs_content_without_exists_round_trip(monkeypatch) -> None:
    blob = _Blob(b"album-image")
    monkeypatch.setattr(album_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(album_service, "get_storage_bucket", lambda: _Bucket(blob))
    monkeypatch.setattr(
        album_service,
        "load_json_data",
        lambda _name: [{"id": 1, "photos": [{"id": 2, "filename": "photo.png", "object_name": "albums/1/2.png"}]}],
    )

    response = album_service.get_album_photo_response(1, 2)

    assert response.body == b"album-image"
    assert blob.download_calls == 1


def test_album_photo_maps_gcs_not_found_to_404(monkeypatch) -> None:
    monkeypatch.setattr(album_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(album_service, "get_storage_bucket", lambda: _Bucket(_Blob(missing=True)))
    monkeypatch.setattr(
        album_service,
        "load_json_data",
        lambda _name: [{"id": 1, "photos": [{"id": 2, "filename": "photo.png", "object_name": "albums/1/2.png"}]}],
    )

    with pytest.raises(HTTPException) as raised:
        album_service.get_album_photo_response(1, 2)

    assert raised.value.status_code == 404
    assert raised.value.detail == "Photo object not found"
