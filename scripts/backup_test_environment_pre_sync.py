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
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

try:
    from google.cloud import storage
except ImportError:  # pragma: no cover - dependency availability is environment-specific
    storage = None


GCS_FIXED_TARGET_PREFIXES = ("sheets/", "albums/")
GCS_EXCLUDED_PREFIXES = ("app-data/", "backups/", "auth/", "audit/", "sync-history/")
GCS_DYNAMIC_RECORDING_POLICY = {
    "prefix_pattern": "<YYYY-MM-DD>/",
    "object_path_pattern": "<YYYY-MM-DD>/<曲名>/<ファイル名>",
    "date_validation": "calendar_date",
}
BACKUP_ROOT_PREFIX = "backups/prod-to-test"
MANIFEST_SCHEMA_VERSION = "1.0"
POSTGRES_REQUIRED_MAJOR_VERSION = 18

# preflight と同じ許可文字規則を使用し、GCSオブジェクト名へのパス注入も防ぐ。
_OPERATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")
_SAFE_DATABASE_FILENAME_RE = re.compile(r"[^A-Za-z0-9_-]+")


@dataclass(frozen=True)
class BackupConfig:
    operation_id: str
    target_git_sha: str
    project_id: str
    test_db_direct_url: str
    db_name_test: str
    gcs_bucket_test: str


@dataclass(frozen=True)
class BackupDependencies:
    run_command: Callable[..., Any]
    storage_client_factory: Callable[[str], Any]
    now: Callable[[], datetime]
    temporary_directory_factory: Callable[[], Any]


@dataclass(frozen=True)
class BackupResult:
    mode: str
    backup_uri: str
    backup_status: str
    database_object_path: str
    gcs_object_count: int
    gcs_total_size_bytes: int
    manifest_object_path: str


def _default_storage_client_factory(project_id: str) -> Any:
    if storage is None:
        raise RuntimeError("google-cloud-storage is required for --execute")
    return storage.Client(project=project_id)


def default_dependencies() -> BackupDependencies:
    return BackupDependencies(
        run_command=subprocess.run,
        storage_client_factory=_default_storage_client_factory,
        now=lambda: datetime.now(timezone.utc),
        temporary_directory_factory=tempfile.TemporaryDirectory,
    )


def _normalize_bucket_name(value: str) -> str:
    return value.removeprefix("gs://").strip().strip("/")


def normalize_database_dump_filename(database_name: str) -> str:
    normalized = _SAFE_DATABASE_FILENAME_RE.sub("_", database_name.strip()).strip("_-")
    if not normalized or normalized in {".", ".."}:
        raise ValueError("DB_NAME_TEST cannot be converted to a safe dump filename")
    return f"{normalized}.dump"


def _backup_prefix(operation_id: str) -> str:
    return f"{BACKUP_ROOT_PREFIX}/{operation_id}/"


def _backup_uri(bucket_name: str, operation_id: str) -> str:
    return f"gs://{bucket_name}/{_backup_prefix(operation_id)}"


def _iso_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _is_valid_recording_object(object_name: str) -> bool:
    parts = object_name.split("/")
    if len(parts) != 3 or not parts[1] or not parts[2]:
        return False
    return _is_valid_date_prefix(f"{parts[0]}/")


def _is_valid_date_prefix(prefix: str) -> bool:
    value = prefix.removesuffix("/")
    if not prefix.endswith("/") or len(value) != 10 or "/" in value:
        return False
    try:
        parsed_date = date.fromisoformat(value)
    except ValueError:
        return False
    return parsed_date.isoformat() == value


def is_gcs_backup_target(object_name: str) -> bool:
    normalized = object_name.lstrip("/")
    if not normalized or normalized != object_name:
        return False
    if normalized.startswith(GCS_EXCLUDED_PREFIXES):
        return False
    if normalized.startswith(("recordings/", "promotion/")):
        return False
    if any(
        normalized.startswith(prefix) and len(normalized) > len(prefix)
        for prefix in GCS_FIXED_TARGET_PREFIXES
    ):
        return True
    return _is_valid_recording_object(normalized)


def _list_gcs_backup_objects(client: Any, bucket_name: str) -> list[Any]:
    selected: dict[str, Any] = {}
    for prefix in GCS_FIXED_TARGET_PREFIXES:
        for blob in client.list_blobs(bucket_name, prefix=prefix):
            if is_gcs_backup_target(blob.name):
                selected[blob.name] = blob

    # delimiterでバケット直下のprefixだけを発見し、有効日付prefixの中身だけを列挙する。
    root_listing = client.list_blobs(bucket_name, delimiter="/")
    for page in root_listing.pages:
        for prefix in page.prefixes:
            if not _is_valid_date_prefix(prefix):
                continue
            for blob in client.list_blobs(bucket_name, prefix=prefix):
                if is_gcs_backup_target(blob.name):
                    selected[blob.name] = blob
    return [selected[name] for name in sorted(selected)]


def validate_config(config: BackupConfig, *, execute: bool) -> BackupConfig:
    errors: list[str] = []
    if not config.operation_id:
        errors.append("OPERATION_ID is required")
    elif not _OPERATION_ID_RE.fullmatch(config.operation_id):
        errors.append("OPERATION_ID contains unsupported characters")
    if not config.target_git_sha:
        errors.append("TARGET_GIT_SHA is required")
    if not config.project_id:
        errors.append("GCP_PROJECT_ID is required")
    if not config.db_name_test:
        errors.append("DB_NAME_TEST is required")
    if not _normalize_bucket_name(config.gcs_bucket_test):
        errors.append("GCS_BUCKET_TEST is required")
    if execute and not config.test_db_direct_url:
        errors.append("TEST_DB_DIRECT_URL is required for --execute")
    if config.db_name_test:
        normalize_database_dump_filename(config.db_name_test)
    if errors:
        raise ValueError("; ".join(errors))
    return config


def build_dry_run_plan(config: BackupConfig) -> dict[str, Any]:
    validated = validate_config(config, execute=False)
    bucket_name = _normalize_bucket_name(validated.gcs_bucket_test)
    dump_filename = normalize_database_dump_filename(validated.db_name_test)
    backup_prefix = _backup_prefix(validated.operation_id)
    return {
        "mode": "dry-run",
        "operation_id": validated.operation_id,
        "backup_uri": _backup_uri(bucket_name, validated.operation_id),
        "database": {
            "test_database": validated.db_name_test,
            "object_path": f"{backup_prefix}database/{dump_filename}",
            "planned_commands": ["pg_dump --format=custom --no-owner --no-acl", "pg_restore --list"],
        },
        "gcs": {
            "fixed_target_prefixes": list(GCS_FIXED_TARGET_PREFIXES),
            "dynamic_recording_policy": dict(GCS_DYNAMIC_RECORDING_POLICY),
            "excluded_prefixes": list(GCS_EXCLUDED_PREFIXES),
            "destination_layout": f"{backup_prefix}gcs/<元のオブジェクトパス>",
        },
        "manifest_object_path": f"{backup_prefix}manifest.json",
        "writes_permitted": False,
    }


def _run_database_backup(
    config: BackupConfig,
    dump_path: Path,
    run_command: Callable[..., Any],
) -> tuple[int, str]:
    for executable in ("pg_dump", "pg_restore"):
        version_result = run_command(
            [executable, "--version"],
            check=True,
            capture_output=True,
            text=True,
            shell=False,
        )
        version_output = str(getattr(version_result, "stdout", "")).strip()
        match = re.search(r"\b(\d+)(?:\.\d+)?\b", version_output)
        if not match or int(match.group(1)) != POSTGRES_REQUIRED_MAJOR_VERSION:
            raise RuntimeError(
                f"{executable} major version must be {POSTGRES_REQUIRED_MAJOR_VERSION}"
            )

    parsed_database_url = urlsplit(config.test_db_direct_url)
    if (
        parsed_database_url.scheme not in {"postgres", "postgresql"}
        or not parsed_database_url.hostname
    ):
        raise ValueError("TEST_DB_DIRECT_URL must be a PostgreSQL URL with a host")

    database_name = unquote(parsed_database_url.path.lstrip("/"))
    if not database_name:
        raise ValueError("TEST_DB_DIRECT_URL must include a database name")

    pg_dump_env = os.environ.copy()
    for variable_name in (
        "PGHOST",
        "PGPORT",
        "PGUSER",
        "PGPASSWORD",
        "PGDATABASE",
        "PGSSLMODE",
        "PGCHANNELBINDING",
        "PGCONNECT_TIMEOUT",
    ):
        pg_dump_env.pop(variable_name, None)

    pg_dump_env["PGHOST"] = parsed_database_url.hostname
    pg_dump_env["PGPORT"] = str(parsed_database_url.port or 5432)
    pg_dump_env["PGDATABASE"] = database_name
    if parsed_database_url.username is not None:
        pg_dump_env["PGUSER"] = unquote(parsed_database_url.username)
    if parsed_database_url.password is not None:
        pg_dump_env["PGPASSWORD"] = unquote(parsed_database_url.password)

    query_parameters = parse_qs(parsed_database_url.query)
    for query_name, variable_name in {
        "sslmode": "PGSSLMODE",
        "channel_binding": "PGCHANNELBINDING",
        "connect_timeout": "PGCONNECT_TIMEOUT",
    }.items():
        values = query_parameters.get(query_name)
        if values:
            pg_dump_env[variable_name] = values[-1]

    pg_dump_command = [
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--file",
        str(dump_path),
    ]
    run_command(
        pg_dump_command,
        check=True,
        env=pg_dump_env,
        capture_output=True,
        text=True,
        shell=False,
    )
    run_command(
        ["pg_restore", "--list", str(dump_path)],
        check=True,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        shell=False,
    )
    if not dump_path.is_file():
        raise RuntimeError("pg_dump completed without creating the dump file")
    digest = hashlib.sha256(dump_path.read_bytes()).hexdigest()
    return dump_path.stat().st_size, digest


def _required_blob_generation(blob: Any, object_name: str) -> Any:
    generation = getattr(blob, "generation", None)
    if generation is None or str(generation).strip() == "":
        raise RuntimeError(f"GCS object generation is unavailable: {object_name}")
    return generation


def _required_blob_size(blob: Any, object_name: str) -> int:
    size = getattr(blob, "size", None)
    if size is None:
        raise RuntimeError(f"GCS object size is unavailable: {object_name}")
    return int(size)


def _source_blob_snapshot(blob: Any) -> dict[str, Any]:
    return {
        "blob": blob,
        "object_path": blob.name,
        "generation": _required_blob_generation(blob, blob.name),
        "size_bytes": _required_blob_size(blob, blob.name),
        "crc32c": getattr(blob, "crc32c", None),
        "md5_hash": getattr(blob, "md5_hash", None),
    }


def _verify_database_upload(
    blob: Any,
    *,
    expected_size: int,
    expected_sha256: str,
) -> Any:
    blob.reload()
    generation = _required_blob_generation(blob, blob.name)
    uploaded_size = _required_blob_size(blob, blob.name)
    if uploaded_size != expected_size:
        raise RuntimeError("uploaded database dump size verification failed")
    uploaded_sha256 = (getattr(blob, "metadata", None) or {}).get("sha256")
    if uploaded_sha256 != expected_sha256:
        raise RuntimeError("uploaded database dump SHA-256 metadata verification failed")
    return generation


def _copy_and_verify_gcs_object(
    *,
    bucket: Any,
    source: dict[str, Any],
    destination_object_path: str,
) -> dict[str, Any]:
    source_blob = source["blob"]
    source_generation = source["generation"]
    backup_blob = bucket.copy_blob(
        source_blob,
        bucket,
        new_name=destination_object_path,
        source_generation=source_generation,
        if_source_generation_match=source_generation,
        if_generation_match=0,
    )
    backup_blob.reload()
    backup_generation = _required_blob_generation(backup_blob, destination_object_path)
    backup_size = _required_blob_size(backup_blob, destination_object_path)
    if backup_size != source["size_bytes"]:
        raise RuntimeError(f"copied GCS object size verification failed: {source['object_path']}")

    result = {
        "source_object_path": source["object_path"],
        "backup_object_path": destination_object_path,
        "source_generation": source_generation,
        "backup_generation": backup_generation,
        "size_bytes": backup_size,
    }
    for attribute in ("crc32c", "md5_hash"):
        source_value = source[attribute]
        backup_value = getattr(backup_blob, attribute, None)
        if source_value is None:
            continue
        if backup_value != source_value:
            raise RuntimeError(
                f"copied GCS object {attribute} verification failed: {source['object_path']}"
            )
        result[attribute] = source_value
    return result


def _manifest_payload(
    *,
    config: BackupConfig,
    created_at: str,
    completed_at: str,
    database_object_path: str,
    database_generation: Any,
    database_size: int,
    database_sha256: str,
    copied_objects: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "operation_id": config.operation_id,
        "target_git_sha": config.target_git_sha,
        "created_at": created_at,
        "completed_at": completed_at,
        "project_id": config.project_id,
        "test_database": config.db_name_test,
        "test_gcs_bucket": _normalize_bucket_name(config.gcs_bucket_test),
        "database": {
            "object_path": database_object_path,
            "generation": database_generation,
            "size_bytes": database_size,
            "sha256": database_sha256,
            "validation": {
                "pg_restore_list": "passed",
                "gcs_size": "passed",
                "gcs_sha256_metadata": "passed",
            },
        },
        "gcs_target_rules": {
            "fixed_prefixes": list(GCS_FIXED_TARGET_PREFIXES),
            "dynamic_recording_policy": dict(GCS_DYNAMIC_RECORDING_POLICY),
            "excluded_prefixes": list(GCS_EXCLUDED_PREFIXES),
        },
        "gcs_backup": {
            "object_count": len(copied_objects),
            "total_size_bytes": sum(item["size_bytes"] for item in copied_objects),
            "objects": copied_objects,
        },
        "backup_status": "completed",
    }


def _verify_manifest(
    manifest: dict[str, Any],
    *,
    operation_id: str,
    database_sha256: str,
    database_generation: Any,
    database_size: int,
    copied_objects: list[dict[str, Any]],
) -> None:
    expected_total_size = sum(item["size_bytes"] for item in copied_objects)
    expected = {
        "operation_id": operation_id,
        "backup_status": "completed",
        "database_sha256": database_sha256,
        "database_generation": database_generation,
        "database_size": database_size,
        "gcs_object_count": len(copied_objects),
        "gcs_total_size": expected_total_size,
        "gcs_generations": [item["backup_generation"] for item in copied_objects],
    }
    manifest_gcs = manifest.get("gcs_backup") or {}
    manifest_objects = manifest_gcs.get("objects") or []
    actual = {
        "operation_id": manifest.get("operation_id"),
        "backup_status": manifest.get("backup_status"),
        "database_sha256": (manifest.get("database") or {}).get("sha256"),
        "database_generation": (manifest.get("database") or {}).get("generation"),
        "database_size": (manifest.get("database") or {}).get("size_bytes"),
        "gcs_object_count": manifest_gcs.get("object_count"),
        "gcs_total_size": manifest_gcs.get("total_size_bytes"),
        "gcs_generations": [item.get("backup_generation") for item in manifest_objects],
    }
    if any(value is None or str(value).strip() == "" for value in actual["gcs_generations"]):
        raise RuntimeError("uploaded manifest contains an empty GCS backup generation")
    if actual != expected:
        raise RuntimeError("uploaded manifest verification failed")


def execute_backup(
    config: BackupConfig,
    dependencies: BackupDependencies | None = None,
) -> BackupResult:
    validated = validate_config(config, execute=True)
    deps = dependencies or default_dependencies()
    bucket_name = _normalize_bucket_name(validated.gcs_bucket_test)
    backup_prefix = _backup_prefix(validated.operation_id)
    client = deps.storage_client_factory(validated.project_id)
    bucket = client.bucket(bucket_name)

    # operation_id単位の上書きを禁止し、競合時は各書き込みの世代条件でも拒否する。
    if next(iter(client.list_blobs(bucket_name, prefix=backup_prefix, max_results=1)), None):
        raise FileExistsError(f"backup destination already exists: {backup_prefix}")

    source_objects = _list_gcs_backup_objects(client, bucket_name)
    # DB/GCSへの書き込み前に全コピー元の世代を固定し、不完全な列挙結果を拒否する。
    source_snapshots = [_source_blob_snapshot(blob) for blob in source_objects]
    created_at = _iso_timestamp(deps.now())
    dump_filename = normalize_database_dump_filename(validated.db_name_test)
    database_object_path = f"{backup_prefix}database/{dump_filename}"
    manifest_object_path = f"{backup_prefix}manifest.json"

    with deps.temporary_directory_factory() as temporary_directory:
        dump_path = Path(temporary_directory) / dump_filename
        database_size, database_sha256 = _run_database_backup(
            validated,
            dump_path,
            deps.run_command,
        )
        database_blob = bucket.blob(database_object_path)
        database_blob.metadata = {"sha256": database_sha256}
        database_blob.upload_from_filename(
            str(dump_path),
            content_type="application/octet-stream",
            if_generation_match=0,
        )
        database_generation = _verify_database_upload(
            database_blob,
            expected_size=database_size,
            expected_sha256=database_sha256,
        )

        copied_objects: list[dict[str, Any]] = []
        for source in source_snapshots:
            destination_object_path = f"{backup_prefix}gcs/{source['object_path']}"
            copied_objects.append(
                _copy_and_verify_gcs_object(
                    bucket=bucket,
                    source=source,
                    destination_object_path=destination_object_path,
                )
            )

    completed_at = _iso_timestamp(deps.now())
    manifest = _manifest_payload(
        config=validated,
        created_at=created_at,
        completed_at=completed_at,
        database_object_path=database_object_path,
        database_generation=database_generation,
        database_size=database_size,
        database_sha256=database_sha256,
        copied_objects=copied_objects,
    )

    # manifestは全バックアップ完了後の最後の書き込みとし、再読込検証を成功条件にする。
    manifest_blob = bucket.blob(manifest_object_path)
    manifest_blob.upload_from_string(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        content_type="application/json",
        if_generation_match=0,
    )
    uploaded_manifest = json.loads(manifest_blob.download_as_text(encoding="utf-8"))
    _verify_manifest(
        uploaded_manifest,
        operation_id=validated.operation_id,
        database_sha256=database_sha256,
        database_generation=database_generation,
        database_size=database_size,
        copied_objects=copied_objects,
    )
    return BackupResult(
        mode="execute",
        backup_uri=_backup_uri(bucket_name, validated.operation_id),
        backup_status="completed",
        database_object_path=database_object_path,
        gcs_object_count=len(copied_objects),
        gcs_total_size_bytes=sum(item["size_bytes"] for item in copied_objects),
        manifest_object_path=manifest_object_path,
    )


def run_backup(
    config: BackupConfig,
    *,
    execute: bool = False,
    dependencies: BackupDependencies | None = None,
) -> dict[str, Any]:
    if not execute:
        return build_dry_run_plan(config)
    return asdict(execute_backup(config, dependencies))


def _read_config_from_args(argv: list[str] | None = None) -> tuple[BackupConfig, bool]:
    parser = argparse.ArgumentParser(
        description="Back up the test database and selected test GCS assets before prod-to-test sync."
    )
    parser.add_argument("--execute", action="store_true", help="Perform writes; default is dry-run.")
    parser.add_argument("--operation-id", default=os.getenv("OPERATION_ID", ""))
    parser.add_argument("--target-git-sha", default=os.getenv("TARGET_GIT_SHA", ""))
    parser.add_argument("--project-id", default=os.getenv("GCP_PROJECT_ID", ""))
    parser.add_argument(
        "--test-db-direct-url", default=os.getenv("TEST_DB_DIRECT_URL", "")
    )
    parser.add_argument("--db-name-test", default=os.getenv("DB_NAME_TEST", ""))
    parser.add_argument("--gcs-bucket-test", default=os.getenv("GCS_BUCKET_TEST", ""))
    args = parser.parse_args(argv)
    return (
        BackupConfig(
            operation_id=args.operation_id.strip(),
            target_git_sha=args.target_git_sha.strip(),
            project_id=args.project_id.strip(),
            test_db_direct_url=args.test_db_direct_url.strip(),
            db_name_test=args.db_name_test.strip(),
            gcs_bucket_test=args.gcs_bucket_test.strip(),
        ),
        bool(args.execute),
    )


def _redacted_error_message(error: Exception, database_url: str) -> str:
    message = str(error)
    secrets = [database_url]
    if database_url:
        try:
            password = urlsplit(database_url).password
        except ValueError:
            password = None
        if password:
            secrets.append(unquote(password))
    for secret in secrets:
        if secret:
            message = message.replace(secret, "***")
    return message


def main(
    argv: list[str] | None = None,
    *,
    dependencies: BackupDependencies | None = None,
) -> int:
    database_url = os.getenv("TEST_DB_DIRECT_URL", "")
    try:
        config, execute = _read_config_from_args(argv)
        database_url = config.test_db_direct_url
        result = run_backup(config, execute=execute, dependencies=dependencies)
    except Exception as exc:  # CLI boundary: report safely and exit non-zero
        print(
            f"[FAIL] test pre-sync backup failed: {_redacted_error_message(exc, database_url)}",
            file=sys.stderr,
        )
        return 1

    mode = "EXECUTE" if execute else "DRY-RUN"
    print(f"[PASS] test pre-sync backup {mode}")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
