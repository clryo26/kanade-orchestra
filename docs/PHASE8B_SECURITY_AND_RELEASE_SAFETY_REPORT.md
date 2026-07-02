# PHASE8B_SECURITY_AND_RELEASE_SAFETY_REPORT

最終更新: 2026-07-02

## 目的

Phase8-B では、S評価到達を目的として以下を強化する。

- 共有ZIPの安全性を多層検査へ拡張
- 診断APIの公開制御と応答最小化
- pre-release 自動チェックの標準化
- CI/E2E の監査強化（npm audit high を必須化）

## 実施内容

1. 共有ZIP安全性強化
- `scripts/create-source-zip.py` に候補検査・ZIP内部検査・内容スキャンを追加
- `src/data/*.json` 実データと `access_logs*` / `auth_devices*` / `connection_settings*` を禁止パターン化
- `.env.example` / `*.example.json` / `src/data/.gitkeep` は例外許可

2. release safety チェック導入
- `scripts/check_release_safety.py` 追加
- `scripts/check_release_safety.ps1` 追加
- `package.json` に `check:release-safety` / `pre-release` を追加
- `scripts/create-source-zip.ps1` に事前 safety check を接続

2.1 Phase8-B 最終補正（Release Safety軽量化）

- `check:release-safety` を `python scripts/check_release_safety.py` へ変更（`uv run` 非依存）
- `zip:source` は `python scripts/create-source-zip.py` のまま軽量運用を継続
- `check_release_safety.py` は標準ライブラリのみで実行可能
- `pre-release` は「軽量安全チェック → frontend policy checks → compileall → zip作成」に役割分離
- `check_release_safety.ps1` / `create-source-zip.ps1` は `py -3` / `python` のみを使用し、依存不足時の次アクションを表示

3. 診断API保護
- `src/backend/routers/meta.py` の `/api/diagnostic/config-status` を既定無効化
- 本番時 + 設定有効時は管理者認証を要求
- 本番時の管理者認証は Bearer トークン（`DIAGNOSTIC_CONFIG_ADMIN_TOKEN`）を必須化
- 応答はマスク済み最小情報のみ返却
- `write_diagnostic_access_log` を追加してアクセスを監査ログ記録

4. 依存更新自動化
- `.github/dependabot.yml` を追加（npm / pip / github-actions を月次更新）
- CI で `npm run pre-release` を実行し、更新PRの回帰を検知

5. CI/E2E 強化
- `.github/workflows/ci.yml` に `npm audit --audit-level=high` と `check:release-safety` を追加
- `.github/workflows/e2e.yml` に `npm audit --audit-level=high` と `check:release-safety` を追加

6. テンプレートデータ整備
- `src/data/access_logs.example.json`
- `src/data/auth_devices.example.json`
- `src/data/connection_settings.example.json`

7. QA証跡出力
- `npm run qa:local` の結果を `dist/qa/qa-local-result-*.json` として保存

## 更新ファイル

- `scripts/create-source-zip.py`
- `scripts/create-source-zip.ps1`
- `scripts/check_release_safety.py`
- `scripts/check_release_safety.ps1`
- `scripts/check_deployment_readiness.py`
- `scripts/run-local-qa.ps1`
- `src/backend/routers/meta.py`
- `src/backend/services/audit_service.py`
- `tests/backend/test_diagnostic_config_status.py`
- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/dependabot.yml`
- `package.json`
- `.env.example`
- `dist/qa/qa-local-result-*.json`（実行時生成）
- `src/data/*.example.json`
- `README.md`
- `docs/SOURCE_SHARE_ZIP.md`
- `docs/LOCAL_TEST_SETUP.md`
- `docs/PRODUCTION_RELEASE_CHECKLIST.md`
- `docs/MANUAL_DEVICE_QA_CHECKLIST.md`
- `docs/CLOUD_RUN_GCS_DB_CHECK.md`
- `docs/APP_CORE_COMPAT_POLICY.md`
- `docs/PHASE8A_QA_AUTOMATION_REPORT.md`
- `AGENTS.md`

## 運用ルール（Phase8-B）

- 共有前に `npm run check:release-safety` を必須化
- 本番反映前に `npm run pre-release` を実施
- 診断APIは原則無効、必要時のみ短期間で有効化し監査ログ確認

補足:

- `check:release-safety` / `zip:source` は依存未導入環境で先に実行できる
- `pre-release` は Node 側チェックを含むため `npm install` が必要
- フルテスト（`pytest`, `npm run test:frontend`, `npm run test:e2e`）は `uv sync --extra dev` / `npm install` 後に実行する

## 既知の残課題

- `npm audit --audit-level=high` / `pip-audit` の検出結果は依存更新サイクルで継続対応
