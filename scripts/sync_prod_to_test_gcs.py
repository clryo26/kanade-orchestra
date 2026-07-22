#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from typing import Any

try:
    from google.cloud import storage
except ImportError:  # pragma: no cover - dependency availability is environment-specific
    storage = None

from scripts.backup_test_environment_pre_sync import (
    GCS_EXCLUDED_PREFIXES,
    GCS_FIXED_TARGET_PREFIXES,
    _is_valid_date_prefix,
    is_gcs_backup_target,
)


@dataclass(frozen=True)
class GcsSyncConfig:
    project_id: str
    prod_bucket: str
    test_bucket: str


@dataclass(frozen=True)
class GcsObject:
    name: str
    generation: Any
    size: int
    crc32c: str | None
    md5_hash: str | None
    blob: Any


@dataclass(frozen=True)
class GcsSyncResult:
    mode: str
    copied_count: int
    deleted_count: int
    unchanged_count: int
    source_object_count: int
    target_object_count: int


def _normalize_bucket_name(value: str) -> str:
    return value.removeprefix("gs://").strip().strip("/")


def validate_config(config: GcsSyncConfig) -> GcsSyncConfig:
    project_id = config.project_id.strip()
    prod_bucket = _normalize_bucket_name(config.prod_bucket)
    test_bucket = _normalize_bucket_name(config.test_bucket)
    errors: list[str] = []
    if not project_id:
        errors.append("GCP_PROJECT_ID is required")
    if not prod_bucket:
        errors.append("GCS_BUCKET_PROD is required")
    if not test_bucket:
        errors.append("GCS_BUCKET_TEST is required")
    if prod_bucket and prod_bucket == test_bucket:
        errors.append("GCS_BUCKET_PROD and GCS_BUCKET_TEST must be different")
    if errors:
        raise ValueError("; ".join(errors))
    return GcsSyncConfig(project_id, prod_bucket, test_bucket)


def _required_generation(blob: Any) -> Any:
    generation = getattr(blob, "generation", None)
    if generation is None or str(generation).strip() == "":
        raise RuntimeError(f"GCS object generation is unavailable: {blob.name}")
    return generation


def _required_size(blob: Any) -> int:
    size = getattr(blob, "size", None)
    if size is None:
        raise RuntimeError(f"GCS object size is unavailable: {blob.name}")
    return int(size)


def _snapshot(blob: Any) -> GcsObject:
    return GcsObject(
        name=blob.name,
        generation=_required_generation(blob),
        size=_required_size(blob),
        crc32c=getattr(blob, "crc32c", None),
        md5_hash=getattr(blob, "md5_hash", None),
        blob=blob,
    )


def _list_target_objects(client: Any, bucket_name: str) -> dict[str, GcsObject]:
    selected: dict[str, Any] = {}
    for prefix in GCS_FIXED_TARGET_PREFIXES:
        for blob in client.list_blobs(bucket_name, prefix=prefix):
            if is_gcs_backup_target(blob.name):
                selected[blob.name] = blob

    # 録音はバケット直下の有効な日付prefixだけを対象にする。
    root_listing = client.list_blobs(bucket_name, delimiter="/")
    for page in root_listing.pages:
        for prefix in page.prefixes:
            if not _is_valid_date_prefix(prefix):
                continue
            for blob in client.list_blobs(bucket_name, prefix=prefix):
                if is_gcs_backup_target(blob.name):
                    selected[blob.name] = blob
    return {name: _snapshot(selected[name]) for name in sorted(selected)}


def _same_content(source: GcsObject, target: GcsObject) -> bool:
    if source.size != target.size:
        return False
    if source.crc32c is not None and target.crc32c is not None:
        return source.crc32c == target.crc32c
    if source.md5_hash is not None and target.md5_hash is not None:
        return source.md5_hash == target.md5_hash
    return False


def build_sync_plan(
    source: dict[str, GcsObject], target: dict[str, GcsObject]
) -> dict[str, list[str]]:
    copy_names = sorted(
        name for name, source_object in source.items()
        if name not in target or not _same_content(source_object, target[name])
    )
    delete_names = sorted(set(target) - set(source))
    unchanged_names = sorted(set(source) - set(copy_names))
    return {"copy": copy_names, "delete": delete_names, "unchanged": unchanged_names}


def _verify_copy(copied_blob: Any, source: GcsObject) -> None:
    copied_blob.reload()
    _required_generation(copied_blob)
    if _required_size(copied_blob) != source.size:
        raise RuntimeError(f"copied GCS object size verification failed: {source.name}")
    for attribute in ("crc32c", "md5_hash"):
        expected = getattr(source, attribute)
        actual = getattr(copied_blob, attribute, None)
        if expected is not None and actual != expected:
            raise RuntimeError(
                f"copied GCS object {attribute} verification failed: {source.name}"
            )


def synchronize(config: GcsSyncConfig, *, execute: bool = False, client: Any = None) -> dict[str, Any]:
    validated = validate_config(config)
    if client is None:
        if storage is None:
            raise RuntimeError("google-cloud-storage is required")
        client = storage.Client(project=validated.project_id)

    source = _list_target_objects(client, validated.prod_bucket)
    target = _list_target_objects(client, validated.test_bucket)
    plan = build_sync_plan(source, target)
    if not execute:
        return {
            "mode": "dry-run",
            "source_bucket": validated.prod_bucket,
            "test_bucket": validated.test_bucket,
            "fixed_target_prefixes": list(GCS_FIXED_TARGET_PREFIXES),
            "excluded_prefixes": list(GCS_EXCLUDED_PREFIXES),
            **plan,
            "writes_permitted": False,
        }

    source_bucket = client.bucket(validated.prod_bucket)
    test_bucket = client.bucket(validated.test_bucket)
    for name in plan["copy"]:
        source_object = source[name]
        target_object = target.get(name)
        copied_blob = source_bucket.copy_blob(
            source_object.blob,
            test_bucket,
            new_name=name,
            source_generation=source_object.generation,
            if_source_generation_match=source_object.generation,
            if_generation_match=target_object.generation if target_object else 0,
        )
        _verify_copy(copied_blob, source_object)

    # コピー検証後に、本番側に存在しない同期対象だけを世代指定で削除する。
    for name in plan["delete"]:
        target_object = target[name]
        target_object.blob.delete(if_generation_match=target_object.generation)

    final_target = _list_target_objects(client, validated.test_bucket)
    if set(final_target) != set(source):
        raise RuntimeError("GCS synchronization object-name verification failed")
    for name, source_object in source.items():
        if not _same_content(source_object, final_target[name]):
            raise RuntimeError(f"GCS synchronization content verification failed: {name}")

    return asdict(
        GcsSyncResult(
            mode="execute",
            copied_count=len(plan["copy"]),
            deleted_count=len(plan["delete"]),
            unchanged_count=len(plan["unchanged"]),
            source_object_count=len(source),
            target_object_count=len(final_target),
        )
    )


def _read_args(argv: list[str] | None = None) -> tuple[GcsSyncConfig, bool]:
    parser = argparse.ArgumentParser(
        description="Synchronize approved production GCS assets to the test bucket."
    )
    parser.add_argument("--execute", action="store_true", help="Perform writes; default is dry-run.")
    parser.add_argument("--project-id", default=os.getenv("GCP_PROJECT_ID", ""))
    parser.add_argument("--prod-bucket", default=os.getenv("GCS_BUCKET_PROD", ""))
    parser.add_argument("--test-bucket", default=os.getenv("GCS_BUCKET_TEST", ""))
    args = parser.parse_args(argv)
    return GcsSyncConfig(args.project_id, args.prod_bucket, args.test_bucket), args.execute


def main(argv: list[str] | None = None) -> int:
    try:
        config, execute = _read_args(argv)
        print(json.dumps(synchronize(config, execute=execute), ensure_ascii=False, indent=2))
        return 0
    except (ValueError, RuntimeError) as exc:
        print(f"GCS synchronization failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
