from __future__ import annotations

from types import SimpleNamespace

import pytest

from scripts.sync_prod_to_test_gcs import (
    GcsSyncConfig,
    build_sync_plan,
    synchronize,
    validate_config,
)


class FakeBlob:
    def __init__(self, bucket, name, value, generation):
        self.bucket = bucket
        self.name = name
        self.value = value
        self.generation = generation
        self.size = len(value)
        self.crc32c = f"crc:{value}"
        self.md5_hash = f"md5:{value}"

    def reload(self):
        return None

    def delete(self, *, if_generation_match):
        assert if_generation_match == self.generation
        self.bucket.events.append(("delete", self.name, if_generation_match))
        del self.bucket.objects[self.name]


class FakeBucket:
    def __init__(self, name, objects=None):
        self.name = name
        self.events = []
        self._generation = 100
        self.objects = {}
        for object_name, value in (objects or {}).items():
            self.put(object_name, value)

    def put(self, name, value):
        self._generation += 1
        blob = FakeBlob(self, name, value, self._generation)
        self.objects[name] = blob
        return blob

    def copy_blob(self, source_blob, destination_bucket, *, new_name, **kwargs):
        assert kwargs["source_generation"] == source_blob.generation
        assert kwargs["if_source_generation_match"] == source_blob.generation
        current = destination_bucket.objects.get(new_name)
        expected_target_generation = current.generation if current else 0
        assert kwargs["if_generation_match"] == expected_target_generation
        self.events.append(("copy", source_blob.name, destination_bucket.name, kwargs))
        return destination_bucket.put(new_name, source_blob.value)


class FakeListing:
    def __init__(self, prefixes):
        self.pages = [SimpleNamespace(prefixes=set(prefixes))]


class FakeClient:
    def __init__(self, prod, test):
        self.buckets = {prod.name: prod, test.name: test}

    def bucket(self, name):
        return self.buckets[name]

    def list_blobs(self, bucket_name, *, prefix=None, delimiter=None):
        bucket = self.buckets[bucket_name]
        if delimiter == "/":
            prefixes = {name.split("/", 1)[0] + "/" for name in bucket.objects if "/" in name}
            return FakeListing(prefixes)
        return [blob for name, blob in bucket.objects.items() if name.startswith(prefix or "")]


def config():
    return GcsSyncConfig("kanade-orchestra", "prod-bucket", "test-bucket")


@pytest.mark.parametrize(
    ("candidate", "message"),
    [
        (GcsSyncConfig("", "prod", "test"), "GCP_PROJECT_ID is required"),
        (GcsSyncConfig("project", "", "test"), "GCS_BUCKET_PROD is required"),
        (GcsSyncConfig("project", "prod", ""), "GCS_BUCKET_TEST is required"),
        (GcsSyncConfig("project", "same", "same"), "must be different"),
    ],
)
def test_validate_config_rejects_invalid_values(candidate, message):
    with pytest.raises(ValueError, match=message):
        validate_config(candidate)


def test_dry_run_selects_only_approved_objects_and_does_not_write():
    prod = FakeBucket(
        "prod-bucket",
        {
            "sheets/score.pdf": "score",
            "albums/photo.jpg": "photo",
            "2026-07-22/song/take.mp3": "recording",
            "2026-02-30/song/invalid.mp3": "invalid-date",
            "recordings/legacy.mp3": "legacy",
            "promotion/banner.jpg": "banner",
            "app-data/data.json": "json",
            "backups/old/file": "backup",
        },
    )
    test = FakeBucket("test-bucket", {"sheets/old.pdf": "old"})
    result = synchronize(config(), client=FakeClient(prod, test))

    assert result["mode"] == "dry-run"
    assert result["copy"] == [
        "2026-07-22/song/take.mp3",
        "albums/photo.jpg",
        "sheets/score.pdf",
    ]
    assert result["delete"] == ["sheets/old.pdf"]
    assert result["writes_permitted"] is False
    assert prod.events == []
    assert test.events == []


def test_build_sync_plan_skips_matching_content():
    bucket = FakeBucket("bucket", {"sheets/a.pdf": "same", "sheets/b.pdf": "new"})
    target_bucket = FakeBucket(
        "target", {"sheets/a.pdf": "same", "sheets/b.pdf": "old", "albums/extra.jpg": "x"}
    )
    source = {name: SimpleNamespace(**vars(blob), blob=blob) for name, blob in bucket.objects.items()}
    target = {
        name: SimpleNamespace(**vars(blob), blob=blob) for name, blob in target_bucket.objects.items()
    }
    assert build_sync_plan(source, target) == {
        "copy": ["sheets/b.pdf"],
        "delete": ["albums/extra.jpg"],
        "unchanged": ["sheets/a.pdf"],
    }


def test_execute_copies_changed_and_new_objects_then_deletes_extras():
    prod = FakeBucket(
        "prod-bucket",
        {
            "sheets/same.pdf": "same",
            "sheets/changed.pdf": "new",
            "2026-07-22/song/take.mp3": "recording",
        },
    )
    test = FakeBucket(
        "test-bucket",
        {
            "sheets/same.pdf": "same",
            "sheets/changed.pdf": "old",
            "albums/extra.jpg": "extra",
        },
    )
    result = synchronize(config(), execute=True, client=FakeClient(prod, test))

    assert result == {
        "mode": "execute",
        "copied_count": 2,
        "deleted_count": 1,
        "unchanged_count": 1,
        "source_object_count": 3,
        "target_object_count": 3,
    }
    assert set(test.objects) == set(prod.objects)
    assert [event[0] for event in prod.events] == ["copy", "copy"]
    assert [event[0] for event in test.events] == ["delete"]


def test_execute_rejects_missing_generation_before_writes():
    prod = FakeBucket("prod-bucket", {"sheets/a.pdf": "a"})
    prod.objects["sheets/a.pdf"].generation = None
    test = FakeBucket("test-bucket")
    with pytest.raises(RuntimeError, match="generation is unavailable"):
        synchronize(config(), execute=True, client=FakeClient(prod, test))
    assert prod.events == []
    assert test.events == []


def test_execute_rejects_copy_checksum_mismatch_before_delete():
    prod = FakeBucket("prod-bucket", {"sheets/a.pdf": "a"})
    test = FakeBucket("test-bucket", {"albums/extra.jpg": "extra"})
    original_copy = prod.copy_blob

    def corrupt_copy(*args, **kwargs):
        copied = original_copy(*args, **kwargs)
        copied.crc32c = "corrupt"
        return copied

    prod.copy_blob = corrupt_copy
    with pytest.raises(RuntimeError, match="crc32c verification failed"):
        synchronize(config(), execute=True, client=FakeClient(prod, test))
    assert not any(event[0] == "delete" for event in test.events)
