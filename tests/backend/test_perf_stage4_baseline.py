"""Stage 4-0: exercise unmodified photo routes with synthetic store/GCS only.

These assertions describe the BEFORE behaviour, including its limitations.
Keep the saved report when the implementation changes; do not turn these
counts into acceptance targets for the new conditional-GET implementation.
"""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
import hashlib
from importlib.metadata import version
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import time
from types import SimpleNamespace

import pytest
from google.api_core.exceptions import NotFound, PreconditionFailed
from PIL import Image, __version__ as pillow_version


ROOT = Path(__file__).resolve().parents[2]
SOURCE_PATHS = (
    "src/backend/services/album_service.py",
    "src/backend/routers/albums.py",
    "src/backend/repositories/db_item_repository.py",
    "src/backend/repositories/db_json_repository.py",
    "src/backend/core/db_schema.py",
)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def image_bytes(colour="blue"):
    output = io.BytesIO()
    Image.new("RGB", (1200, 900), colour).save(output, format="JPEG", quality=85)
    return output.getvalue()


class SyntheticStore:
    def __init__(self, albums, counts):
        self.albums = albums
        self.counts = counts

    def get(self, name, item_id):
        assert name == "albums"
        self.counts["store_get_calls"] += 1
        item = next((row for row in self.albums if row["id"] == item_id), None)
        if item is not None:
            self.counts["nested_photo_records_returned"] += len(item["photos"])
        return deepcopy(item)


class SyntheticBucket:
    """No SDK client: count adapter operations, not real GCS HTTP requests."""

    def __init__(self, objects, counts):
        self.objects = objects
        self.counts = counts

    def blob(self, name):
        return SyntheticBlob(self, name)

    def get_blob(self, name, **kwargs):
        self.counts["metadata_get_calls"] += 1
        return self.blob(name) if name in self.objects else None


class SyntheticBlob:
    def __init__(self, bucket, name):
        self.bucket = bucket
        self.name = name

    def exists(self, **kwargs):
        self.bucket.counts["metadata_exists_calls"] += 1
        return self.name in self.bucket.objects

    def reload(self, **kwargs):
        self.bucket.counts["metadata_reload_calls"] += 1
        if self.name not in self.bucket.objects:
            raise NotFound("synthetic missing object")

    def download_as_bytes(self, *, timeout):
        assert timeout == 30
        kind = "thumbnail" if self.name.startswith("album-thumbnails/") else "original"
        self.bucket.counts[f"{kind}_download_calls"] += 1
        if self.name not in self.bucket.objects:
            self.bucket.counts["media_not_found"] += 1
            raise NotFound("synthetic missing object")
        body = self.bucket.objects[self.name]
        self.bucket.counts["adapter_media_bytes"] += len(body)
        return body

    def upload_from_string(self, content, *, content_type, if_generation_match, timeout):
        assert content_type == "image/webp"
        assert if_generation_match == 0 and timeout == 30
        self.bucket.counts["thumbnail_upload_calls"] += 1
        if self.name in self.bucket.objects:
            raise PreconditionFailed("synthetic existing object")
        self.bucket.objects[self.name] = bytes(content)

    def delete(self, **kwargs):
        raise AssertionError("Stage 4-0 display measurement must not delete objects")


def synthetic_albums(scale):
    # Standard/2x album counts: 20/500 and 40/1000. 25 photos per album.
    albums = []
    for album_id in range(1, 20 * scale + 1):
        photos = []
        for offset in range(1, 26):
            photo_id = (album_id - 1) * 25 + offset
            photos.append({
                "id": photo_id, "filename": f"fixture-{photo_id}.jpg",
                "url": f"/api/albums/{album_id}/photos/{photo_id}",
                "object_name": f"albums/{album_id}/synthetic/{photo_id}.jpg",
                "uploaded_at": "2026-10-23T00:00:00Z",
            })
        albums.append({"id": album_id, "event_name": f"Synthetic {album_id}", "photos": photos})
    return albums


@pytest.fixture
def photo_harness(backend_env, monkeypatch):
    import google.cloud.storage
    import psycopg
    from src.backend.services import album_service

    def deny_external(*args, **kwargs):
        raise AssertionError("No real DB/GCS connection allowed in stage 4-0 baseline")

    monkeypatch.setattr(psycopg, "connect", deny_external)
    monkeypatch.setattr(google.cloud.storage, "Client", deny_external)
    counts = Counter()
    objects = {}
    store = SyntheticStore([], counts)
    bucket = SyntheticBucket(objects, counts)
    original_make = album_service._make_thumbnail

    def counted_make(content):
        counts["thumbnail_builds"] += 1
        return original_make(content)

    monkeypatch.setattr(album_service, "_store", lambda: store)
    monkeypatch.setattr(album_service, "storage_enabled", lambda: True)
    monkeypatch.setattr(album_service, "get_storage_bucket", lambda: bucket)
    monkeypatch.setattr(album_service, "_make_thumbnail", counted_make)
    return store, bucket, counts


@pytest.fixture(scope="module")
def measurement_report():
    samples = []
    yield samples
    destination = os.getenv("PORTAL_PERF_STAGE4_REPORT", "").strip()
    if not destination:
        return
    path = (ROOT / destination).resolve()
    allowed = (ROOT / ".tmp/perf_stage4").resolve()
    if path.parent != allowed or path.suffix != ".json":
        raise ValueError("Report must be a JSON file directly under .tmp/perf_stage4")
    assert len(samples) == 90, "Do not publish an incomplete baseline report"
    report = {
        "date": "2026-10-23", "phase": "4-0 BEFORE",
        "measured_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_sha256": {name: digest((ROOT / name).read_bytes()) for name in SOURCE_PATHS},
        "measurement_sha256": digest(Path(__file__).read_bytes()),
        "environment": {"python": platform.python_version(), "pillow": pillow_version,
                        "google_cloud_storage": version("google-cloud-storage"),
                        "fastapi": version("fastapi"),
                        "system": platform.system(), "http": "in-process FastAPI TestClient",
                        "storage": "synthetic byte dictionary; SDK/network not used",
                        "store": "synthetic album lookup returning full target album"},
        "fixture": {"album_scales": [20, 40], "photo_scales": [500, 1000],
                    "photos_per_album": 25, "original_dimensions": [1200, 900],
                    "original_sha256": digest(image_bytes()), "display_counts": [1, 25, 50],
                    "repeats": 5, "states": ["cold", "warm", "warm_conditional_probe"]},
        "unmeasured": {"sql_count": None, "pool_wait_ms": None, "real_gcs_http_requests": None,
                       "sdk_retry_count": None, "wire_bytes": None, "peak_memory_bytes": None,
                       "real_browser_cache": None, "real_db_inventory": None,
                       "real_gcs_inventory": None, "iphone_bfcache": None},
        "samples": samples,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@pytest.mark.parametrize("scale", [1, 2])
@pytest.mark.parametrize("display_count", [1, 25, 50])
def test_before_thumbnail_batches(client, photo_harness, measurement_report, scale, display_count):
    from src.backend.services import album_service

    store, bucket, counts = photo_harness
    store.albums = synthetic_albums(scale)
    photos = [photo for row in store.albums for photo in row["photos"]]
    original = image_bytes()
    originals = {photo["object_name"]: original for photo in photos}
    # Seed warm derived objects outside measured calls using the REAL encoder/key.
    # This avoids labelling setup downloads/decodes as warm request work.
    thumb = album_service._make_thumbnail(image_bytes())
    derived = {album_service._thumbnail_key(photo): thumb for photo in photos}
    visible = [(row["id"], photo) for row in store.albums for photo in row["photos"]][:display_count]
    for repeat in range(5):
        for state in ("cold", "warm", "warm_conditional_probe"):
            bucket.objects.clear()
            bucket.objects.update(originals)
            if state != "cold":
                bucket.objects.update(derived)
            counts.clear()
            statuses = Counter()
            headers = {"Accept-Encoding": "identity"}
            if state == "warm_conditional_probe":
                # Baseline issues no GCS-photo ETag; this is a protocol probe,
                # NOT a browser sending a previously issued validator.
                headers["If-None-Match"] = "*"
            started = time.perf_counter()
            body_bytes = 0
            bodies = []
            for album_id, photo in visible:
                response = client.get(f"/api/albums/{album_id}/photos/{photo['id']}/thumbnail", headers=headers)
                statuses[response.status_code] += 1
                assert response.status_code == 200
                assert response.headers["cache-control"] == "private, no-cache"
                assert "etag" not in response.headers
                body_bytes += len(response.content)
                bodies.append(digest(response.content))
            elapsed = (time.perf_counter() - started) * 1000
            assert counts["store_get_calls"] == display_count
            assert counts["nested_photo_records_returned"] == display_count * 25
            assert counts["thumbnail_download_calls"] == display_count
            assert sum(counts[key] for key in ("metadata_get_calls", "metadata_exists_calls", "metadata_reload_calls")) == 0
            expected_cold = display_count if state == "cold" else 0
            assert counts["original_download_calls"] == expected_cold
            assert counts["thumbnail_builds"] == expected_cold
            assert counts["thumbnail_upload_calls"] == expected_cold
            assert all(bucket.objects[name] == content for name, content in originals.items())
            measurement_report.append({
                "scale": scale, "display_count": display_count, "repeat": repeat, "state": state,
                "statuses": dict(statuses), "elapsed_ms_local": round(elapsed, 3),
                "application_body_bytes": body_bytes, "body_sha256": digest("".join(bodies).encode()),
                "counts": {key: counts[key] for key in (
                    "store_get_calls", "nested_photo_records_returned", "metadata_get_calls",
                    "metadata_exists_calls", "metadata_reload_calls", "thumbnail_download_calls",
                    "original_download_calls", "thumbnail_builds", "thumbnail_upload_calls",
                    "media_not_found", "adapter_media_bytes")},
            })


def test_before_deleted_reference_is_checked_before_cached_thumbnail(client, photo_harness):
    from src.backend.services import album_service

    store, bucket, counts = photo_harness
    store.albums = synthetic_albums(1)
    photo = store.albums[0]["photos"][0]
    bucket.objects[photo["object_name"]] = image_bytes()
    assert client.get("/api/albums/1/photos/1/thumbnail").status_code == 200
    assert album_service._thumbnail_key(photo) in bucket.objects
    store.albums[0]["photos"] = []
    counts.clear()
    assert client.get("/api/albums/1/photos/1/thumbnail").status_code == 404
    assert counts["thumbnail_download_calls"] == 0


def test_before_same_source_key_replacement_does_not_invalidate_derived_cache(client, photo_harness):
    store, bucket, counts = photo_harness
    store.albums = synthetic_albums(1)
    photo = store.albums[0]["photos"][0]
    bucket.objects[photo["object_name"]] = image_bytes("blue")
    initial = client.get("/api/albums/1/photos/1/thumbnail")
    bucket.objects[photo["object_name"]] = image_bytes("red")
    counts.clear()
    later = client.get("/api/albums/1/photos/1/thumbnail")
    assert initial.content == later.content
    assert counts["original_download_calls"] == 0
    assert client.get("/api/albums/1/photos/1").content == image_bytes("red")


@pytest.mark.parametrize("photo_count", [25, 50])
def test_before_child_writer_replaces_unchanged_photo_rows(monkeypatch, photo_count):
    from src.backend.repositories import db_item_repository as repository

    class RecordingCursor:
        def __init__(self):
            self.deletes = []
            self.insert_batches = []

        def execute(self, query, params):
            text = query.as_string(None)
            assert text.startswith('DELETE FROM "album_photos"')
            self.deletes.append((text, params))

        def executemany(self, query, rows):
            text = query.as_string(None)
            assert text.startswith('INSERT INTO "album_photos"')
            self.insert_batches.append((text, rows))

    albums = synthetic_albums(1)
    item = {**albums[0], "organization_id": "synthetic"}
    item["photos"] = [photo for album in albums for photo in album["photos"]][:photo_count]
    current_photos = deepcopy(item["photos"])
    cur = RecordingCursor()
    ctx = SimpleNamespace(cur=cur, conn=object(), tenant_id="synthetic")
    monkeypatch.setattr(repository, "table_has_organization_id", lambda *_args: True)
    # Real child conversion and db_insert_rows; SQL is captured, never executed.
    store = repository.PostgresRowStore()
    for name in ("Before title", "After title"):
        store._write_children(ctx, "albums", {**item, "event_name": name}, "2026-10-23T00:00:00Z")
    assert item["photos"] == current_photos
    assert len(cur.deletes) == 2
    assert len(cur.insert_batches) == 2
    assert all(len(rows) == photo_count for _query, rows in cur.insert_batches)
