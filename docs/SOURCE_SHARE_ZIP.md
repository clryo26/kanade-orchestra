# SOURCE_SHARE_ZIP

最終更新: 2026-07-01

## 概要

共有用ソース ZIP は、個人PCと会社PCのあいだで ChatGPT 情報源へ安全にアップロードするための配布物です。
秘密情報・依存物・録音実データ・キャッシュは含めません。

## ZIP作成方法

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
- `README.md`
- `AGENTS.md`
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
