# APP_CORE Phase2 Plan

最終更新: 2026-07-01

## 現在の責務一覧

- MemoryCache 管理
- bootstrap 互換関数
- DB互換関数
- 認証互換関数
- 録音 / 楽譜 / ZIP / ファイル utility の互換エクスポート
- JSON コレクション入出力の互換エクスポート
- extra collection 互換関数
- compatibility export

## 配置先整理

- FastAPI生成: `core/app_setup.py` へ移設済み
- middleware: `core/middleware.py`, `core/audit_middleware.py` へ移設済み
- CORS / GZip / config: `core/app_setup.py`, `core/app_config.py` へ移設済み
- StaticFiles: `core/static_assets.py` へ移設済み
- startup / lifespan: `core/lifespan.py` へ移設済み
- cache: `services/cache_service.py`, `services/memory_cache.py`
- bootstrap: `routers/bootstrap.py`, `services/bootstrap_service.py`
- DB互換: `core/database.py`, `repositories/db_*`
- 認証処理: `services/auth_service.py`, `services/security_service.py`
- 録音処理: `services/recording_service.py`, `services/recording_asset_service.py`, `services/recording_upload_service.py`, `services/audio_processing_service.py`
- 楽譜/ZIP 処理: `services/sheet_service.py`, `services/sheet_asset_service.py`
- JSON コレクション入出力: `services/json_collection_service.py`
- GCS/保存処理: `drive_storage.py`, `services/file_service.py`
- utility: `utils/`, `services/file_service.py`, `utils/datetime_utils.py`
- compatibility export: `app_core.py`
- router include: `core/router_registry.py` へ移設済み

## 優先順位

- ★★★★☆: JSON/extra collection 互換ラッパーの最終整理
- ★★★☆☆: auth/bootstrap 互換 export の縮約
- ★★☆☆☆: 互換 export 一覧の固定化と不要 export の削減
- ★☆☆☆☆: `app_core.py` の公開面を維持したまま最終軽量化

## 今回実装したもの

- app 初期化・middleware・router include の core 分離を完了済み状態へ整理
- timetable/date-adjustment helper の service 分離
- file utility / datetime utility の分離継続
- sheet asset helper を `services/sheet_asset_service.py` へ抽出
- recording catalog / metadata helper を `services/recording_asset_service.py` へ抽出
- recording upload flow を `services/recording_upload_service.py` へ抽出
- audio conversion / duration helper を `services/audio_processing_service.py` へ抽出
- JSON コレクション入出力を `services/json_collection_service.py` へ抽出
- `app_core.py` は互換ファサード中心の構成へ整理
- `auth_service.py`, `member_service.py`, `extra_service.py`, `performance_service.py`, `storage_service.py`, `system_service.py` の一部 helper 依存を `app_core` 経由から direct import へ切り替え
- frontend では `frontend_testable_logic.js` に UI 契約 helper を追加し、`app.js` 文字列断片依存テストの一部を pure helper テストへ移行開始
- `album_service.py`, `sheet_service.py`, `recording_service.py` の `app_core` 直接参照を解消し、JSON IO は `storage_service.py` に互換ゲートとして集約
- `audit_service.py`, `system_service.py` の `app_core` 直接参照も解消し、さらに `storage_service.py` の互換ゲートを `core/storage_gateway.py` へ移して service 層の `app_core` 直接参照をゼロ化
- frontend では `member_password_display`, `payment_status_display`, `casting_admin_edit` テストも pure helper ベースへ移行
- frontend では `casting_table_layout`, `performance_form_layout`, `sheet_library_alignment` テストも pure helper + HTML/CSS 静的契約ベースへ移行し、frontend test からの `app.js` 文字列検査依存を解消
- core 層の `app_core` 参照も `core/compat_gateway.py` に一本化し、`app_factory.py`/`dependency.py`/`storage_gateway.py` からの直接参照を解消
- router 層の `app_core as core` 参照を `announcements/events/schedules/performances/members/access_logs/bootstrap/maintenance/meta/system` で解消
- repository 層の `db_row_repository.py` と `db_json_repository.py` から `app_core` 直接参照を解消し、`psycopg`/`psql`/`Jsonb`/`HTTPException`/`db_connection_string` などを direct import 化
- `auth_api.py` から `app_core` 直接参照を解消し、schema は `models.schemas`、パスワード helper は `services/security_service.py` を参照
- backend 内で `app_core` を直接 import する箇所は `core/compat_gateway.py` と `main.py` の互換境界に限定
- 逆流防止として `tests/backend/test_app_core_import_boundary.py` を追加し、`app_core` の直接 import を許可境界（`main.py` / `core/compat_gateway.py` / `app_core.py`）以外で検知すると fail するガードを導入
- 未整理だった `models/member.py`, `models/performance.py`, `routers/albums.py`, `routers/recordings.py`, `routers/scores.py` も direct import 化し、境界テストで回帰を固定

## 次の直接対象

1. `app_core.py` に残る JSON/extra/auth の互換 export を利用実績ベースでさらに整理する
2. `APP_CORE_COMPATIBILITY_API.md` と実装の完全同期を維持する
3. backend 側の `app_core` 新規依存を禁止し、services/core/repositories 直参照へ寄せる
4. `core/compat_gateway.py` と `core/storage_gateway.py` の責務境界（統合 or 分離維持）を決める
5. `app_core.py` 本体の公開互換面を実利用ベースでさらに絞り込み、互換シンボル削減の段階計画を作る

## 追補（Phase4 バッチ）

- `app_core.py` の serialization 互換ラッパー（`model_dump`, `fk_int`）を
	direct import へ置き換え、互換面を維持したまま薄化した。
- `app_core` は引き続き互換エントリーポイントとして維持し、
	API/レスポンス/DB スキーマに影響する変更は行っていない。
- 次回は依存注入が必要な互換ラッパー群（startup/json/recording/extra）を
	`core/` 側へまとめるための非破壊インターフェース導入を優先する。

## 追補（Phase4 追加バッチ）

- `app_core.py` の単純委譲ラッパーをさらに direct import 化した。
	対象: DB row/json 互換関数、`cloud_run_revision`、`ensure_expected_updated_at`、`next_updated_at`、
	`env_flag_enabled`、extra helper の `parse_extra_upsert_request` / `assert_extra_collection_permission` / `read_json_body`。
- 依存注入が必要な互換ゲート（`db_data_enabled`, `db_expected`, `load_json_data`, `save_json_data`,
	`seed_cloud_data_from_local` など）は維持し、既存 monkeypatch 経路と公開面互換を保持した。

## 追補（Phase5 バッチ）

- `app_core.py` は互換面維持を優先して薄化を継続し、現時点 513 行。
- 500 行以下への到達は、`load_json_data` / `save_json_data` / startup 連携などの
	依存注入互換レイヤーを別モジュール化する必要があり、
	一括実施は monkeypatch 互換と import 境界テストへの影響が大きいため見送った。
- 次バッチでは `core/compat_helpers.py` 等へ「依存注入前提の互換関数群」を移し、
	`app_core` からの direct alias を増やす方針とする。

## 追補（Phase6 バッチ）

- `core/app_lifecycle.py` を追加し、DB runtime / startup self-check の互換委譲を分離した。
- `app_core.py` は 503 行まで薄化したが、400 行以下は未達。
- 未達理由は recording/json/bootstrap の互換ラッパーが monkeypatch 互換を担っており、
	追加分離の安全確認コストが高いため。

## 棚卸し自動化（2026-07-01 追加）

- `scripts/analyze_app_core_exports.py` を追加し、`app_core` の公開シンボル棚卸しを自動化した。
- 生成レポート: `docs/APP_CORE_EXPORT_INVENTORY.md`
- 再生成コマンド:
	- `uv run python scripts/analyze_app_core_exports.py --repo-root . --write docs/APP_CORE_EXPORT_INVENTORY.md`
- 現時点の静的解析結果では、`src/` 内で `app_core` を import するファイルは `main.py` と `core/compat_gateway.py` の2つのみ。
- `Candidate Unreferenced Exports` は削除候補ではなくレビューキューとして扱う（外部スクリプト/monkeypatch の可能性があるため）。
- `src/backend/app_core.py` に明示的な `__all__` を追加し、公開互換面をコード上で固定した。
- 回帰テスト: `tests/backend/test_app_core_public_surface.py` が `__all__` の安定性と必須互換シンボルを検証する。
- 同テストは棚卸しスクリプト `scripts/analyze_app_core_exports.py` が検出する公開名集合と `app_core.__all__` の一致も検証する。
