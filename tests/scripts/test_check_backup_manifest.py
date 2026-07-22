from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts.check_backup_manifest import (
    ManifestCheckConfig,
    ManifestCheckDependencies,
    read_config,
    validate_backup_manifest,
)


DUMP = b"valid-custom-format-dump"
SHA256 = hashlib.sha256(DUMP).hexdigest()
MANIFEST_PATH = "backups/prod-to-test/sync-001/manifest.json"
DATABASE_PATH = "backups/prod-to-test/sync-001/database/kanade_portal_test.dump"
GCS_PATH = "backups/prod-to-test/sync-001/gcs/sheets/score.pdf"


def _manifest(**overrides):
    value = {
        "schema_version": "1.0",
        "operation_id": "sync-001",
        "backup_status": "completed",
        "project_id": "kanade-orchestra",
        "test_database": "kanade_portal_test",
        "test_gcs_bucket": "kanade-orchestra-test-data",
        "database": {
            "object_path": DATABASE_PATH,
            "generation": 102,
            "size_bytes": len(DUMP),
            "sha256": SHA256,
            "validation": {
                "pg_restore_list": "passed",
                "gcs_size": "passed",
                "gcs_sha256_metadata": "passed",
            },
        },
        "gcs_target_rules": {
            "fixed_prefixes": ["sheets/", "albums/"],
            "dynamic_recording_policy": {
                "prefix_pattern": "<YYYY-MM-DD>/",
                "object_path_pattern": "<YYYY-MM-DD>/<曲名>/<ファイル名>",
                "date_validation": "calendar_date",
            },
            "excluded_prefixes": [
                "app-data/",
                "backups/",
                "auth/",
                "audit/",
                "sync-history/",
            ],
        },
        "gcs_backup": {
            "object_count": 1,
            "total_size_bytes": 5,
            "objects": [
                {
                    "source_object_path": "sheets/score.pdf",
                    "backup_object_path": GCS_PATH,
                    "source_generation": 91,
                    "backup_generation": 103,
                    "size_bytes": 5,
                    "crc32c": "crc-value",
                    "md5_hash": "md5-value",
                }
            ],
        },
    }
    value.update(overrides)
    return value


class FakeBlob:
    def __init__(self, bucket, name, generation=None):
        self.bucket = bucket
        self.name = name
        record = bucket.records[name]
        self.generation = generation if generation is not None else record["generation"]
        self.size = record["size"]
        self.metadata = record.get("metadata")
        self.crc32c = record.get("crc32c")
        self.md5_hash = record.get("md5_hash")

    def reload(self, **kwargs):
        self.bucket.calls.append(("reload", self.name, kwargs))
        expected = kwargs.get("if_generation_match")
        if expected is not None and expected != self.bucket.records[self.name]["generation"]:
            raise RuntimeError("generation precondition failed")

    def download_as_bytes(self, **kwargs):
        self.bucket.calls.append(("download_as_bytes", self.name, kwargs))
        return self.bucket.records[self.name]["data"]

    def download_to_filename(self, filename, **kwargs):
        self.bucket.calls.append(("download_to_filename", self.name, kwargs))
        Path(filename).write_bytes(self.bucket.records[self.name]["data"])


class FakeBucket:
    def __init__(self, manifest):
        manifest_bytes = json.dumps(manifest).encode()
        self.records = {
            MANIFEST_PATH: {
                "generation": 101,
                "size": len(manifest_bytes),
                "data": manifest_bytes,
            },
            DATABASE_PATH: {
                "generation": 102,
                "size": len(DUMP),
                "data": DUMP,
                "metadata": {"sha256": SHA256},
            },
            GCS_PATH: {
                "generation": 103,
                "size": 5,
                "data": b"score",
                "crc32c": "crc-value",
                "md5_hash": "md5-value",
            },
        }
        self.calls = []

    def blob(self, name, generation=None):
        self.calls.append(("blob", name, {"generation": generation}))
        return FakeBlob(self, name, generation)


def _config():
    return ManifestCheckConfig(
        operation_id="sync-001",
        project_id="kanade-orchestra",
        prod_database="kanade_portal",
        test_database="kanade_portal_test",
        prod_gcs_bucket="kanade-orchestra-prod-data",
        test_gcs_bucket="kanade-orchestra-test-data",
    )


def _dependencies(bucket, *, postgres_major=18):
    calls = []

    def run_command(command, **kwargs):
        calls.append((list(command), kwargs))
        if command[1:] == ["--version"]:
            return SimpleNamespace(stdout=f"pg_restore (PostgreSQL) {postgres_major}.1")
        return SimpleNamespace(stdout="archive contents")

    dependencies = ManifestCheckDependencies(
        storage_client_factory=lambda project_id: SimpleNamespace(
            bucket=lambda bucket_name: bucket
        ),
        run_command=run_command,
        temporary_directory_factory=tempfile.TemporaryDirectory,
    )
    return dependencies, calls


def test_validates_manifest_and_all_assets_with_generation_pinning():
    bucket = FakeBucket(_manifest())
    dependencies, command_calls = _dependencies(bucket)

    validate_backup_manifest(_config(), dependencies)

    pinned_downloads = [call for call in bucket.calls if call[0].startswith("download")]
    assert pinned_downloads[0][2]["if_generation_match"] == 101
    assert pinned_downloads[1][2]["if_generation_match"] == 102
    assert command_calls[0][0] == ["pg_restore", "--version"]
    assert command_calls[1][0][0:2] == ["pg_restore", "--list"]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema_version", "2.0"),
        ("operation_id", "other"),
        ("backup_status", "incomplete"),
        ("project_id", "other-project"),
        ("test_database", "kanade_portal"),
        ("test_gcs_bucket", "kanade-orchestra-prod-data"),
    ],
)
def test_rejects_manifest_identity_or_environment_mismatch(field, value):
    bucket = FakeBucket(_manifest(**{field: value}))
    dependencies, _ = _dependencies(bucket)

    with pytest.raises(ValueError, match=f"manifest {field}"):
        validate_backup_manifest(_config(), dependencies)


def test_rejects_database_sha256_content_mismatch():
    bucket = FakeBucket(_manifest())
    bucket.records[DATABASE_PATH]["data"] = b"x" * len(DUMP)
    dependencies, _ = _dependencies(bucket)

    with pytest.raises(RuntimeError, match="downloaded database dump SHA-256"):
        validate_backup_manifest(_config(), dependencies)


def test_rejects_gcs_checksum_mismatch():
    bucket = FakeBucket(_manifest())
    bucket.records[GCS_PATH]["crc32c"] = "changed"
    dependencies, _ = _dependencies(bucket)

    with pytest.raises(RuntimeError, match="crc32c"):
        validate_backup_manifest(_config(), dependencies)


def test_rejects_checksum_present_on_blob_but_missing_from_manifest():
    manifest = _manifest()
    del manifest["gcs_backup"]["objects"][0]["crc32c"]
    bucket = FakeBucket(manifest)
    dependencies, _ = _dependencies(bucket)

    with pytest.raises(RuntimeError, match="crc32c is missing"):
        validate_backup_manifest(_config(), dependencies)


def test_rejects_source_path_outside_supported_backup_policy():
    manifest = _manifest()
    item = manifest["gcs_backup"]["objects"][0]
    item["source_object_path"] = "app-data/private.json"
    item["backup_object_path"] = (
        "backups/prod-to-test/sync-001/gcs/app-data/private.json"
    )
    bucket = FakeBucket(manifest)
    dependencies, _ = _dependencies(bucket)

    with pytest.raises(ValueError, match="unsupported source object path"):
        validate_backup_manifest(_config(), dependencies)


def test_rejects_duplicate_gcs_paths():
    manifest = _manifest()
    manifest["gcs_backup"]["objects"].append(dict(manifest["gcs_backup"]["objects"][0]))
    manifest["gcs_backup"]["object_count"] = 2
    manifest["gcs_backup"]["total_size_bytes"] = 10
    bucket = FakeBucket(manifest)
    dependencies, _ = _dependencies(bucket)

    with pytest.raises(ValueError, match="duplicate"):
        validate_backup_manifest(_config(), dependencies)


def test_rejects_wrong_postgres_major_version():
    bucket = FakeBucket(_manifest())
    dependencies, _ = _dependencies(bucket, postgres_major=17)

    with pytest.raises(RuntimeError, match="must be 18"):
        validate_backup_manifest(_config(), dependencies)


def test_read_config_rejects_prod_test_collisions():
    with pytest.raises(ValueError, match="DB_NAME_PROD and DB_NAME_TEST"):
        read_config(
            [
                "--operation-id", "sync-001",
                "--project-id", "project",
                "--db-name-prod", "same",
                "--db-name-test", "same",
                "--gcs-bucket-prod", "prod",
                "--gcs-bucket-test", "test",
            ]
        )

    with pytest.raises(ValueError, match="GCS_BUCKET_PROD and GCS_BUCKET_TEST"):
        read_config(
            [
                "--operation-id", "sync-001",
                "--project-id", "project",
                "--db-name-prod", "prod",
                "--db-name-test", "test",
                "--gcs-bucket-prod", "same",
                "--gcs-bucket-test", "gs://same/",
            ]
        )
