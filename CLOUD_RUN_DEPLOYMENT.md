# Google Cloud Run デプロイ設定

## 環境変数設定（必須）

Cloud Run にデプロイする際、以下の環境変数を設定してください。

### Google Cloud プロジェクト設定

```bash
gcloud run deploy kanade-orchestra \
  --image gcr.io/kanade-orchestra/kanade-portal \
  --set-env-vars GOOGLE_CLOUD_PROJECT=kanade-orchestra \
  --set-env-vars GOOGLE_CLOUD_STORAGE_BUCKET=kanade-storage \
  --set-env-vars GOOGLE_CLOUD_STORAGE_DATA_PREFIX=app-data \
  --set-env-vars GOOGLE_CLOUD_STORAGE_PUBLIC=false \
  --region asia-northeast2
```

### 環境変数一覧

| 変数名 | 値 | 説明 |
|---|---|---|
| GOOGLE_CLOUD_PROJECT | kanade-orchestra | Google Cloud プロジェクトID |
| GOOGLE_CLOUD_STORAGE_BUCKET | kanade-storage | GCS バケット名 |
| GOOGLE_CLOUD_STORAGE_DATA_PREFIX | app-data | GCS 内のデータ接頭辞 |
| GOOGLE_CLOUD_STORAGE_PUBLIC | false | データを公開アクセス可にするか |
| GOOGLE_SERVICE_ACCOUNT_JSON | (自動) | Cloud Run のサービスアカウントで取得（設定不要） |
| K_REVISION | (自動) | Cloud Run が自動設定するリビジョン名（UI では `00060-hsf` 形式に短縮表示） |
| CLOUD_RUN_REVISION | 任意 | 旧設定互換用。`K_REVISION` がない場合のみ参照 |

### サービスアカウント権限

Cloud Run に割り当てるサービスアカウントに以下の権限が必要です：

- roles/storage.objectAdmin（GCS バケット kanade-storage へのフルアクセス）
- roles/datastore.user（Firestore を使う場合）

## デプロイ手順

### 0. デプロイ前チェック（必須）

本番反映前に、最低でも次を満たしてください。

- GitHub Actions の CI が最新コミットで成功していること（frontend syntax check を含む）
- ローカルで可能な範囲の構文・テスト確認を実施済みであること
- デプロイ対象コミットは、CI 成功が確認できるコミット SHA のみを許可すること
- 運用API整合性チェック（`GET /api/maintenance/orphans`）で `total=0` が確認できること

禁止事項:

- CI 未実行コミットのデプロイ
- CI 失敗コミットのデプロイ
- CI 結果未確認のままのデプロイ

推奨コマンド（ローカル）:

```bash
# Python 構文チェック
python -m compileall -q src tests

# Python テスト
uv run pytest -q tests/backend tests/integration/backend tests/operations

# データ整合性（orphan）必須ゲート
uv run pytest -q tests/operations -k op_api_005_orphan_integrity_gate

# Node がある環境ではフロント構文チェックも実施
npm run check:frontend:syntax
```

※ Node/npm が無い環境では、PR 作成後に CI の frontend syntax check 成功を必須ゲートとして扱ってください。

運用ルール（固定）:

- Cloud Run への本番デプロイは「CI 成功コミットのみデプロイ可」とする
- 例外運用は行わない（緊急時も先に最小修正で CI を通してからデプロイする）
- 運用データは DB Only（PostgreSQL）を前提とし、`src/data/*.json` を本番データソースにしない

### 1. Docker イメージをビルド・プッシュ

```bash
gcloud builds submit --tag gcr.io/kanade-orchestra/kanade-portal
```

### 2. Cloud Run にデプロイ

```bash
gcloud run deploy kanade-orchestra \
  --image gcr.io/kanade-orchestra/kanade-portal \
  --platform managed \
  --region asia-northeast2 \
  --set-env-vars GOOGLE_CLOUD_PROJECT=kanade-orchestra \
  --set-env-vars GOOGLE_CLOUD_STORAGE_BUCKET=kanade-storage \
  --set-env-vars GOOGLE_CLOUD_STORAGE_DATA_PREFIX=app-data \
  --set-env-vars GOOGLE_CLOUD_STORAGE_PUBLIC=false \
  --allow-unauthenticated
```

### 3. デプロイ後の確認

デプロイ完了後、管理画面の「システム管理 > 接続先情報」で以下が表示されることを確認：
- Google プロジェクト ID: kanade-orchestra
- GCS バケット名: kanade-storage

## トラブルシューティング

### ポータル名が「楽団ポータル」のまま、メニューが表示されない

1. Cloud SQL の `org_settings` / `members` テーブルに初期データが存在するか確認する。
2. `connection_settings` テーブルが空の場合は管理画面の「接続先情報」から登録する。
3. Cloud Run のサービスアカウント権限を確認する。

```bash
gcloud projects get-iam-policy kanade-orchestra \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:*@cloudrun.gserviceaccount.com"
```

### GCS へのアクセスが 403 エラー

- サービスアカウントに `roles/storage.objectAdmin` 権限があるか確認
- バケット名が正確に「kanade-storage」か確認

## 接続設定の API 管理

管理画面から「システム管理 > 接続先情報」で動的に変更可能です。
変更後、接続先情報は DB に保存されます。

## PostgreSQL 運用版（Cloud Run + Cloud SQL）

Version 5.1 以降は Cloud SQL for PostgreSQL を正として運用します。

初回構築時の確認項目は `CLOUD_RUN_INITIAL_CHECKLIST.md` を参照してください。

### 採用する実環境値

| 項目 | 値 |
|---|---|
| Google Cloud プロジェクトID | kanade-orchestra |
| Cloud Run サービス名 | kanade-orchestra |
| Cloud Storage バケット名 | kanade-storage |
| リージョン | asia-northeast2 |
| Cloud SQL 接続名 | kanade-orchestra:asia-northeast2:kanade-portal-pg |
| DB名 | kanade_portal |
| DBユーザー | kanade_app |
| Secret Manager (DBパスワード) | kanade-portal-db-password |

### 1. Cloud SQL インスタンス作成（初回のみ）

```bash
gcloud sql instances create kanade-portal-pg \
  --database-version=POSTGRES_18 \
  --cpu=2 \
  --memory=8GB \
  --region=asia-northeast2

gcloud sql databases create kanade_portal \
  --instance=kanade-portal-pg

gcloud sql users create kanade_app \
  --instance=kanade-portal-pg \
  --password='REPLACE_WITH_STRONG_PASSWORD'
```

### 2. Secret Manager 登録（初回のみ）

```bash
echo -n 'REPLACE_WITH_STRONG_PASSWORD' | gcloud secrets create kanade-portal-db-password --data-file=-
```

既存 Secret を更新する場合:

```bash
echo -n 'REPLACE_WITH_STRONG_PASSWORD' | gcloud secrets versions add kanade-portal-db-password --data-file=-
```

### 3. Cloud Run サービスアカウント権限（初回のみ）

- roles/cloudsql.client
- roles/secretmanager.secretAccessor
- roles/storage.objectAdmin

### 4. Docker イメージをビルド

```bash
gcloud builds submit --tag gcr.io/kanade-orchestra/kanade-portal
```

### 5. Cloud Run へデプロイ（PostgreSQL接続あり）

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

### 6. デプロイ後確認

1. Cloud Run URL のヘルスチェックが成功すること
2. 管理画面の「接続先情報」が従来どおり表示されること
3. DB接続を使う機能（移行対象API）で 500 が発生しないこと
4. サイドメニューの Rev. 表示が最新リビジョンに更新されること
