# LOCAL_TEST_SETUP

最終更新: 2026-07-02

## 目的

VS Code 上で、依存セットアップから自動 QA までをコマンド 1 つで再現できるようにする。

## 前提

- OS: Windows 11
- Python: uv 管理
- Node.js / npm: 利用可能
- 実行位置: リポジトリルート

## 標準フロー（推奨）

## 軽量チェック（依存未導入環境でも実行可能）

以下は Python 標準ライブラリだけで動くため、最初の安全確認として実行できる。

```powershell
npm run check:release-safety
python scripts/check_release_safety.py
python scripts/create-source-zip.py
npm run zip:source
```

補足:

- `check:release-safety` は `.env/.git/.venv/node_modules/src/data/*.json` 混入等を軽量検査する
- `zip:source` は共有ZIP作成前に必ず実行する

### 1. 初期セットアップ

```powershell
npm run setup:local
```

`setup:local` で実行される内容:

- `uv sync --extra dev`
- `npm install`
- `npx playwright install`

### 2. ローカル QA 一括実行

```powershell
npm run qa:local
```

`qa:local` で実行される内容:

1. `python -m compileall -q src/backend tests`
2. `npm run check:release-safety`
3. `npm run check:security:python`
4. `npm run check:types:backend`
5. `npm run check:frontend:syntax`
6. `npm run check:frontend:load-order`
7. `npm run check:frontend:state-access`
8. `npm run check:ops:checklists`
9. `npm run check:tenant:migration`
10. `npm run check:decision-log`
11. `pytest`
12. `npm run test:frontend`
13. `npm run test:e2e`
14. `python scripts/create-source-zip.py`
15. `npm run zip:source`
16. `npm run check:release:readiness`

補足:

- 途中で失敗しても、最後に成功/失敗一覧のサマリーを表示する。
- ZIP が生成された場合、パス・サイズ・ファイル数・危険ファイル混入チェック結果を表示する。
- 実行ごとの証跡JSONを `dist/qa/qa-local-result-YYYYMMDD-HHMMSS.json` に保存する。
- `npm run test:e2e` は `scripts/run-playwright-test.mjs` 経由で localhost 向け proxy 環境変数を自動調整する。

## 個別実行（必要時）

```powershell
python -m compileall -q src/backend tests
npm run check:security:python
npm run check:release-safety
npm run check:types:backend
npm run check:frontend:syntax
npm run check:frontend:load-order
npm run check:frontend:state-access
npm run check:ops:checklists
npm run check:tenant:migration
npm run check:decision-log
uv run pytest
npm run test:frontend
npm run test:e2e
python scripts/create-source-zip.py
npm run zip:source
npm run check:release:readiness
npm run pre-release
```

`pre-release` は Node 側チェックを含むため、未導入環境では `npm install` 後に実行する。

### グローバル状態参照ルール（Issue 9対応）

- `window.appState` と `window.portalAppState` の直接参照は原則禁止。
- 状態参照は `window.getAppState()` または `window.portalRuntimeContext.appState` を使用する。
- ルール違反は `npm run check:frontend:state-access` でCI含め検知される。

### 運用チェック自動化（Issue 8対応）

- `npm run check:ops:checklists` で手動運用チェックリストの構成不備を検知する。
- 実機必須項目は引き続き手動運用だが、チェック項目の欠落は自動で検知する。

### テナント準備検証（Issue 10対応）

- `npm run check:tenant:migration` で `organization_id` マイグレーション対象漏れを検知する。
- tenant context は `tests/backend/test_tenant_context.py` で基本挙動を検証する。

### 判断ログ統一運用（Issue 12対応）

- `npm run check:decision-log` で ADR フォーマットとガイド整合を検証する。
- PR 時は `.github/pull_request_template.md` の Decision Log チェック項目を使用する。

### 依存脆弱性チェック（Issue 4対応の一部）

- `npm run check:security:python` で Python 依存の既知脆弱性を検知する。
- 失敗時は依存更新または許容理由の記録を行い、CIで継続的に監視する。

### 段階型チェック（Issue 4対応）

- `npm run check:types:backend` で mypy の段階導入ゲートを実行する。
- `check:types:backend` は現在 `mypy -p src.backend`（backend 全体）に加え、QA checker scripts も検査対象として実行する。

### バックエンドのプロファイル契約テスト（Issue 5対応）

```powershell
uv run pytest -q tests/backend/test_json_db_response_parity.py
uv run pytest -q tests/backend/test_db_json_layer.py tests/backend/test_db_mode_api_regression.py tests/backend/test_json_db_response_parity.py
```

補足:

- 1行目は local 環境でも JSON/DB モード差分を検知できる共通契約テスト。
- 2行目は db プロファイル専用の回帰セット。

## 典型エラーと対処

### `uv` が見つからない

- 原因: uv 未導入
- 対処: `irm https://astral.sh/uv/install.ps1 | iex`

### `npm` / `npx` が見つからない

- 原因: Node.js 未導入
- 対処: `winget install OpenJS.NodeJS.LTS`

### `No module named pytest`

- 原因: Python の dev 依存未導入
- 対処: `uv sync --extra dev`

### Playwright browser install 失敗

- 原因: プロキシ/TLS 制約、権限不足など
- 対処: `npx playwright install --with-deps chromium` を手動実行し、失敗ログを確認する
- 注記: Playwright ブラウザ導入前は `npm run test:e2e` が失敗する

## 社内ネットワーク向け補足

- 依存導入が不安定な場合は `npm run setup:local` を先に完了させる。
- E2E が実行できない場合でも、最低限 `compileall` と frontend syntax を実施して構文健全性を確認する。
