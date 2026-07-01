# PHASE7_QA_AND_RELEASE_REPORT

最終更新: 2026-07-01

## 実施目的

- 大規模リファクタリング後の破壊を早期検知する仕組みを追加
- 本番前チェックを標準化
- 共有 ZIP 運用の再確認

## 実施内容

1. Playwright E2E 基盤を追加
2. 主要導線の smoke テストを追加
3. CI で軽量テストと E2E ワークフローを分離
4. 本番リリースチェックリストを追加
5. 残り JS 分割候補を棚卸し

## Playwright 導入状況

- `playwright.config.js` を追加
- `tests/e2e/smoke.spec.js` を追加
- `tests/e2e/member.spec.js` を追加
- `tests/e2e/admin.spec.js` を追加
- `tests/e2e/fixtures/mockApi.js` / `mockData.js` を追加
- `package.json` に `test:e2e`, `test:e2e:ui` を追加
- 社内プロキシ配下での実行を考慮し、localhost 向けの proxy bypass と TLS 回避設定手順を追加

## E2E 実行方法

```bash
npm run test:e2e
npm run test:e2e:ui
```

Playwright ブラウザ未導入環境では先に以下を実行する。

```bash
npx playwright install chromium
```

社内プロキシ環境の実行例（Windows PowerShell）:

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED='0'
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
$env:NO_PROXY='127.0.0.1,localhost'
$env:no_proxy='127.0.0.1,localhost'
npx playwright install chromium
npm run test:e2e
```

実行結果（2026-07-01）:

- `npx playwright install chromium`: 成功
- `npm run test:e2e`: 3 passed

## CI 実行方針

- `.github/workflows/ci.yml`:
  - Python 構文チェック
  - `pytest`
  - frontend syntax
  - frontend tests
  - source zip build
- `.github/workflows/e2e.yml`:
  - 手動実行および E2E 関連変更時に Playwright smoke を実行
  - `NO_PROXY/no_proxy` を設定し localhost 通信を社内プロキシ経由にしない

## e2e.yml 実行時の期待ログ

GitHub Actions の `playwright-smoke` ジョブでは、以下の流れで成功する。

1. `Install Playwright browsers` で Chromium のダウンロードが完了する
2. `Run E2E smoke` で `3 passed` が表示される
3. `Upload Playwright report` で `playwright-report` が artifact 化される

期待される最終行の例:

```text
3 passed
```

## e2e.yml 失敗時の確認ポイント

- `install chromium` 失敗時:
  - 社内TLS/プロキシ設定を確認
  - `NODE_TLS_REJECT_UNAUTHORIZED` と `NO_PROXY/no_proxy` の有効性を確認
- `webServer` 起動失敗時:
  - `DATA_BACKEND=local` / `LOCAL_JSON_FALLBACK_ENABLED=true` を確認
  - `playwright.config.js` の `webServer.env` を確認
- `strict mode violation` 時:
  - 同名ボタンが複数あるため、`#portalDrawerMenu` などでロケータをスコープする

## 本番前確認

- `docs/PRODUCTION_RELEASE_CHECKLIST.md` を参照して運用確認を実施する。

## 共有 ZIP 運用

- `python scripts/create-source-zip.py` または `npm run zip:source`
- `.env` / `.venv` / `.git` / `node_modules` / 録音実体 / DB 実体 / credentials 系の除外を維持

## 補正ログ（2026-07-02）

- `playwright.config.js` を共有 ZIP の含有対象へ追加した。
- `scripts/create-source-zip.py` で `playwright.config.js` / `tests/e2e/` / `.github/workflows/e2e.yml` が含まれることを確認できるようにした。
- E2E の標準ポートを `8000` に統一し、`E2E_BASE_URL` を明示的に扱うようにした。
- CI の Playwright artifact 保存対象に `test-results` を追加した。
- ローカル手順書を `npm ci` / `npx playwright install --with-deps chromium` / `uvicorn 8000` ベースへ更新した。

## 再検証ログ（2026-07-01 夜）

運用手順の再現性を確認するため、以下を再実行した。

- `uv run pytest -q`: 100 passed
- `npm run check:frontend:syntax`: 84 files passed
- `npm run test:frontend`: 18 files / 64 tests passed
- `npm run test:e2e`: 3 passed
- `python scripts/create-source-zip.py`: `dist/source-share/oke-portal-source-20260701-214249.zip` を生成
- ZIP混入チェック: `OK: no dangerous entries found`

補足:

- `uv run ruff check .` は既存差分由来の lint 違反で失敗（今回の運用ドキュメント更新範囲外）。

## 補足ログ（Node/npm未搭載端末での代替確認）

同日、別端末セッションで `npm` / `npx` 実行ファイルを解決できない状態を確認した。

- `where.exe npm`: not found
- `cmd /c npm --version`: not recognized

このためローカルE2E再実行は行わず、以下の代替確認を実施した。

- `uv run python -c` + `TestClient` による `GET /api/health`: `200 / healthy`
- `uv run python -c` + `TestClient` による `GET /`: `200`

最終的な E2E 判定は `workflow_dispatch` の `E2E` workflow 実行結果を正とする。
