# PHASE8A_QA_AUTOMATION_REPORT

最終更新: 2026-07-02

## 目的

Phase8-A では、実機確認前に VS Code 上で自動実行できる QA 基盤を整備する。

## 実施内容

1. `setup:local` / `qa:local` の npm scripts を追加
2. PowerShell 自動化スクリプトを追加
3. E2E smoke を拡充（団員導線、管理導線、録音/楽譜空データ耐性）
4. CI ワークフローを `workflow_dispatch` 対応に更新
5. 本番チェックリストを実チェック表形式へ更新
6. 実機確認チェックリストを新規追加
7. Cloud Run / GCS / DB 設定確認書を新規追加

## 追加・更新ファイル

- `scripts/setup-local-dev.ps1`
- `scripts/run-local-qa.ps1`
- `scripts/run-playwright-test.mjs`
- `tests/e2e/member_flow.spec.js`
- `tests/e2e/admin_flow.spec.js`
- `tests/e2e/recordings_scores.spec.js`
- `tests/e2e/fixtures/errorMonitor.js`
- `tests/e2e/fixtures/mockApi.js`（拡張）
- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `docs/LOCAL_TEST_SETUP.md`
- `docs/SOURCE_SHARE_ZIP.md`
- `docs/PRODUCTION_RELEASE_CHECKLIST.md`
- `docs/MANUAL_DEVICE_QA_CHECKLIST.md`
- `docs/CLOUD_RUN_GCS_DB_CHECK.md`

## 自動化対象コマンド

- `npm run setup:local`（`uv sync --extra dev` / `npm install` / `npx playwright install`）
- `npm run qa:local`
- `python scripts/create-source-zip.py`
- `npm run zip:source`
- `npm run check:frontend:syntax`
- `python -m compileall -q src/backend tests`
- `pytest`
- `npm run test:frontend`
- `npm run test:e2e`

## 補足

- 実機依存の確認（iPhone Safari、PWA追加、実GCS/実Cloud Run/実DB接続）は自動化対象外とし、チェックリスト化して運用で担保する。

## E2E失敗の根本原因と修正（2026-07-02 追記）

### 根本原因

- ブラウザ実行時の `pageerror`:
	- `Identifier 'ACCESS_LOG_MENU_LABELS' has already been declared`
- 原因箇所:
	- `src/static/js/modules/navigation/helpers.js`
	- `src/static/js/modules/navigation/tabs.js`
- 上記 2 ファイルで同名定数（および関連関数）をトップレベル重複宣言していた。

### 対応内容（最小差分）

- `src/static/js/modules/navigation/tabs.js` から、`helpers.js` と重複していた以下を削除。
	- `toPascalTab`
	- `ACCESS_LOG_MENU_LABELS`
	- `accessLogPanelLabel`
	- `recordAccessLog`
- タブマップの責務のみを `tabs.js` に残し、共通ヘルパーは `helpers.js` に一本化した。

### 再検証結果

- `npm run test:e2e`
	- 結果: **成功**（`7 passed`）
- `npm run qa:local`
	- 結果: **成功**
	- Summary:
		- `[PASS] python -m compileall -q src/backend tests`
		- `[PASS] npm run check:frontend:syntax`
		- `[PASS] pytest`
		- `[PASS] npm run test:frontend`
		- `[PASS] npm run test:e2e`
		- `[PASS] python scripts/create-source-zip.py`
		- `[PASS] npm run zip:source`

### 参考（再検証時ZIP）

- `oke-portal-source-20260702-093542.zip`
- 危険ファイル混入チェック: `PASS (none found)`

## Phase8-B への引き継ぎ（2026-07-02）

- 共有ZIP安全性を「除外指定」から「候補検査 + ZIP内部検査 + 内容スキャン」の多層へ強化
- `scripts/check_release_safety.py` と `check:release-safety` を追加し、事前リリース判定を標準化
- CI/E2E workflow に `npm audit --audit-level=high` と `check:release-safety` を追加
- 診断API公開制御を環境変数化し、既定値を安全側（無効・admin必須）へ変更
