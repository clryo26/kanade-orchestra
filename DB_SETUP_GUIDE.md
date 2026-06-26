# DB構築ガイド（はじめて向け）

最終更新: 2026-06-25

この資料は、「このシステムで、どのDBを、どこで、どう作るか」を1本で理解できるようにまとめた手順書です。

## 1. まず結論（何を構築するか）

このシステムで構築するDBは、次の構成です。

- DBサービス: Google Cloud SQL for PostgreSQL
- PostgreSQLバージョン: 18
- Cloud SQLインスタンス名: kanade-portal-pg
- データベース名: kanade_portal
- アプリ接続ユーザー: kanade_app
- パスワード保管先: Secret Manager（kanade-portal-db-password）
- スキーマ定義ファイル: db/postgresql_schema.sql

補足:
- 現行実装は JSON ストレージも併用中です。
- ただし、DB移行対象の業務データは Cloud SQL（PostgreSQL）側に作る前提です。

## 2. どこから作るか（作業場所）

作業場所は次の2つです。

1. ローカル端末のターミナル（gcloud CLI を実行）
2. Google Cloud（Cloud SQL / Secret Manager / Cloud Run）

必要ツール:
- gcloud CLI（Google Cloud SDK）
- psql クライアント（スキーマ適用時に使用）

## 3. 全体の流れ

1. gcloudログインとプロジェクト設定
2. 必要API有効化
3. Cloud SQLインスタンス作成
4. DB作成
5. DBユーザー作成
6. DBパスワードをSecret Managerに登録
7. スキーマ適用（db/postgresql_schema.sql）
8. Cloud RunにDB接続設定を入れてデプロイ
9. 接続確認
10. JSONデータをDBへ移行

## 4. 手順（そのまま実行）

### 4.1 gcloudログインとプロジェクト設定

```bash
gcloud auth login
gcloud config set project kanade-orchestra
```

### 4.2 必要APIを有効化

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com storage.googleapis.com
```

### 4.3 Cloud SQLインスタンスを作成

```bash
gcloud sql instances create kanade-portal-pg \
  --database-version=POSTGRES_18 \
  --cpu=2 \
  --memory=8GB \
  --region=asia-northeast2
```

### 4.4 DBを作成

```bash
gcloud sql databases create kanade_portal \
  --instance=kanade-portal-pg
```

### 4.5 アプリ接続ユーザーを作成

```bash
gcloud sql users create kanade_app \
  --instance=kanade-portal-pg \
  --password='REPLACE_WITH_STRONG_PASSWORD'
```

### 4.6 DBパスワードをSecret Managerに登録

初回作成:

```bash
echo -n 'REPLACE_WITH_STRONG_PASSWORD' | gcloud secrets create kanade-portal-db-password --data-file=-
```

更新時:

```bash
echo -n 'REPLACE_WITH_STRONG_PASSWORD' | gcloud secrets versions add kanade-portal-db-password --data-file=-
```

### 4.7 スキーマを適用

まずDBへ接続します。

```bash
gcloud sql connect kanade-portal-pg --user=kanade_app --database=kanade_portal
```

psqlプロンプトで、次を実行します。

```sql
\i db/postgresql_schema.sql
```

注意:
- 実行ディレクトリは、このリポジトリのルートに合わせてください。
- 上記でパスが解決できない場合は、絶対パスで指定してください。

### 4.8 Cloud RunにDB接続設定を入れてデプロイ

```bash
gcloud run deploy kanade-orchestra \
  --image gcr.io/kanade-orchestra/kanade-portal \
  --platform managed \
  --region asia-northeast2 \
  --allow-unauthenticated \
  --add-cloudsql-instances kanade-orchestra:asia-northeast2:kanade-portal-pg \
  --set-env-vars GOOGLE_CLOUD_PROJECT=kanade-orchestra,GOOGLE_CLOUD_STORAGE_BUCKET=kanade-storage,GOOGLE_CLOUD_STORAGE_DATA_PREFIX=app-data,GOOGLE_CLOUD_STORAGE_PUBLIC=false,DB_HOST=/cloudsql/kanade-orchestra:asia-northeast2:kanade-portal-pg,DB_PORT=5432,DB_NAME=kanade_portal,DB_USER=kanade_app \
  --set-secrets DB_PASSWORD=kanade-portal-db-password:latest
```

### 4.9 JSONデータをDBへ移行

前提:
- すでに `db/postgresql_schema.sql` 適用済み
- このリポジトリのルートでコマンド実行

```bash
uv sync
```

ローカルから Cloud SQL に接続できる構成（Public IP許可済み、またはCloud SQL Auth Proxy利用）で次を実行します。

```bash
uv run python scripts/migrate_json_to_postgres.py \
  --db-host REPLACE_DB_HOST \
  --db-port 5432 \
  --db-name kanade_portal \
  --db-user kanade_app \
  --db-password 'REPLACE_WITH_STRONG_PASSWORD' \
  --truncate
```

Cloud Run の Unix Domain Socket 経由（`/cloudsql/...`）で接続できる環境の場合は `--db-host` に `/cloudsql/kanade-orchestra:asia-northeast2:kanade-portal-pg` を指定します。

安全確認だけ先に行う場合:

```bash
uv run python scripts/migrate_json_to_postgres.py \
  --db-host REPLACE_DB_HOST \
  --db-port 5432 \
  --db-name kanade_portal \
  --db-user kanade_app \
  --db-password 'REPLACE_WITH_STRONG_PASSWORD' \
  --dry-run
```

注意:
- `--truncate` は既存DBデータを全削除して再投入します（初回移行時に推奨）。
- まず `--dry-run` で件数確認し、その後 `--truncate` 付き本実行を推奨します。
- 移行スクリプトは本実行後に「JSON件数 vs DB件数」の自動照合を実施し、`RECONCILIATION_RESULT: MATCHED/MISMATCH` を出力します。

手動での再確認（任意）:

```bash
gcloud sql connect kanade-portal-pg --user=kanade_app --database=kanade_portal
```

psql で次を実行:

```sql
\i db/post_migration_count_check.sql
```

確認ポイント:
- 各テーブル件数が、移行スクリプトの `Migration row counts` / `Reconciliation` 出力と一致すること。

## 5. 手順（画面操作だけで作る版 / Cloud Console中心）

この章は、原則として Google Cloud Console の画面操作だけで構築する手順です。

### 5.1 プロジェクト選択

1. Google Cloud Console を開く
2. 画面上部のプロジェクト選択で `kanade-orchestra` を選ぶ

### 5.2 必要APIを有効化

1. 左メニューから「APIとサービス」→「ライブラリ」を開く
2. 次のAPIを1つずつ検索して「有効にする」を押す
  - Cloud Run Admin API
  - Cloud Build API
  - Cloud SQL Admin API
  - Secret Manager API
  - Cloud Storage API

### 5.3 Cloud SQLインスタンスを作成

1. 左メニューから「SQL」を開く
2. 「インスタンスを作成」→「PostgreSQL」を選択
3. 以下を設定して作成
  - インスタンスID: `kanade-portal-pg`
  - PostgreSQLバージョン: `PostgreSQL 18`
  - リージョン: `asia-northeast2`
  - マシン構成: 2 vCPU / 8GB 相当（CLI定義と同等）

### 5.4 データベースを作成

1. 作成した `kanade-portal-pg` を開く
2. 「データベース」タブを開く
3. 「データベースを作成」で次を入力
  - データベース名: `kanade_portal`

### 5.5 DBユーザーを作成

1. 同じインスタンスで「ユーザー」タブを開く
2. 「ユーザーアカウントを追加」を選択
3. 次を入力して作成
  - ユーザー名: `kanade_app`
  - パスワード: 強力なパスワードを設定

### 5.6 Secret ManagerにDBパスワードを登録

1. 左メニューから「Security」→「Secret Manager」を開く
2. 「シークレットを作成」を押す
3. 次を入力して作成
  - 名前: `kanade-portal-db-password`
  - シークレット値: 5.5 で設定した `kanade_app` のパスワード

### 5.7 Cloud Runサービスアカウントに権限を付与

1. 「Cloud Run」→ サービス `kanade-orchestra` を開く
2. 「リビジョン」または「編集とデプロイ」画面で実行サービスアカウントを確認
3. 「IAMと管理」→「IAM」で対象サービスアカウントに次のロールを付与
  - Cloud SQL Client (`roles/cloudsql.client`)
  - Secret Manager Secret Accessor (`roles/secretmanager.secretAccessor`)
  - Storage Object Admin (`roles/storage.objectAdmin`)

### 5.8 Cloud RunにDB接続設定を入れる

1. 「Cloud Run」→ `kanade-orchestra` →「編集して新しいリビジョンをデプロイ」を開く
2. 「接続」または「Cloud SQL接続」で次を設定
  - 接続先インスタンス: `kanade-orchestra:asia-northeast2:kanade-portal-pg`
3. 「変数とシークレット」で環境変数を設定
  - `DB_HOST=/cloudsql/kanade-orchestra:asia-northeast2:kanade-portal-pg`
  - `DB_PORT=5432`
  - `DB_NAME=kanade_portal`
  - `DB_USER=kanade_app`
4. 同画面でシークレットを追加
  - 環境変数名: `DB_PASSWORD`
  - シークレット: `kanade-portal-db-password`
  - バージョン: `latest`
5. デプロイを実行

### 5.9 スキーマを適用（テーブル作成）

画面操作だけでは `db/postgresql_schema.sql` の直接投入が難しいため、ここだけ次のいずれかを使います。

方法A（推奨）:
1. Cloud Shell を開く（Console右上の `>_` アイコン）
2. リポジトリと `db/postgresql_schema.sql` を参照できる場所で、`psql` または `gcloud sql connect` を使って接続
3. SQLファイルを実行してテーブル作成

方法B:
1. Cloud SQL Studio（利用可能な環境のみ）を開く
2. `db/postgresql_schema.sql` の内容を貼り付けて実行

注意:
- この手順だけは「完全ノーCLI」にしづらいポイントです。
- ただしCloud Shellを使えば、ローカルPCのCLI準備なしで進められます。

## 6. 構築後チェック

### 6.1 インスタンス状態

```bash
gcloud sql instances describe kanade-portal-pg --format="yaml(name,state,connectionName,region,databaseVersion)"
```

確認ポイント:
- state が RUNNABLE
- connectionName が kanade-orchestra:asia-northeast2:kanade-portal-pg

### 6.2 DB / ユーザー存在

```bash
gcloud sql databases list --instance=kanade-portal-pg
gcloud sql users list --instance=kanade-portal-pg
```

### 6.3 Cloud RunのDB接続設定

```bash
gcloud run services describe kanade-orchestra --region asia-northeast2 --format="yaml(spec.template.metadata.annotations,spec.template.spec.containers[0].env)"
```

確認ポイント:
- add-cloudsql-instances が設定済み
- DB_HOST, DB_PORT, DB_NAME, DB_USER が設定済み
- DB_PASSWORD が Secret 参照

## 7. 監査向けスクショ取得ポイント一覧

監査や引き継ぎで「構築した事実」を示しやすい画面を、取得推奨順に並べています。
ファイル名は日付付きで保存すると追跡しやすくなります（例: `2026-06-25_03-2_cloudsql-instance.png`）。

### 7.1 プロジェクトとAPI有効化

- [ ] プロジェクト選択ドロップダウン（`kanade-orchestra` が見えている状態）
- [ ] APIとサービス > 有効なAPIとサービス の一覧
- [ ] 次のAPIが有効であることが分かる画面
  - Cloud Run Admin API
  - Cloud Build API
  - Cloud SQL Admin API
  - Secret Manager API
  - Cloud Storage API

### 7.2 Cloud SQL 構築証跡

- [ ] SQL > インスタンス一覧（`kanade-portal-pg` の行）
- [ ] `kanade-portal-pg` の概要画面
  - バージョン: PostgreSQL 18
  - リージョン: asia-northeast2
  - 状態: RUNNABLE
  - 接続名: kanade-orchestra:asia-northeast2:kanade-portal-pg
- [ ] `kanade-portal-pg` > データベースタブ（`kanade_portal` の存在）
- [ ] `kanade-portal-pg` > ユーザータブ（`kanade_app` の存在）

### 7.3 Secret Manager 証跡

- [ ] Secret Manager 一覧（`kanade-portal-db-password` の存在）
- [ ] Secret詳細画面
  - 最新バージョンが存在すること
  - 有効状態であること

注意:
- Secretの値（平文）はスクショに含めないでください。

### 7.4 IAM 権限証跡

- [ ] Cloud Run `kanade-orchestra` のサービス詳細（実行サービスアカウントが分かる画面）
- [ ] IAM一覧で対象サービスアカウントのロールが確認できる画面
  - roles/cloudsql.client
  - roles/secretmanager.secretAccessor
  - roles/storage.objectAdmin

### 7.5 Cloud Run DB接続設定証跡

- [ ] Cloud Run > `kanade-orchestra` > 最新リビジョンの設定画面
  - Cloud SQL接続に `kanade-orchestra:asia-northeast2:kanade-portal-pg`
- [ ] 環境変数の設定画面
  - DB_HOST, DB_PORT, DB_NAME, DB_USER が見える
- [ ] シークレット設定画面
  - DB_PASSWORD -> `kanade-portal-db-password:latest`

### 7.6 スキーマ適用証跡

- [ ] Cloud SQL Studio または Cloud Shell で `db/postgresql_schema.sql` を実行した結果画面
- [ ] テーブル一覧画面（主要テーブルが作成済みと分かる画面）
  - performances
  - members
  - schedules
  - announcements
  - events

### 7.7 監査提出向けの最小セット（これだけは必須）

- [ ] Cloud SQLインスタンス概要（接続名とRUNNABLEが見える）
- [ ] DB / ユーザーの存在画面
- [ ] Secret存在と最新バージョン画面
- [ ] Cloud RunのDB接続設定画面（環境変数 + Secret）
- [ ] スキーマ適用後のテーブル一覧画面

## 8. つまずきやすい点

- DB自体は「Cloud SQL」で作る。ローカルにPostgreSQLサーバーを立てる想定ではない。
- DBユーザーのパスワードは、Cloud Runの環境変数へ直接平文で入れない。Secret Manager経由で注入する。
- テーブル作成は自動ではない。db/postgresql_schema.sql の適用が必要。
- 既存のJSON保存は完全廃止ではないため、機能によって参照先が異なる期間がある。

## 9. 元資料（詳細版）

- CLOUD_RUN_DEPLOYMENT.md
- CLOUD_RUN_INITIAL_CHECKLIST.md
- SYSTEM_DESIGN.md
- db/postgresql_schema.sql
- db/postgresql_table_spec.md
- db/postgresql_table_layout.md
