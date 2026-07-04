# SOURCE_SHARE_ZIP

最終更新: 2026-07-02

## 概要

共有用ソース ZIP は、個人PCと会社PCのあいだで ChatGPT 情報源へ安全にアップロードするための配布物です。
秘密情報・依存物・録音実データ・キャッシュは含めません。

## ZIP作成方法

軽量運用方針:

- `npm run check:release-safety` は依存未導入環境でも実行可能な軽量チェック
- `npm run zip:source` は依存未導入環境でも実行可能（Python標準ライブラリのみ）
- `npm run pre-release` は Node 側チェックを含むため `npm install` が必要

### PowerShell

```powershell
.\scripts\create-source-zip.ps1
```

### Python

```powershell
python scripts/create-source-zip.py
```

### npm

```powershell
npm run zip:source
```

### QA 一括経由

```powershell
npm run qa:local
```

`qa:local` は ZIP 生成まで含むため、手順漏れを防げる。

## 共有前の最小手順（軽量）

```powershell
npm run check:release-safety
npm run zip:source
```

依存導入済み環境では以下を推奨:

```powershell
npm run pre-release
```

## 出力先

```text
dist/source-share/
```

ZIP名:

```text
oke-portal-source-YYYYMMDD-HHMMSS.zip
```

## 作成後に表示される内容

- ZIP保存先
- ZIPサイズ
- ファイル数
- 除外ファイル数
- ChatGPT情報源へアップロードしてくださいという案内

`npm run qa:local` 経由の場合は、追加で以下を表示する。

- 危険ファイル混入チェック結果（PASS/FAIL）
- 失敗したQAステップ一覧

## ChatGPT情報源を利用したPC間同期方法

1. 個人PCまたは会社PCで共有ZIPを作成する。
2. ChatGPT プロジェクトの「情報源」へ ZIP をアップロードする。
3. 受け取り側PCで ZIP を取得し、作業用フォルダへ展開する。
4. `.env` は展開先で新規作成する。
5. `uv sync` と `npm install` を必要に応じて実行する。

## ZIPへ含めるもの

- `src/`
- `tests/`
- `scripts/`
- `docs/`
- `infra/`
- `.github/`
- `tests/e2e/`
- `docs/MANUAL_DEVICE_QA_CHECKLIST.md`
- `docs/CLOUD_RUN_GCS_DB_CHECK.md`
- ルート直下のすべての Markdown 文書（設計書・仕様書・運用書を含む）
- `README.md`
- `AGENTS.md`
- `UNIT_TEST_SPEC.md`
- `INTEGRATION_TEST_SPEC.md`
- `INTEGRATION_TEST_SPEC_BACKEND.md`
- `INTEGRATION_TEST_SPEC_FRONTEND.md`
- `INTEGRATION_TEST_SPEC_CI.md`
- `OPERATION_TEST_SPEC.md`
- `DESIGN_DOCS_NAVIGATION.md`
- `playwright.config.js`
- `package.json`
- `package-lock.json`
- `pyproject.toml`
- `requirements*.txt`
- `Dockerfile`
- `docker-compose*`
- `cloudbuild*.yaml`
- `.env.example`
- `.gitignore`
- `.dockerignore`

## ZIPへ含めないもの

- `.git/`
- `.env`
- `.env.*`（ただし `.env.example` は含める）
- `.venv/`
- `venv/`
- `env/`
- `node_modules/`
- `__pycache__/`
- `.pytest_cache/`
- `.ruff_cache/`
- `.mypy_cache/`
- `.cache/`
- `coverage/`
- `htmlcov/`
- `dist/source-share/`
- `*.pyc`
- `*.pyo`
- `*.tmp`
- `*.bak`
- `*.log`
- `Thumbs.db`
- `.DS_Store`
- `src/uploads/`
- `uploads/`
- `*.wav`
- `*.mp3`
- `*.m4a`
- `*.flac`
- `*.db`
- `*.sqlite`
- `*.sqlite3`
- `*service-account*.json`
- `*credentials*.json`
- `.vscode/settings.json`

## ZIP安全チェック

作成後に ZIP 内容を検査し、以下が含まれていた場合は ZIP を削除してエラー終了します。

- `.env`
- `.git`
- `node_modules`
- `.venv`
- `__pycache__`
- `*.wav`
- `*.mp3`
- `*.sqlite`
- `credentials`
- `service-account`

Phase5 追加チェック（2026-07-01）:

- `.venv` / `node_modules` / `.git` が 1 件でも含まれていたら失敗
- `uploads/` および音声拡張子（wav/mp3/m4a/flac）が 1 件でも含まれていたら失敗
- `credentials` / `service-account` / `.env` 系が 1 件でも含まれていたら失敗

Phase6 検証結果（2026-07-01）:

- 最新 ZIP: `oke-portal-source-20260701-204302.zip`
- ファイル数: 259
- 危険ファイル混入チェック: `DANGEROUS_FOUND=NO`

Phase8-A 追記（2026-07-02）:

- `qa:local` に ZIP 混入チェックを統合し、毎回のローカル QA 実行で確認する
- `playwright.config.js` / `tests/e2e/` / `docs/MANUAL_DEVICE_QA_CHECKLIST.md` / `docs/CLOUD_RUN_GCS_DB_CHECK.md` の含有確認を運用チェックに追加

Phase8-B 追記（2026-07-02）:

- `src/data/*.json`（実データ）を共有ZIP候補・ZIP内部検査の両方で禁止
- `access_logs*` / `auth_devices*` / `connection_settings*` を禁止パターンへ追加
- `.env.example` と `*.example.json` は例外許可（テンプレート共有のため）
- `scripts/check_release_safety.py` により共有前に必須ファイル同梱・禁止候補混入・frontend方針を検査
- `scripts/create-source-zip.ps1` は ZIP 作成前に `check_release_safety.py` を実行し、失敗時は中断

Phase8-C 追記（2026-07-02）:

- ZIP 安全ルールを `scripts/source_zip_safety_rules.json` に外部化
- `create-source-zip.py` と `check_release_safety.py` は同一ルールファイルを参照
- `allowedCandidateExceptions` で例外候補を明示管理
- app_core 段階薄化の安全運用として `check_app_core_slimming.py`（既定: 520 行上限）を追加

Phase7 推奨チェック（PowerShell）:

```powershell
$latestZip = Get-ChildItem dist/source-share/*.zip | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($latestZip.FullName)
$dangerPatterns = @('\\.env$','id_rsa','id_ed25519','\\.pem$','\\.key$','service-account','credentials?','token','node_modules/','__pycache__/','\\.pytest_cache/','\\.venv/','\\.git/')
$hits = @()
foreach ($entry in $zip.Entries) {
	foreach ($pattern in $dangerPatterns) {
		if ($entry.FullName -match $pattern) { $hits += $entry.FullName; break }
	}
}
$zip.Dispose()
if ($hits.Count -eq 0) { 'PASS' } else { "FAIL: $($hits -join ', ')" }
```

## 初期セットアップ手順

1. ZIP を展開する
2. `.env.example` を参照して `.env` を各PCで作成する
3. Python依存が必要なら `uv sync`
4. フロント依存が必要なら `npm install`
5. DB Only ローカル起動を行う場合は `.vscode/tasks.json` の DB タスクを使う

## 注意

- `.env` や `.env.local` は各PCで作成し、共有ZIPへ含めない
- `.env.example` はテンプレートとして共有ZIPへ含める
- GCP認証JSON、録音実ファイル、ローカルDBファイルは共有しない
- 本番データは DB Only 前提であり、`src/data/*.json` は共有対象に含めない

## Phase8-A 運用チェック（共有前）

- [ ] `npm run qa:local` が完了した
- [ ] 最新 ZIP の危険ファイル混入チェックが PASS
- [ ] `playwright.config.js` が ZIP に含まれている
- [ ] `tests/e2e/` が ZIP に含まれている
- [ ] `docs/MANUAL_DEVICE_QA_CHECKLIST.md` が ZIP に含まれている
- [ ] `docs/CLOUD_RUN_GCS_DB_CHECK.md` が ZIP に含まれている

## Phase8-B 運用チェック（共有前）

- [ ] `npm run check:release-safety` が PASS
- [ ] `src/data/*.json` 実データが ZIP 候補から除外されている
- [ ] `src/data/*.example.json` のみテンプレートとして同梱されている
- [ ] `npm run pre-release` が PASS

依存未導入で `pre-release` が失敗した場合の次アクション:

- `npm install`
- Pythonテスト依存が必要な場合は `uv sync --extra dev`

## ルール管理ファイル

- `scripts/source_zip_safety_rules.json`
	- `excludeFilePatterns`: 候補収集時の除外パターン
	- `safetyBannedNamePatterns`: ZIP 内の禁止ファイル名パターン
	- `safetyBannedContentPatterns`: ZIP 内テキストスキャンの禁止内容パターン
	- `contentScanTargetPatterns`: テキスト内容を追加走査する対象パターン
	- `allowedDotEnvFiles`: `.env` 系の許可例外
	- `allowedDataTemplateFiles`: データテンプレート許可例外
	- `allowedCandidateExceptions`: 候補段階での許可例外
