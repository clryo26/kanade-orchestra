# app_core Compatibility API

最終更新: 2026-07-01

## 目的

`src/backend/app_core.py` は段階的分割中の互換ファサードであり、
外部モジュール（routers/services/tests）が依存してよい公開互換面を明示する。

この文書に記載のない内部実装詳細（ローカルヘルパー・中間変換関数）には新規依存しない。

## 公開互換面（現在の利用実績ベース）

### 認証・権限
- `device_auth_record`
- `require_device`
- `require_admin_device`
- `require_system_admin_device`
- `require_recording_manager_device`
- `require_sheet_manager_device`
- `assert_extra_collection_permission`

### DB/実行基盤
- `db_connection_string`
- `db_data_enabled`
- `db_expected`
- `db_configured`
- `assert_db_ready`
- `mask_db_value`
- `run_db_startup_self_check`
- `ensure_db_schema_compatibility`
- `psycopg`
- `psql`

### JSON/CRUD互換
- `load_json_data`
- `save_json_data`
- `load_local_json_data`
- `data_file`
- `find_item`
- `next_id`
- `ensure_expected_updated_at`
- `check_etag`

### Extra collection互換
- `collection_items`
- `parse_extra_upsert_request`
- `normalize_extra_for_collection`
- `normalize_extra_payload`

### Member/表示互換
- `prepare_member_payload`
- `public_member_payload`
- `public_member_list`
- `list_auth_devices`
- `fk_int`

### Recording/Sheet/File互換
- `UPLOAD_DIR`
- `SHEET_DIR`
- `CONVERTED_DIR`
- `DRIVE_STAGING_DIR`
- `safe_upload_name`
- `safe_segment`
- `save_upload_to_path`
- `ensure_audio_file`
- `ensure_pdf_file`
- `get_audio_duration_seconds`
- `convert_path_to_mp3`
- `format_duration`
- `recording_metadata_map`
- `remember_recording_duration`
- `recording_payload`
- `recording_file_bytes`
- `local_recording_path`
- `local_recording_metadata`
- `cloud_recording_metadata`
- `remember_drive_file`
- `forget_drive_file`
- `sheet_metadata`
- `sheet_payload`
- `sheet_file_bytes`
- `delete_sheet_file`
- `local_sheet_path`
- `unique_zip_name`

### Timetable/Performance互換
- `performance_day_info_for_performance`
- `build_timetable_workbook_bytes`
- `excel_safe_filename`

### 汎用
- `logger`
- `quote`
- `datetime`
- `date`
- `time`
- `Decimal`
- `re`
- `storage_enabled`
- `_memory_cache`（既存テスト互換のため現状維持）
- `app`（FastAPI app object）

## 互換運用ルール

1. 新規コードは `app_core` ではなく `core/`, `services/`, `repositories/` を優先参照する。
2. 既存互換のため `app_core` ラッパーは維持するが、実体ロジックは段階的に移設する。
3. 公開互換面の追加・削除時はこの文書を更新する。
4. 互換面に変更がある場合は `tests/backend/test_auth_and_crud.py` と関連回帰セットを必ず実行する。

## 直近の依存整理メモ

- `services/auth_service.py` は password/hash/model dump/display name の補助処理を `security_service.py`, `auth_helpers.py`, `utils/serialization.py` へ直参照する構成へ移行した。
- `services/member_service.py` は member payload/public payload の整形を `auth_service.py` の公開 helper へ直参照する構成へ移行した。
- `services/extra_service.py` は collection/payload/permission helper の一部を `services/extra_collection_helpers.py`, `services/timetable_payload_helpers.py`, `utils/concurrency.py`, `utils/datetime_utils.py` へ直参照する構成へ移行した。
- `services/performance_service.py` は timetable helper と template path を `services/timetable_payload_helpers.py`, `core/runtime_paths.py` へ直参照する構成へ移行した。
- `services/storage_service.py` は collection utility を `utils/collection_utils.py` へ直参照し、JSON collection IO は `core/storage_gateway.py` へ委譲する構成へ移行した。
- `services/system_service.py` は DB 接続文字列・DB 値マスク・memory cache invalidate を `core/` と dependency helper へ直参照する構成へ移行済み。
- `services/album_service.py`, `services/sheet_service.py`, `services/recording_service.py` は path / quote / logger / metadata helper の direct import 化を進め、個別 service からの `app_core` 直接参照を解消した。
- `services/audit_service.py` は DB 利用可否判定・device auth・fk_int を direct import 化し、`app_core` 直接参照を解消した。
- 2026-07-01 時点で service 層の `app_core` 直接参照はゼロになった（互換ゲートは `core/storage_gateway.py` に集約）。
- core 層でも `app_core` への直接参照は `core/compat_gateway.py` に集約し、`app_factory.py`, `dependency.py`, `storage_gateway.py` はゲート経由で依存する構成へ移行した。
- router 層の `from .. import app_core as core` 参照は解消し、schema/認可/IO/JSON/health判定を direct import へ置換した。
- repository 層の `db_row_repository.py` / `db_json_repository.py` は `app_core` 依存を解消し、`datetime`/`Decimal`/`re`/`HTTPException`/`psycopg`/`Jsonb`/`db_connection_string` などを direct import 化した。
- `auth_api.py` も `app_core` への直接依存を解消し、schema は `models.schemas`、パスワード処理は `services/security_service.py` を参照する構成へ移行した。
- backend 全体で `app_core` を直接 import する箇所は意図的な互換層（`core/compat_gateway.py` と `main.py`）のみに限定された。
- 追加移行として `models/member.py`, `models/performance.py`, `routers/albums.py`, `routers/recordings.py`, `routers/scores.py` の `app_core` 直接参照も解消した。
- 逆流防止のため `tests/backend/test_app_core_import_boundary.py` を追加し、許可境界以外の `app_core` 直接 import は CI で fail するようにした。
- 公開互換面の棚卸しは `scripts/analyze_app_core_exports.py` で自動化し、最新結果を `docs/APP_CORE_EXPORT_INVENTORY.md` に出力する運用とした。
- `app_core.py` 自身にも明示的な `__all__` を追加し、公開互換面をコード上で固定した。
- `tests/backend/test_app_core_public_surface.py` で `__all__` の安定性と互換境界の必須公開名を回帰テスト化した。
- 同テストは `scripts/analyze_app_core_exports.py` の `collect_app_core_exports()` と `app_core.__all__` の一致も検証し、棚卸しスクリプトと実装のズレを検知する。
