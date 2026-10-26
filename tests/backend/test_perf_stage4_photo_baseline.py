"""Varied, pinned synthetic photos for stage 4A transfer comparisons.

The blue-only baseline and its report remain unchanged. This measurement uses
the same real routes/encoder and no-real-DB/GCS harness with richer input bytes.
"""
from __future__ import annotations

from collections import Counter
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import time

from PIL import Image, __version__ as pillow_version, features
import pytest

from test_perf_stage4_baseline import (
    ROOT, SOURCE_PATHS, digest, photo_harness, synthetic_albums,  # noqa: F401
)


FIXTURES = ROOT / "tests/fixtures/perf_stage4_photos"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def pinned_photos():
    photos = {}
    for entry in MANIFEST["images"]:
        content = (FIXTURES / entry["file"]).read_bytes()
        assert len(content) == entry["bytes"]
        assert digest(content) == entry["sha256"], "Do not silently replace the comparison input"
        photos[entry["id"]] = content
    assert len(set(map(digest, photos.values()))) == 4
    return photos


@pytest.mark.parametrize("entry", MANIFEST["images"], ids=lambda entry: entry["id"])
def test_pinned_photo_shape_texture_and_orientation(backend_env, pinned_photos, entry):
    from src.backend.services import album_service

    original = pinned_photos[entry["id"]]
    with Image.open(io.BytesIO(original)) as image:
        assert list(image.size) == entry["encoded_size"]
        assert image.getexif()[274] == entry["exif_orientation"]
    thumbnail = album_service._make_thumbnail(original)
    # These texture fixtures must exercise transfers in tens of KiB, rather
    # than the 288-byte solid-colour protocol fixture. Not a user-photo limit.
    assert len(thumbnail) >= 16 * 1024
    with Image.open(io.BytesIO(thumbnail)) as image:
        assert image.format == "WEBP"
        expected = (256, 384) if entry["id"] in {"portrait", "exif_rotated"} else (384, 288)
        assert image.size == expected
        red, green, blue = image.getpixel((8, 8))
        if entry["exif_orientation"] == 6:
            assert blue > 180 and red < 70 and green < 70
        else:
            assert red > 180 and green < 70 and blue < 70


@pytest.fixture(scope="module")
def photo_report():
    value = {"samples": [], "thumbnails": {}}
    yield value
    if os.getenv("PORTAL_PERF_STAGE4_PHOTO_REPORT") != "1":
        return
    assert len(value["samples"]) == 90, "Do not publish partial measurements"
    report = {
        "date": "2026-10-23", "phase": "4-0 PHOTO BEFORE",
        "measured_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_sha256": {name: digest((ROOT / name).read_bytes()) for name in SOURCE_PATHS},
        "measurement_sha256": digest(Path(__file__).read_bytes()),
        "harness_sha256": digest((ROOT / "tests/backend/test_perf_stage4_baseline.py").read_bytes()),
        "fixture_manifest_sha256": digest((FIXTURES / "manifest.json").read_bytes()),
        "environment": {"system": platform.system(), "python": platform.python_version(),
                        "pillow": pillow_version, "jpeg": features.version_codec("jpg"),
                        "webp": features.version_module("webp"),
                        "http": "in-process FastAPI TestClient, Accept-Encoding identity",
                        "store_and_gcs": "synthetic; SDK/network not exercised"},
        "fixture_manifest": MANIFEST,
        "thumbnails": value["thumbnails"],
        "assignment": "id order cycles four images, shifted by repeat index modulo 4",
        "album_scales": [20, 40], "photo_scales": [500, 1000],
        "display_counts": [1, 25, 50], "repeats": 5,
        "unmeasured": {"real_sql_count": None, "pool_wait_ms": None,
                       "real_gcs_http_count": None, "sdk_retry_count": None,
                       "wire_bytes": None, "peak_memory_bytes": None,
                       "real_browser_cache": None, "iphone_bfcache": None},
        "samples": value["samples"],
    }
    target = ROOT / ".tmp/perf_stage4/PHOTO_BASELINE_BEFORE.json"
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@pytest.mark.parametrize("scale", [1, 2])
@pytest.mark.parametrize("display_count", [1, 25, 50])
def test_before_photo_texture_batches(client, photo_harness, pinned_photos, photo_report, scale, display_count):  # noqa: F811 - imported pytest fixture
    from src.backend.services import album_service

    store, bucket, counts = photo_harness
    store.albums = synthetic_albums(scale)
    all_photos = [photo for row in store.albums for photo in row["photos"]]
    visible = [(row["id"], photo) for row in store.albums for photo in row["photos"]][:display_count]
    fixture_ids = list(pinned_photos)
    thumbnails = {name: album_service._make_thumbnail(content) for name, content in pinned_photos.items()}
    for name, content in thumbnails.items():
        with Image.open(io.BytesIO(content)) as image:
            photo_report["thumbnails"][name] = {"bytes": len(content), "sha256": digest(content),
                                                "size": list(image.size)}
    for repeat in range(5):
        assignments = {photo["id"]: fixture_ids[(photo["id"] - 1 + repeat) % len(fixture_ids)]
                       for photo in all_photos}
        originals = {photo["object_name"]: pinned_photos[assignments[photo["id"]]] for photo in all_photos}
        derived = {album_service._thumbnail_key(photo): thumbnails[assignments[photo["id"]]] for photo in all_photos}
        for state in ("cold", "warm", "warm_conditional_probe"):
            bucket.objects.clear()
            bucket.objects.update(originals)
            if state != "cold":
                bucket.objects.update(derived)
            counts.clear()
            headers = {"Accept-Encoding": "identity"}
            if state == "warm_conditional_probe":
                headers["If-None-Match"] = "*"
            started = time.perf_counter()
            statuses = Counter()
            bodies = []
            body_bytes = 0
            for album_id, photo in visible:
                response = client.get(f"/api/albums/{album_id}/photos/{photo['id']}/thumbnail", headers=headers)
                statuses[response.status_code] += 1
                assert response.status_code == 200
                assert response.headers["cache-control"] == "private, no-cache"
                assert "etag" not in response.headers
                assert response.content == thumbnails[assignments[photo["id"]]]
                body_bytes += len(response.content)
                bodies.append(digest(response.content))
            elapsed = (time.perf_counter() - started) * 1000
            assert counts["store_get_calls"] == display_count
            assert counts["nested_photo_records_returned"] == 25 * display_count
            assert counts["thumbnail_download_calls"] == display_count
            assert sum(counts[name] for name in ("metadata_get_calls", "metadata_exists_calls", "metadata_reload_calls")) == 0
            cold = display_count if state == "cold" else 0
            assert counts["original_download_calls"] == cold
            assert counts["thumbnail_builds"] == cold
            assert counts["thumbnail_upload_calls"] == cold
            assert all(bucket.objects[name] == body for name, body in originals.items())
            photo_report["samples"].append({
                "scale": scale, "display_count": display_count, "repeat": repeat, "state": state,
                "fixture_mix": dict(Counter(assignments[photo["id"]] for _album, photo in visible)),
                "statuses": dict(statuses), "application_body_bytes": body_bytes,
                "body_sha256": digest("".join(bodies).encode()), "elapsed_ms_local": round(elapsed, 3),
                "counts": {name: counts[name] for name in (
                    "store_get_calls", "nested_photo_records_returned", "metadata_get_calls",
                    "metadata_exists_calls", "metadata_reload_calls", "thumbnail_download_calls",
                    "original_download_calls", "thumbnail_builds", "thumbnail_upload_calls",
                    "media_not_found", "adapter_media_bytes")},
            })
