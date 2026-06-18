# Google Cloud Run デプロイ設定

## 環境変数設定（必須）

Cloud Run にデプロイする際、以下の環境変数を設定してください。

### Google Cloud プロジェクト設定

```bash
gcloud run deploy kanade-portal \
  --image gcr.io/kanade-orchestra/kanade-portal \
  --set-env-vars GOOGLE_CLOUD_PROJECT=kanade-orchestra \
  --set-env-vars GOOGLE_CLOUD_STORAGE_BUCKET=kanade-storage \
  --set-env-vars GOOGLE_CLOUD_STORAGE_DATA_PREFIX=app-data \
  --set-env-vars GOOGLE_CLOUD_STORAGE_PUBLIC=false \
  --region asia-northeast1
```

### 環境変数一覧

| 変数名 | 値 | 説明 |
|---|---|---|
| GOOGLE_CLOUD_PROJECT | kanade-orchestra | Google Cloud プロジェクトID |
| GOOGLE_CLOUD_STORAGE_BUCKET | kanade-storage | GCS バケット名 |
| GOOGLE_CLOUD_STORAGE_DATA_PREFIX | app-data | GCS 内のデータ接頭辞 |
| GOOGLE_CLOUD_STORAGE_PUBLIC | false | データを公開アクセス可にするか |
| GOOGLE_SERVICE_ACCOUNT_JSON | (自動) | Cloud Run のサービスアカウントで取得（設定不要） |

### サービスアカウント権限

Cloud Run に割り当てるサービスアカウントに以下の権限が必要です：

- roles/storage.objectAdmin（GCS バケット kanade-storage へのフルアクセス）
- roles/datastore.user（Firestore を使う場合）

## デプロイ手順

### 1. Docker イメージをビルド・プッシュ

```bash
gcloud builds submit --tag gcr.io/kanade-orchestra/kanade-portal
```

### 2. Cloud Run にデプロイ

```bash
gcloud run deploy kanade-portal \
  --image gcr.io/kanade-orchestra/kanade-portal \
  --platform managed \
  --region asia-northeast1 \
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

1. CloudSQL コンソール または Cloud Storage の `app-data` フォルダで以下ファイルが存在するか確認：
   - `org_settings.json`
   - `connection_settings.json`
   - `members.json`

2. 存在しない場合は、ローカルの対応ファイルを GCS へ手動でアップロード：

```bash
gsutil cp src/data/org_settings.json gs://kanade-storage/app-data/
gsutil cp src/data/members.json gs://kanade-storage/app-data/
```

3. Cloud Run のサービスアカウント権限を確認：

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
変更後、自動的に `connection_settings.json` が GCS に保存されます。
