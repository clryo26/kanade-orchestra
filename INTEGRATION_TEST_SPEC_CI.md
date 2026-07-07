# 奏オケポータル 結合テスト仕様書（CI・運用担当）

版: 1.1
最終更新: 2026-07-07

## 1. 対象

- 結合テストのCI実行保証
- 失敗時の分類と再実行手順
- カバレッジ集約コメント運用

## 2. 実施責任

- 主担当: CI/運用担当
- 協力: バックエンド担当、フロント担当

## 3. ケース一覧（詳細）

### 3.1 CI実行保証

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-CI-001 | P0 | pull_request作成済み | CI起動確認 | backend-tests, frontend-tests, coverage-summary が実行される |
| IT-CI-002 | P0 | backendテスト成功条件 | backend-testsジョブ確認 | pytest終了コード0 |
| IT-CI-002B | P0 | app_core公開面管理導入済み | 公開面テスト実行確認 | `tests/backend/test_app_core_public_surface.py` が成功し、`__all__` と棚卸しスクリプトの同期が保たれる |
| IT-CI-002A | P0 | app_core互換境界ルール適用済み | import境界テスト実行確認 | `tests/backend/test_app_core_import_boundary.py` が成功し、許可外の直接importを検知できる |
| IT-CI-003 | P0 | frontendテスト成功条件 | frontend-testsジョブ確認 | vitest終了コード0 |
| IT-CI-003A | P0 | Workflow静的検査導入済み | frontend-testsジョブ確認 | npm run check:workflow:static が成功 |
| IT-CI-006 | P0 | Python品質ゲート設定済み | compileall / ruff 実行確認 | 構文チェックとlintが成功 |
| IT-CI-007 | P0 | Dockerfile更新時 | docker-cloudrun-smoke確認 | Docker build成功 + CMDに`src.backend.main:app`を含む |
| IT-CI-004 | P1 | coverage artifact設定済み | artifact出力確認 | backend/frontend coverage artifact生成 |
| IT-CI-005 | P1 | PRイベント | coverage-summaryコメント確認 | 既存コメントが更新される |
| IT-CI-008 | P0 | 対象Workflowに旧名称を意図的に混入 | check:workflow:static実行 | GAR_REPOSITORY/WIF_SERVICE_ACCOUNT/CLOUD_RUN_SERVICE_PROD残存を検知して失敗 |
| IT-CI-009 | P1 | sync-prod-to-test.ymlの方向ガード文言を削除 | check:workflow:static実行 | production -> test 固定方針の欠落を検知して失敗 |
| IT-CI-010 | P1 | Template guardはあるがexit 1を削除 | check:workflow:static実行 | Template guard未完了として失敗 |

### 3.2 障害切り分け

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-CI-TRIAGE-001 | P1 | backend-tests失敗ログ | 失敗分類（認可/整合/依存） | 分類結果をPRコメントへ記録 |
| IT-CI-TRIAGE-002 | P1 | frontend-tests失敗ログ | 失敗分類（通信/描画/キャッシュ） | 分類結果をPRコメントへ記録 |
| IT-CI-TRIAGE-003 | P2 | coverage-summary失敗ログ | 権限/artifact不足を判定 | 再実行手順を明示 |

## 4. 運用ルール

- pull_requestでの必須チェックに CI workflow を設定する
- re-run前に失敗分類を残す
- coverage summary の差分増減はレビュー観点として記録する

### 必須チェック名（デプロイ可否ゲート）

- `source-share-zip`
- `backend-tests-local`
- `backend-tests-db`
- `frontend-tests`
- `docker-cloudrun-smoke`

## 4.1 Backendプロファイル前提（重要）

- backendテストは `local` と `db` の2プロファイルで前提が異なる。
- 1プロセス内で `local` 前提テストと `db` 前提テストを混在実行しない。
- CIでは `.github/workflows/ci.yml` の分割ジョブを正として扱う。

| プロファイル | 代表ジョブ | 想定データ経路 | 実行対象例 |
|---|---|---|---|
| local | backend-tests-local | JSON fallback | `tests/backend/test_app_core_public_surface.py`, `tests/backend/test_app_core_import_boundary.py`, `tests/backend -k "not db_mode and not db_json_layer"`, `tests/integration/backend`, `tests/operations` |
| db | backend-tests-db | DB mode（DB API互換層） | `tests/backend/test_db_json_layer.py`, `tests/backend/test_db_mode_api_regression.py`, `tests/backend/test_json_db_response_parity.py` |

### ローカル再現コマンド例

- localプロファイル:
	- `uv run pytest -q tests/backend/test_app_core_public_surface.py`
	- `uv run pytest -q tests/backend/test_app_core_import_boundary.py`
	- `uv run pytest -q tests/backend -k "not db_mode and not db_json_layer"`
	- `uv run pytest -q tests/integration/backend tests/operations`
- dbプロファイル:
	- `powershell`: `$env:DATA_BACKEND='db'; uv run pytest -q tests/backend/test_db_json_layer.py tests/backend/test_db_mode_api_regression.py tests/backend/test_json_db_response_parity.py`
	- 実行後は必要に応じて `Remove-Item Env:DATA_BACKEND`

## 4.2 Workflow静的検査運用（重要）

- 対象Workflow:
	- .github/workflows/deploy-test.yml
	- .github/workflows/promote-production.yml
	- .github/workflows/sync-prod-to-test.yml
- 実行コマンド:
	- `npm run check:workflow:static`
- 検査スクリプト:
	- scripts/check_workflow_static.py
- 必須観点:
	- 旧名称の残存禁止（GAR_REPOSITORY, WIF_SERVICE_ACCOUNT, CLOUD_RUN_SERVICE_PROD）
	- 統一名称の存在確認（ARTIFACT_REGISTRY_REPOSITORY, TEST/PROD_CLOUD_RUN_SERVICE, DEPLOY_SERVICE_ACCOUNT, WIF_PROVIDER）
	- sync方向ポリシー文言の維持（production -> test only）
	- Template guard と exit 1 の維持
	- secrets式のecho禁止

## 5. 実装参照

- .github/workflows/ci.yml
- scripts/check_workflow_static.py
- UNIT_TEST_SPEC.md
- INTEGRATION_TEST_SPEC.md
