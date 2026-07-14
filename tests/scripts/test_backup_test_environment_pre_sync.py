from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest


def _load_backup_module():
    script_path = Path("scripts/backup_test_environment_pre_sync.py")
    spec = importlib.util.spec_from_file_location(
        "backup_test_environment_pre_sync_for_test",
        script_path,
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class _FakeSourceBlob:
    def __init__(
        self,
        name: str,
        size: int = 1,
        *,
        generation=101,
        crc32c: str | None = "source-crc32c",
        md5_hash: str | None = "source-md5",
    ):
        self.name = name
        self.size = size
        self.generation = generation
        self.crc32c = crc32c
        self.md5_hash = md5_hash


class _FakeWritableBlob:
    def __init__(self, bucket, name: str):
        self.bucket = bucket
        self.name = name
        self.generation = None
        self.size = None
        self.metadata = None
        self.crc32c = None
        self.md5_hash = None

    def upload_from_filename(self, filename: str, **kwargs):
        self.bucket.events.append(("upload_file", self.name, kwargs))
        value = Path(filename).read_bytes()
        self.bucket.objects[self.name] = value
        self.size = len(value)
        self.generation = self.bucket.next_generation()
        self.bucket.object_metadata[self.name] = dict(self.metadata or {})

    def upload_from_string(self, value: str, **kwargs):
        self.bucket.events.append(("upload_string", self.name, kwargs))
        self.bucket.objects[self.name] = value
        self.size = len(value.encode("utf-8"))
        self.generation = self.bucket.next_generation()

    def reload(self):
        self.bucket.events.append(("reload", self.name))
        if "/database/" in self.name:
            self.size = len(self.bucket.objects[self.name]) + self.bucket.database_size_delta
            self.metadata = dict(self.bucket.object_metadata.get(self.name) or {})
            if self.bucket.database_sha_mismatch:
                self.metadata["sha256"] = "mismatched-sha256"

    def download_as_text(self, encoding: str = "utf-8") -> str:
        self.bucket.events.append(("download_text", self.name, encoding))
        value = self.bucket.objects[self.name]
        if self.bucket.tamper_manifest:
            payload = json.loads(value)
            payload["gcs_backup"]["object_count"] += 1
            return json.dumps(payload)
        if self.bucket.tamper_manifest_generation:
            payload = json.loads(value)
            payload["database"]["generation"] += 1
            return json.dumps(payload)
        if self.bucket.tamper_manifest_gcs_generation:
            payload = json.loads(value)
            payload["gcs_backup"]["objects"][0]["backup_generation"] += 1
            return json.dumps(payload)
        if self.bucket.tamper_manifest_empty_gcs_generation:
            payload = json.loads(value)
            payload["gcs_backup"]["objects"][0]["backup_generation"] = ""
            return json.dumps(payload)
        return value.decode(encoding) if isinstance(value, bytes) else value


class _FakeBucket:
    def __init__(
        self,
        *,
        fail_copy: bool = False,
        tamper_manifest: bool = False,
        tamper_manifest_generation: bool = False,
        tamper_manifest_gcs_generation: bool = False,
        tamper_manifest_empty_gcs_generation: bool = False,
        source_generation_conflict: bool = False,
        copy_size_delta: int = 0,
        copy_checksum_mismatch: bool = False,
        database_size_delta: int = 0,
        database_sha_mismatch: bool = False,
    ):
        self.fail_copy = fail_copy
        self.tamper_manifest = tamper_manifest
        self.tamper_manifest_generation = tamper_manifest_generation
        self.tamper_manifest_gcs_generation = tamper_manifest_gcs_generation
        self.tamper_manifest_empty_gcs_generation = tamper_manifest_empty_gcs_generation
        self.source_generation_conflict = source_generation_conflict
        self.copy_size_delta = copy_size_delta
        self.copy_checksum_mismatch = copy_checksum_mismatch
        self.database_size_delta = database_size_delta
        self.database_sha_mismatch = database_sha_mismatch
        self.events: list[tuple] = []
        self.objects: dict[str, bytes | str] = {}
        self.object_metadata: dict[str, dict] = {}
        self.blobs: dict[str, _FakeWritableBlob] = {}
        self._generation = 900

    def next_generation(self):
        self._generation += 1
        return self._generation

    def blob(self, name: str):
        if name not in self.blobs:
            self.blobs[name] = _FakeWritableBlob(self, name)
        return self.blobs[name]

    def copy_blob(self, source_blob, destination_bucket, *, new_name: str, **kwargs):
        self.events.append(("copy", source_blob.name, new_name, kwargs))
        if self.fail_copy:
            raise RuntimeError("copy failed")
        if self.source_generation_conflict:
            raise RuntimeError("source generation precondition failed")
        if kwargs.get("source_generation") != source_blob.generation:
            raise RuntimeError("wrong source generation")
        if kwargs.get("if_source_generation_match") != source_blob.generation:
            raise RuntimeError("wrong source generation precondition")
        self.objects[new_name] = f"copied:{source_blob.name}".encode()
        copied_blob = self.blob(new_name)
        copied_blob.generation = self.next_generation()
        copied_blob.size = source_blob.size + self.copy_size_delta
        copied_blob.crc32c = (
            "mismatched-crc32c" if self.copy_checksum_mismatch else source_blob.crc32c
        )
        copied_blob.md5_hash = source_blob.md5_hash
        return copied_blob


class _FakePrefixPage:
    def __init__(self, prefixes):
        self.prefixes = set(prefixes)


class _FakeRootListing:
    def __init__(self, prefixes):
        self.pages = iter([_FakePrefixPage(prefixes)])


class _FakeStorageClient:
    def __init__(self, source_blobs, bucket: _FakeBucket):
        self.source_blobs = list(source_blobs)
        self.fake_bucket = bucket
        self.list_calls: list[dict] = []

    def bucket(self, name: str):
        return self.fake_bucket

    def list_blobs(self, bucket_name: str, **kwargs):
        self.list_calls.append({"bucket_name": bucket_name, **kwargs})
        if kwargs.get("delimiter") == "/":
            prefixes = {
                f"{blob.name.split('/', 1)[0]}/"
                for blob in self.source_blobs
                if "/" in blob.name
            }
            return _FakeRootListing(prefixes)
        prefix = kwargs.get("prefix")
        if prefix is not None:
            existing = [
                _FakeSourceBlob(name, len(value))
                for name, value in self.fake_bucket.objects.items()
                if name.startswith(prefix)
            ]
            sources = [blob for blob in self.source_blobs if blob.name.startswith(prefix)]
            matches = existing + sources
            max_results = kwargs.get("max_results")
            return iter(matches[:max_results] if max_results is not None else matches)
        return iter(self.source_blobs)


class _FakeRunner:
    def __init__(self, *, failure: Exception | None = None):
        self.failure = failure
        self.calls: list[dict] = []

    def __call__(self, command, **kwargs):
        self.calls.append({"command": list(command), **kwargs})
        if self.failure:
            raise self.failure
        if command[0] == "pg_dump":
            output_path = Path(command[command.index("--file") + 1])
            output_path.write_bytes(b"test-custom-dump")
        return object()


def _config(module, **overrides):
    values = {
        "operation_id": "sync-20260714-001",
        "target_git_sha": "abc123def456",
        "project_id": "kanade-project",
        "db_host": "127.0.0.1",
        "db_port": 5432,
        "db_name_test": "kanade_portal_test",
        "db_user_test": "test_user",
        "db_password": "top-secret-password",
        "gcs_bucket_test": "kanade-test",
    }
    values.update(overrides)
    return module.BackupConfig(**values)


def _dependencies(module, tmp_path, client, runner, times=None):
    timestamps = iter(
        times
        or [
            datetime(2026, 7, 14, 1, 0, tzinfo=timezone.utc),
            datetime(2026, 7, 14, 1, 1, tzinfo=timezone.utc),
        ]
    )
    return module.BackupDependencies(
        run_command=runner,
        storage_client_factory=lambda project_id: client,
        now=lambda: next(timestamps),
        temporary_directory_factory=lambda: tempfile.TemporaryDirectory(dir=tmp_path),
    )


@pytest.mark.parametrize(
    ("object_name", "expected"),
    [
        ("sheets/concert/score.pdf", True),
        ("albums/2026/photo.jpg", True),
        ("2026-02-28/交響曲/recording.mp3", True),
        ("2024-02-29/交響曲/recording.wav", True),
        ("2026-02-30/交響曲/recording.mp3", False),
        ("2026-13-01/交響曲/recording.mp3", False),
        ("2026-07-14/file-only.mp3", False),
        ("2026-07-14/交響曲/subdir/recording.mp3", False),
        ("app-data/members.json", False),
        ("backups/prod-to-test/old/manifest.json", False),
        ("auth/device.json", False),
        ("audit/events.json", False),
        ("sync-history/result.json", False),
        ("recordings/2026-07-14/song/file.mp3", False),
        ("promotion/flyer.pdf", False),
    ],
)
def test_gcs_target_policy_matches_only_confirmed_asset_layout(object_name, expected):
    module = _load_backup_module()

    assert module.is_gcs_backup_target(object_name) is expected


def test_database_dump_filename_is_safely_normalized():
    module = _load_backup_module()

    assert module.normalize_database_dump_filename("kanade_portal_test") == "kanade_portal_test.dump"
    assert module.normalize_database_dump_filename("../test db") == "test_db.dump"


def test_existing_operation_backup_is_rejected_before_subprocess_or_write(tmp_path):
    module = _load_backup_module()
    bucket = _FakeBucket()
    bucket.objects["backups/prod-to-test/sync-20260714-001/partial"] = b"existing"
    client = _FakeStorageClient([], bucket)
    runner = _FakeRunner()

    with pytest.raises(FileExistsError, match="backup destination already exists"):
        module.execute_backup(
            _config(module),
            _dependencies(module, tmp_path, client, runner),
        )

    assert runner.calls == []
    assert bucket.events == []


def test_default_dry_run_does_not_create_client_run_subprocess_or_write(tmp_path):
    module = _load_backup_module()
    called = {"client": False}

    def forbidden_client(project_id):
        called["client"] = True
        raise AssertionError("storage client must not be created in dry-run")

    dependencies = module.BackupDependencies(
        run_command=lambda *args, **kwargs: pytest.fail("subprocess must not run in dry-run"),
        storage_client_factory=forbidden_client,
        now=lambda: pytest.fail("clock is not needed in dry-run"),
        temporary_directory_factory=lambda: pytest.fail("temporary directory is not needed"),
    )

    result = module.run_backup(_config(module), dependencies=dependencies)

    assert result["mode"] == "dry-run"
    assert result["writes_permitted"] is False
    assert result["backup_uri"].endswith("/backups/prod-to-test/sync-20260714-001/")
    assert called["client"] is False


def test_cli_defaults_to_dry_run_and_requires_execute_flag_for_writes(monkeypatch):
    module = _load_backup_module()
    env = {
        "OPERATION_ID": "sync-cli-mode-001",
        "TARGET_GIT_SHA": "abc123",
        "GCP_PROJECT_ID": "kanade-project",
        "DB_HOST": "127.0.0.1",
        "DB_PORT": "5432",
        "DB_NAME_TEST": "kanade_portal_test",
        "DB_USER_TEST": "test_user",
        "DB_PASSWORD": "secret",
        "GCS_BUCKET_TEST": "kanade-test",
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    _, default_execute = module._read_config_from_args([])
    _, explicit_execute = module._read_config_from_args(["--execute"])

    assert default_execute is False
    assert explicit_execute is True


def test_operation_id_uses_preflight_character_policy():
    module = _load_backup_module()

    with pytest.raises(ValueError, match="OPERATION_ID contains unsupported characters"):
        module.run_backup(_config(module, operation_id="sync/invalid"))


def test_execute_runs_safe_dump_validates_and_writes_manifest_last(tmp_path):
    module = _load_backup_module()
    source_blobs = [
        _FakeSourceBlob("sheets/concert/score.pdf", 10),
        _FakeSourceBlob("albums/2026/photo.jpg", 20),
        _FakeSourceBlob("2026-07-14/交響曲/recording.mp3", 30),
        _FakeSourceBlob("2026-02-30/invalid/file.mp3", 40),
        _FakeSourceBlob("backups/prod-to-test/old/manifest.json", 50),
        _FakeSourceBlob("recordings/legacy/file.mp3", 60),
        _FakeSourceBlob("promotion/flyer.pdf", 70),
    ]
    bucket = _FakeBucket()
    client = _FakeStorageClient(source_blobs, bucket)
    runner = _FakeRunner()
    config = _config(module)

    result = module.run_backup(
        config,
        execute=True,
        dependencies=_dependencies(module, tmp_path, client, runner),
    )

    assert result["backup_status"] == "completed"
    assert result["database_object_path"].endswith("database/kanade_portal_test.dump")
    assert result["gcs_object_count"] == 3
    assert result["gcs_total_size_bytes"] == 60

    pg_dump_call, pg_restore_call = runner.calls
    assert pg_dump_call["command"][:4] == [
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-acl",
    ]
    assert pg_dump_call["command"][pg_dump_call["command"].index("--dbname") + 1] == (
        "kanade_portal_test"
    )
    assert pg_dump_call["shell"] is False
    assert config.db_password not in pg_dump_call["command"]
    assert pg_dump_call["env"]["PGPASSWORD"] == config.db_password
    assert pg_restore_call["command"][0:2] == ["pg_restore", "--list"]
    assert pg_restore_call["shell"] is False
    assert config.db_password not in pg_restore_call["command"]

    write_events = [event for event in bucket.events if event[0] in {"upload_file", "copy", "upload_string"}]
    assert write_events[-1][0:2] == (
        "upload_string",
        "backups/prod-to-test/sync-20260714-001/manifest.json",
    )
    assert bucket.events[-1][0] == "download_text"
    copied_sources = [event[1] for event in bucket.events if event[0] == "copy"]
    assert copied_sources == [
        "2026-07-14/交響曲/recording.mp3",
        "albums/2026/photo.jpg",
        "sheets/concert/score.pdf",
    ]
    assert all(
        event[-1].get("if_generation_match") == 0
        for event in write_events
    )
    copy_events = [event for event in bucket.events if event[0] == "copy"]
    assert all(event[3]["source_generation"] == event[3]["if_source_generation_match"] for event in copy_events)
    assert [event[3]["source_generation"] for event in copy_events] == [101, 101, 101]
    copied_destinations = [event[2] for event in copy_events]
    assert all(("reload", destination) in bucket.events for destination in copied_destinations)
    assert not any(
        call.get("prefix") in module.GCS_EXCLUDED_PREFIXES
        for call in client.list_calls
    )
    assert not any(call.get("prefix") in {"recordings/", "promotion/"} for call in client.list_calls)

    manifest = json.loads(bucket.objects[result["manifest_object_path"]])
    assert manifest["operation_id"] == config.operation_id
    assert manifest["backup_status"] == "completed"
    assert manifest["database"]["validation"] == {
        "pg_restore_list": "passed",
        "gcs_size": "passed",
        "gcs_sha256_metadata": "passed",
    }
    assert manifest["database"]["generation"]
    assert manifest["database"]["sha256"]
    assert manifest["gcs_backup"]["object_count"] == 3
    assert manifest["gcs_backup"]["total_size_bytes"] == 60
    assert all(item["source_generation"] == 101 for item in manifest["gcs_backup"]["objects"])
    assert all(item["backup_generation"] for item in manifest["gcs_backup"]["objects"])
    assert all(item["crc32c"] == "source-crc32c" for item in manifest["gcs_backup"]["objects"])
    database_path = result["database_object_path"]
    assert ("reload", database_path) in bucket.events
    assert bucket.object_metadata[database_path]["sha256"] == manifest["database"]["sha256"]


def test_source_blob_without_generation_is_rejected_before_backup_writes(tmp_path):
    module = _load_backup_module()
    bucket = _FakeBucket()
    client = _FakeStorageClient(
        [_FakeSourceBlob("sheets/score.pdf", generation=None)],
        bucket,
    )
    runner = _FakeRunner()

    with pytest.raises(RuntimeError, match="generation is unavailable"):
        module.execute_backup(
            _config(module),
            _dependencies(module, tmp_path, client, runner),
        )

    assert runner.calls == []
    assert bucket.events == []


def test_copy_size_mismatch_fails_without_manifest(tmp_path):
    module = _load_backup_module()
    bucket = _FakeBucket(copy_size_delta=1)
    client = _FakeStorageClient([_FakeSourceBlob("sheets/score.pdf", 10)], bucket)

    with pytest.raises(RuntimeError, match="copied GCS object size verification failed"):
        module.execute_backup(
            _config(module),
            _dependencies(module, tmp_path, client, _FakeRunner()),
        )

    assert not any(name.endswith("manifest.json") for name in bucket.objects)


def test_copy_checksum_mismatch_fails_without_manifest(tmp_path):
    module = _load_backup_module()
    bucket = _FakeBucket(copy_checksum_mismatch=True)
    client = _FakeStorageClient([_FakeSourceBlob("sheets/score.pdf", 10)], bucket)

    with pytest.raises(RuntimeError, match="crc32c verification failed"):
        module.execute_backup(
            _config(module),
            _dependencies(module, tmp_path, client, _FakeRunner()),
        )

    assert not any(name.endswith("manifest.json") for name in bucket.objects)


def test_source_generation_conflict_fails_without_manifest(tmp_path):
    module = _load_backup_module()
    bucket = _FakeBucket(source_generation_conflict=True)
    client = _FakeStorageClient([_FakeSourceBlob("sheets/score.pdf", generation=321)], bucket)

    with pytest.raises(RuntimeError, match="source generation precondition failed"):
        module.execute_backup(
            _config(module),
            _dependencies(module, tmp_path, client, _FakeRunner()),
        )

    copy_event = next(event for event in bucket.events if event[0] == "copy")
    assert copy_event[3]["source_generation"] == 321
    assert copy_event[3]["if_source_generation_match"] == 321
    assert copy_event[3]["if_generation_match"] == 0
    assert not any(name.endswith("manifest.json") for name in bucket.objects)


@pytest.mark.parametrize(
    ("bucket_kwargs", "message"),
    [
        ({"database_size_delta": 1}, "database dump size verification failed"),
        (
            {"database_sha_mismatch": True},
            "database dump SHA-256 metadata verification failed",
        ),
    ],
)
def test_database_upload_mismatch_fails_without_manifest(tmp_path, bucket_kwargs, message):
    module = _load_backup_module()
    bucket = _FakeBucket(**bucket_kwargs)
    client = _FakeStorageClient([], bucket)

    with pytest.raises(RuntimeError, match=message):
        module.execute_backup(
            _config(module),
            _dependencies(module, tmp_path, client, _FakeRunner()),
        )

    database_path = "backups/prod-to-test/sync-20260714-001/database/kanade_portal_test.dump"
    assert ("reload", database_path) in bucket.events
    assert not any(name.endswith("manifest.json") for name in bucket.objects)


def test_manifest_reread_mismatch_fails_success_condition(tmp_path):
    module = _load_backup_module()
    bucket = _FakeBucket(tamper_manifest=True)
    client = _FakeStorageClient([_FakeSourceBlob("sheets/score.pdf")], bucket)

    with pytest.raises(RuntimeError, match="manifest verification failed"):
        module.execute_backup(
            _config(module),
            _dependencies(module, tmp_path, client, _FakeRunner()),
        )


def test_manifest_reread_detects_database_generation_mismatch(tmp_path):
    module = _load_backup_module()
    bucket = _FakeBucket(tamper_manifest_generation=True)
    client = _FakeStorageClient([_FakeSourceBlob("sheets/score.pdf")], bucket)

    with pytest.raises(RuntimeError, match="manifest verification failed"):
        module.execute_backup(
            _config(module),
            _dependencies(module, tmp_path, client, _FakeRunner()),
        )


@pytest.mark.parametrize(
    ("bucket_kwargs", "message"),
    [
        ({"tamper_manifest_gcs_generation": True}, "manifest verification failed"),
        (
            {"tamper_manifest_empty_gcs_generation": True},
            "empty GCS backup generation",
        ),
    ],
)
def test_manifest_reread_rejects_invalid_gcs_backup_generation(
    tmp_path,
    bucket_kwargs,
    message,
):
    module = _load_backup_module()
    bucket = _FakeBucket(**bucket_kwargs)
    client = _FakeStorageClient([_FakeSourceBlob("sheets/score.pdf")], bucket)

    with pytest.raises(RuntimeError, match=message):
        module.execute_backup(
            _config(module),
            _dependencies(module, tmp_path, client, _FakeRunner()),
        )


def test_partial_failure_keeps_created_backup_and_never_writes_manifest_or_deletes(tmp_path):
    module = _load_backup_module()
    bucket = _FakeBucket(fail_copy=True)
    client = _FakeStorageClient([_FakeSourceBlob("sheets/score.pdf")], bucket)
    runner = _FakeRunner()

    with pytest.raises(RuntimeError, match="copy failed"):
        module.execute_backup(
            _config(module),
            _dependencies(module, tmp_path, client, runner),
        )

    database_path = "backups/prod-to-test/sync-20260714-001/database/kanade_portal_test.dump"
    assert database_path in bucket.objects
    assert not any(name.endswith("manifest.json") for name in bucket.objects)
    assert all(event[0] != "delete" for event in bucket.events)
    assert [call["command"][0:2] for call in runner.calls] == [
        ["pg_dump", "--format=custom"],
        ["pg_restore", "--list"],
    ]
    assert not any("--dbname" in call["command"] for call in runner.calls if call["command"][0] == "pg_restore")
    assert not any(call["command"][0] in {"psql", "gcloud", "gsutil"} for call in runner.calls)


def test_execute_cli_redacts_password_from_failure_log(monkeypatch, capsys, tmp_path):
    module = _load_backup_module()
    password = "never-log-this-password"
    monkeypatch.setenv("DB_PASSWORD", password)
    bucket = _FakeBucket()
    client = _FakeStorageClient([], bucket)
    runner = _FakeRunner(failure=RuntimeError(f"database rejected {password}"))
    dependencies = _dependencies(module, tmp_path, client, runner)
    argv = [
        "--execute",
        "--operation-id",
        "sync-cli-001",
        "--target-git-sha",
        "abc123",
        "--project-id",
        "kanade-project",
        "--db-host",
        "127.0.0.1",
        "--db-name-test",
        "kanade_portal_test",
        "--db-user-test",
        "test_user",
        "--gcs-bucket-test",
        "kanade-test",
    ]

    assert module.main(argv, dependencies=dependencies) == 1

    captured = capsys.readouterr()
    assert password not in captured.out
    assert password not in captured.err
    assert "***" in captured.err
