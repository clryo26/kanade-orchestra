#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

try:
    from google.cloud import storage
except ImportError:  # pragma: no cover - dependency availability is environment-specific
    storage = None


MANIFEST_SCHEMA_VERSION = "1.0"
BACKUP_ROOT_PREFIX = "backups/prod-to-test"
POSTGRES_REQUIRED_MAJOR_VERSION = 18
GCS_FIXED_TARGET_PREFIXES = ("sheets/", "albums/")
GCS_EXCLUDED_PREFIXES = ("app-data/", "backups/", "auth/", "audit/", "sync-history/")
GCS_DYNAMIC_RECORDING_POLICY = {
    "prefix_pattern": "<YYYY-MM-DD>/",
    "object_path_pattern": "<YYYY-MM-DD>/<曲名>/<ファイル名>",
    "date_validation": "calendar_date",
}
_OPERATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SAFE_DATABASE_FILENAME_RE = re.compile(r"[^A-Za-z0-9_-]+")


@dataclass(frozen=True)
class ManifestCheckConfig:
    operation_id: str
    project_id: str
    prod_database: str
    test_database: str
    prod_gcs_bucket: str
    test_gcs_bucket: str


@dataclass(frozen=True)
class ManifestCheckDependencies:
    storage_client_factory: Callable[[str], Any]
    run_command: Callable[..., Any]
    temporary_directory_factory: Callable[[], Any]


def _default_storage_client_factory(project_id: str) -> Any:
    if storage is None:
        raise RuntimeError("google-cloud-storage is required")
    return storage.Client(project=project_id)


def default_dependencies() -> ManifestCheckDependencies:
    return ManifestCheckDependencies(
        storage_client_factory=_default_storage_client_factory,
        run_command=subprocess.run,
        temporary_directory_factory=tempfile.TemporaryDirectory,
    )


def _required(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name} is required")
    return normalized


def _normalize_bucket_name(value: str) -> str:
    return value.removeprefix("gs://").strip().strip("/")


def _database_dump_filename(database_name: str) -> str:
    normalized = _SAFE_DATABASE_FILENAME_RE.sub("_", database_name.strip()).strip("_-")
    if not normalized or normalized in {".", ".."}:
        raise ValueError("DB_NAME_TEST cannot be converted to a safe dump filename")
    return f"{normalized}.dump"


def _manifest_object_path(operation_id: str) -> str:
    return f"{BACKUP_ROOT_PREFIX}/{operation_id}/manifest.json"


def _is_supported_source_object_path(object_path: str) -> bool:
    if object_path.startswith(GCS_EXCLUDED_PREFIXES):
        return False
    if any(
        object_path.startswith(prefix) and len(object_path) > len(prefix)
        for prefix in GCS_FIXED_TARGET_PREFIXES
    ):
        return True
    parts = object_path.split("/")
    if len(parts) != 3 or not parts[1] or not parts[2]:
        return False
    try:
        parsed_date = date.fromisoformat(parts[0])
    except ValueError:
        return False
    return parsed_date.isoformat() == parts[0]


def read_config(argv: list[str] | None = None) -> ManifestCheckConfig:
    parser = argparse.ArgumentParser(
        description="Validate a test pre-sync backup manifest and all referenced backup assets."
    )
    parser.add_argument("--operation-id", default=os.getenv("OPERATION_ID", ""))
    parser.add_argument("--project-id", default=os.getenv("GCP_PROJECT_ID", ""))
    parser.add_argument("--db-name-prod", default=os.getenv("DB_NAME_PROD", ""))
    parser.add_argument("--db-name-test", default=os.getenv("DB_NAME_TEST", ""))
    parser.add_argument("--gcs-bucket-prod", default=os.getenv("GCS_BUCKET_PROD", ""))
    parser.add_argument("--gcs-bucket-test", default=os.getenv("GCS_BUCKET_TEST", ""))
    args = parser.parse_args(argv)

    operation_id = _required(args.operation_id, "OPERATION_ID")
    if not _OPERATION_ID_RE.fullmatch(operation_id):
        raise ValueError("OPERATION_ID contains unsupported characters")
    prod_database = _required(args.db_name_prod, "DB_NAME_PROD")
    test_database = _required(args.db_name_test, "DB_NAME_TEST")
    if prod_database == test_database:
        raise ValueError("DB_NAME_PROD and DB_NAME_TEST must be different")
    prod_bucket = _required(_normalize_bucket_name(args.gcs_bucket_prod), "GCS_BUCKET_PROD")
    test_bucket = _required(_normalize_bucket_name(args.gcs_bucket_test), "GCS_BUCKET_TEST")
    if prod_bucket == test_bucket:
        raise ValueError("GCS_BUCKET_PROD and GCS_BUCKET_TEST must be different")
    _database_dump_filename(test_database)
    return ManifestCheckConfig(
        operation_id=operation_id,
        project_id=_required(args.project_id, "GCP_PROJECT_ID"),
        prod_database=prod_database,
        test_database=test_database,
        prod_gcs_bucket=prod_bucket,
        test_gcs_bucket=test_bucket,
    )


def _required_mapping(value: Any, field_name: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"manifest {field_name} must be an object")
    return value


def _required_list(value: Any, field_name: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"manifest {field_name} must be an array")
    return value


def _required_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"manifest {field_name} must be a non-empty string")
    return value


def _required_nonnegative_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"manifest {field_name} must be a non-negative integer")
    return value


def _required_generation(value: Any, field_name: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"manifest {field_name} must be a positive generation")
    try:
        generation = int(str(value))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"manifest {field_name} must be a positive generation") from exc
    if generation <= 0:
        raise ValueError(f"manifest {field_name} must be a positive generation")
    return generation


def _load_generation_pinned_blob(bucket: Any, object_path: str, generation: int) -> Any:
    blob = bucket.blob(object_path, generation=generation)
    blob.reload(if_generation_match=generation)
    actual_generation = _required_generation(blob.generation, f"{object_path}.generation")
    if actual_generation != generation:
        raise RuntimeError(f"GCS object generation mismatch: {object_path}")
    return blob


def _validate_manifest_identity(
    manifest: Mapping[str, Any], config: ManifestCheckConfig
) -> tuple[Mapping[str, Any], list[Any]]:
    expected_values = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "operation_id": config.operation_id,
        "backup_status": "completed",
        "project_id": config.project_id,
        "test_database": config.test_database,
        "test_gcs_bucket": config.test_gcs_bucket,
    }
    for field_name, expected in expected_values.items():
        if manifest.get(field_name) != expected:
            raise ValueError(f"manifest {field_name} does not match the expected value")
    if manifest.get("test_database") == config.prod_database:
        raise ValueError("manifest test_database must not match DB_NAME_PROD")
    if _normalize_bucket_name(str(manifest.get("test_gcs_bucket", ""))) == config.prod_gcs_bucket:
        raise ValueError("manifest test_gcs_bucket must not match GCS_BUCKET_PROD")

    expected_rules = {
        "fixed_prefixes": list(GCS_FIXED_TARGET_PREFIXES),
        "dynamic_recording_policy": dict(GCS_DYNAMIC_RECORDING_POLICY),
        "excluded_prefixes": list(GCS_EXCLUDED_PREFIXES),
    }
    if manifest.get("gcs_target_rules") != expected_rules:
        raise ValueError("manifest gcs_target_rules does not match the supported policy")
    database = _required_mapping(manifest.get("database"), "database")
    gcs_backup = _required_mapping(manifest.get("gcs_backup"), "gcs_backup")
    objects = _required_list(gcs_backup.get("objects"), "gcs_backup.objects")
    return database, objects


def _validate_database_backup(
    bucket: Any,
    config: ManifestCheckConfig,
    database: Mapping[str, Any],
    dependencies: ManifestCheckDependencies,
) -> None:
    expected_path = (
        f"{BACKUP_ROOT_PREFIX}/{config.operation_id}/database/"
        f"{_database_dump_filename(config.test_database)}"
    )
    object_path = _required_string(database.get("object_path"), "database.object_path")
    if object_path != expected_path:
        raise ValueError("manifest database.object_path does not match the expected backup path")
    generation = _required_generation(database.get("generation"), "database.generation")
    expected_size = _required_nonnegative_int(database.get("size_bytes"), "database.size_bytes")
    expected_sha256 = _required_string(database.get("sha256"), "database.sha256")
    if not _SHA256_RE.fullmatch(expected_sha256):
        raise ValueError("manifest database.sha256 must be a lowercase SHA-256 digest")
    expected_validation = {
        "pg_restore_list": "passed",
        "gcs_size": "passed",
        "gcs_sha256_metadata": "passed",
    }
    if database.get("validation") != expected_validation:
        raise ValueError("manifest database.validation is incomplete")

    blob = _load_generation_pinned_blob(bucket, object_path, generation)
    actual_size = _required_nonnegative_int(blob.size, f"{object_path}.size")
    if actual_size != expected_size:
        raise RuntimeError("database dump size does not match manifest")
    if (getattr(blob, "metadata", None) or {}).get("sha256") != expected_sha256:
        raise RuntimeError("database dump SHA-256 metadata does not match manifest")

    with dependencies.temporary_directory_factory() as temporary_directory:
        dump_path = Path(temporary_directory) / _database_dump_filename(config.test_database)
        blob.download_to_filename(str(dump_path), if_generation_match=generation)
        if dump_path.stat().st_size != expected_size:
            raise RuntimeError("downloaded database dump size does not match manifest")
        if hashlib.sha256(dump_path.read_bytes()).hexdigest() != expected_sha256:
            raise RuntimeError("downloaded database dump SHA-256 does not match manifest")
        version_result = dependencies.run_command(
            ["pg_restore", "--version"], check=True, capture_output=True, text=True, shell=False
        )
        version_match = re.search(r"\b(\d+)(?:\.\d+)?\b", str(version_result.stdout))
        if not version_match or int(version_match.group(1)) != POSTGRES_REQUIRED_MAJOR_VERSION:
            raise RuntimeError(f"pg_restore major version must be {POSTGRES_REQUIRED_MAJOR_VERSION}")
        dependencies.run_command(
            ["pg_restore", "--list", str(dump_path)],
            check=True,
            capture_output=True,
            text=True,
            shell=False,
        )


def _validate_gcs_backups(
    bucket: Any,
    config: ManifestCheckConfig,
    manifest: Mapping[str, Any],
    objects: list[Any],
) -> None:
    gcs_backup = _required_mapping(manifest.get("gcs_backup"), "gcs_backup")
    expected_count = _required_nonnegative_int(
        gcs_backup.get("object_count"), "gcs_backup.object_count"
    )
    expected_total = _required_nonnegative_int(
        gcs_backup.get("total_size_bytes"), "gcs_backup.total_size_bytes"
    )
    if expected_count != len(objects):
        raise ValueError("manifest GCS object count does not match objects array")

    backup_prefix = f"{BACKUP_ROOT_PREFIX}/{config.operation_id}/gcs/"
    source_paths: set[str] = set()
    backup_paths: set[str] = set()
    actual_total = 0
    for index, raw_item in enumerate(objects):
        item = _required_mapping(raw_item, f"gcs_backup.objects[{index}]")
        source_path = _required_string(
            item.get("source_object_path"), f"gcs_backup.objects[{index}].source_object_path"
        )
        backup_path = _required_string(
            item.get("backup_object_path"), f"gcs_backup.objects[{index}].backup_object_path"
        )
        if source_path.startswith("/") or "//" in source_path or any(
            part in {"", ".", ".."} for part in source_path.split("/")
        ):
            raise ValueError("manifest contains an unsafe source object path")
        if not _is_supported_source_object_path(source_path):
            raise ValueError("manifest contains an unsupported source object path")
        if backup_path != f"{backup_prefix}{source_path}":
            raise ValueError("manifest backup object path does not match source object path")
        if source_path in source_paths or backup_path in backup_paths:
            raise ValueError("manifest contains duplicate GCS object paths")
        source_paths.add(source_path)
        backup_paths.add(backup_path)

        generation = _required_generation(
            item.get("backup_generation"), f"gcs_backup.objects[{index}].backup_generation"
        )
        _required_generation(
            item.get("source_generation"), f"gcs_backup.objects[{index}].source_generation"
        )
        expected_size = _required_nonnegative_int(
            item.get("size_bytes"), f"gcs_backup.objects[{index}].size_bytes"
        )
        blob = _load_generation_pinned_blob(bucket, backup_path, generation)
        actual_size = _required_nonnegative_int(blob.size, f"{backup_path}.size")
        if actual_size != expected_size:
            raise RuntimeError(f"GCS backup size does not match manifest: {backup_path}")
        for attribute in ("crc32c", "md5_hash"):
            actual_checksum = getattr(blob, attribute, None)
            if actual_checksum is not None and attribute not in item:
                raise RuntimeError(
                    f"GCS backup {attribute} is missing from manifest: {backup_path}"
                )
            if attribute in item and actual_checksum != item[attribute]:
                raise RuntimeError(
                    f"GCS backup {attribute} does not match manifest: {backup_path}"
                )
        actual_total += actual_size
    if actual_total != expected_total:
        raise ValueError("manifest GCS total size does not match objects array")


def validate_backup_manifest(
    config: ManifestCheckConfig,
    dependencies: ManifestCheckDependencies | None = None,
) -> None:
    deps = dependencies or default_dependencies()
    client = deps.storage_client_factory(config.project_id)
    bucket = client.bucket(config.test_gcs_bucket)
    manifest_path = _manifest_object_path(config.operation_id)

    # Pin the manifest generation before reading it so validation cannot mix versions.
    manifest_reference = bucket.blob(manifest_path)
    manifest_reference.reload()
    manifest_generation = _required_generation(
        manifest_reference.generation, "manifest.generation"
    )
    manifest_blob = _load_generation_pinned_blob(bucket, manifest_path, manifest_generation)
    raw_manifest = manifest_blob.download_as_bytes(if_generation_match=manifest_generation)
    try:
        manifest = json.loads(raw_manifest)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("manifest is not valid UTF-8 JSON") from exc
    manifest_mapping = _required_mapping(manifest, "root")
    database, objects = _validate_manifest_identity(manifest_mapping, config)
    _validate_database_backup(bucket, config, database, deps)
    _validate_gcs_backups(bucket, config, manifest_mapping, objects)


def main(argv: list[str] | None = None) -> int:
    try:
        config = read_config(argv)
        validate_backup_manifest(config)
    except Exception as exc:
        print(f"[FAIL] backup manifest validation failed: {exc}", file=sys.stderr)
        return 1
    print("[PASS] backup manifest and referenced assets are valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
