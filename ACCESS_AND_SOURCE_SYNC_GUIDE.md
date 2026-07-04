# アクセス情報・ソース同期運用ガイド

最終更新: 2026-06-26

この資料は、個人用PCと会社PCの2つの開発環境で、AIと人間が同じ前提を読んで作業できるようにするための運用メモです。
GitHub、Google Cloud / Google Sites / Google Storage、ローカル開発、ソースプッシュ方法をここに集約します。

## 1. 基本方針

- このリポジトリには、秘密情報そのものを保存しない。
- 共有してよい値はこの資料へ記載する。
- パスワード、トークン、サービスアカウントJSON、OAuthクライアントシークレット、DBパスワードは各PCまたはGoogle Secret Managerに保存する。
- 個人用PCと会社PCのどちらでも、作業開始時は `git pull` で最新化してから変更する。
- デプロイは「CI成功コミットのみ」を対象にする。

## 2. 共有してよい実環境値

| 項目 | 値 |
|---|---|
| GitHubリポジトリ | `https://github.com/clryo26/kanade-orchestra.git` |
| Git remote名 | `origin` |
| Google Cloud プロジェクトID | `kanade-orchestra` |
| Cloud Run サービス名 | `kanade-orchestra` |
| Cloud Run リージョン | `asia-northeast2` |
| Container image | `gcr.io/kanade-orchestra/kanade-portal` |
| GCSバケット | `kanade-storage` |
| GCSデータ接頭辞 | `app-data` |
| GCS公開設定 | `GOOGLE_CLOUD_STORAGE_PUBLIC=false` |
| Cloud SQL インスタンス | `kanade-portal-pg` |
| Cloud SQL 接続名 | `kanade-orchestra:asia-northeast2:kanade-portal-pg` |
| DB名 | `kanade_portal` |
| DBユーザー | `kanade_app` |
| DBパスワードSecret | `kanade-portal-db-password` |

## 3. 絶対にGitへ入れないもの

以下は `.gitignore` の対象またはSecret Manager管理にする。

| 種類 | 保存場所 |
|---|---|
| GitHub Personal Access Token | Windows資格情報マネージャー、Git Credential Manager、またはGitHub CLI |
| Googleログイン情報 | `gcloud auth login` のローカル認証キャッシュ |
| Application Default Credentials | `gcloud auth application-default login` のローカル認証キャッシュ |
| サービスアカウントJSON | `credentials/` 配下など、Git管理外 |
| DBパスワード | Google Secret Manager `kanade-portal-db-password` |
| OAuthクライアントシークレット | `.env` またはSecret Manager |
| ローカル環境変数 | `.env`, `.env.local`, `.env.*.local` |

AIへの注意:
- 秘密情報の中身を表示、記録、コミット、ログ貼り付けしない。
- 認証エラー調査では、値そのものではなく「存在するか」「参照名が合っているか」「権限があるか」を確認する。

## 4. 各PCの初回セットアップ

PowerShellで実行する。

```powershell
# UV
$ProgressPreference = 'SilentlyContinue'
irm https://astral.sh/uv/install.ps1 | iex

# GitHub CLI（未導入の場合）
winget install --id GitHub.cli

# Google Cloud CLI（未導入の場合）
winget install --id Google.CloudSDK
```

リポジトリを取得する。

```powershell
git clone https://github.com/clryo26/kanade-orchestra.git
cd kanade-orchestra
uv sync
```

既存フォルダを使う場合は、remoteを確認する。

```powershell
git remote -v
git status
```

期待値:

```text
origin  https://github.com/clryo26/kanade-orchestra.git (fetch)
origin  https://github.com/clryo26/kanade-orchestra.git (push)
```

## 5. GitHubアクセス方法

推奨はGitHub CLIまたはGit Credential Managerを使う方法。

```powershell
gh auth login
gh auth status
```

会社PCでブラウザ認証や端末制限がある場合は、会社のルールに従ってHTTPS認証を設定する。
Personal Access Tokenを使う場合も、トークン文字列は資料やコミットへ残さない。

## 6. Googleサービスへのアクセス方法

Google Cloudを操作するPCでは、次を実行する。

```powershell
gcloud auth login
gcloud config set project kanade-orchestra
gcloud config get-value project
```

ローカルからGoogle Cloud Storageなどのクライアントライブラリを直接試す場合だけ、Application Default Credentialsを設定する。

```powershell
gcloud auth application-default login
```

必要API:

```powershell
gcloud services enable run.googleapis.com cloudbuild.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com storage.googleapis.com
```

Google Sitesは、Cloud Runの公開URLを埋め込み先として使う。
詳細は `GOOGLE_DEPLOY.md` を参照する。

## 7. 作業開始時の共通手順

2台のPCを行き来するため、作業前に必ず最新化する。

```powershell
git status
git pull --ff-only origin main
uv sync
```

未コミット変更がある場合は、先に内容を確認する。

```powershell
git status --short
git diff
```

別PCで作業を続ける前には、前のPCで必ずpushまで終える。

## 7.1 ChatGPT情報源向け共有ZIP

個人PCと会社PCの間で、Git以外に ChatGPT 情報源を使って安全にソース受け渡しする場合は、共有用ZIPを使用する。

```powershell
.\scripts\create-source-zip.ps1
```

詳細は [docs/SOURCE_SHARE_ZIP.md](docs/SOURCE_SHARE_ZIP.md) を参照する。

## 8. ソース変更からGitHub pushまで

```powershell
git status --short
git diff

# Python構文チェック
uv run python -m compileall -q src tests

# Pythonテスト
uv run pytest -q tests/backend tests/integration/backend tests/operations

# Node/npmが使える場合のフロント構文チェック
npm run check:frontend:syntax

git add .
git commit -m "変更内容を短く書く"
git push origin main
```

フロントの依存関係が未導入の場合:

```powershell
npm install
npm run check:frontend:syntax
```

コミット前に確認すること:

- 不要なローカルファイル、ログ、認証情報が入っていない。
- 実装変更に対応する設計書を更新している。
- 構文チェックとテストを実行している。
- GitHub ActionsでCIが成功している。

## 9. Cloud Runへのデプロイ

デプロイ前の固定ルール:

- CI成功コミットのみデプロイ可。
- 構文チェック実施。
- テスト実行。
- CI未実行、CI失敗、CI結果未確認のコミットはデプロイしない。

ビルド:

```powershell
gcloud builds submit --tag gcr.io/kanade-orchestra/kanade-portal
```

Cloud SQL接続ありのCloud Runデプロイ:

```powershell
gcloud run deploy kanade-orchestra `
  --image gcr.io/kanade-orchestra/kanade-portal `
  --platform managed `
  --region asia-northeast2 `
  --allow-unauthenticated `
  --add-cloudsql-instances kanade-orchestra:asia-northeast2:kanade-portal-pg `
  --set-env-vars GOOGLE_CLOUD_PROJECT=kanade-orchestra,GOOGLE_CLOUD_STORAGE_BUCKET=kanade-storage,GOOGLE_CLOUD_STORAGE_DATA_PREFIX=app-data,GOOGLE_CLOUD_STORAGE_PUBLIC=false,DB_HOST=/cloudsql/kanade-orchestra:asia-northeast2:kanade-portal-pg,DB_PORT=5432,DB_NAME=kanade_portal,DB_USER=kanade_app `
  --set-secrets DB_PASSWORD=kanade-portal-db-password:latest
```

デプロイ後確認:

```powershell
gcloud run services describe kanade-orchestra --region asia-northeast2 --format="yaml(status.latestReadyRevisionName,status.url)"
```

## 10. ローカル開発用の環境変数

通常のローカル起動は、クラウド認証情報なしでもローカルJSON保存で動作確認できる。
クラウド連携を試す場合は `.env.local` などGit管理外のファイルか、PowerShellの環境変数で設定する。

```powershell
$env:GOOGLE_CLOUD_PROJECT = "kanade-orchestra"
$env:GOOGLE_CLOUD_STORAGE_BUCKET = "kanade-storage"
$env:GOOGLE_CLOUD_STORAGE_DATA_PREFIX = "app-data"
$env:GOOGLE_CLOUD_STORAGE_PUBLIC = "false"
```

サービスアカウントJSONを使う場合は `credentials/` 配下に置き、パスを環境変数で指定する。
ただし、Cloud Run本番ではサービスアカウント自体の権限で動かすため、JSONキーの利用はローカル検証に限定する。

## 11. トラブル時の確認コマンド

GitHub:

```powershell
git remote -v
git status
gh auth status
```

Google Cloud:

```powershell
gcloud auth list
gcloud config get-value project
gcloud run services describe kanade-orchestra --region asia-northeast2 --format="yaml(status.url,status.latestReadyRevisionName)"
gcloud secrets describe kanade-portal-db-password
gcloud sql instances describe kanade-portal-pg --format="yaml(name,state,connectionName,region,databaseVersion)"
```

Cloud Runの環境変数とSecret参照:

```powershell
gcloud run services describe kanade-orchestra --region asia-northeast2 --format="yaml(spec.template.metadata.annotations,spec.template.spec.containers[0].env)"
```

## 12. 関連資料

- `DB_SETUP_GUIDE.md`: Cloud SQL / Secret Manager / DB構築手順
- `CLOUD_RUN_DEPLOYMENT.md`: Cloud Runデプロイ手順
- `CLOUD_RUN_INITIAL_CHECKLIST.md`: 初回構築チェックリスト
- `GOOGLE_DEPLOY.md`: GCS / Google Sites公開手順
- `DESIGN_DOCS_NAVIGATION.md`: 設計書の読み順
