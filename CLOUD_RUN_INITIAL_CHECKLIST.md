# Cloud Run 初回構築チェックリスト（PostgreSQL移行版）

最終更新: 2026-06-19
実施記録テンプレート: CLOUD_RUN_INITIAL_CHECKLIST_LOG.md
対象環境:
- Google Cloud プロジェクトID: kanade-orchestra
- Cloud Run サービス名: kanade-orchestra
- リージョン: asia-northeast2
- Cloud SQL 接続名: kanade-orchestra:asia-northeast2:kanade-portal-pg
- DB名: kanade_portal
- DBユーザー: kanade_app
- Secret名（DBパスワード）: kanade-portal-db-password
- GCSバケット名: kanade-storage

## 0. 事前準備

- [ ] gcloud CLI でログイン済み（`gcloud auth login`）
- [ ] 対象プロジェクトを設定済み（`gcloud config set project kanade-orchestra`）
- [ ] 必要APIを有効化済み

確認コマンド:

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com storage.googleapis.com
```

## 1. IAM付与確認

### 1.1 Cloud Run 実行サービスアカウントを確認

- [ ] Cloud Run サービス `kanade-orchestra` の実行サービスアカウントを把握している

確認コマンド:

```bash
gcloud run services describe kanade-orchestra --region asia-northeast2 --format="value(spec.template.spec.serviceAccountName)"
```

### 1.2 必須ロールが付与されている

対象サービスアカウントに、以下ロールが付与されていること:
- [ ] roles/cloudsql.client
- [ ] roles/secretmanager.secretAccessor
- [ ] roles/storage.objectAdmin

付与コマンド例（SERVICE_ACCOUNT_EMAIL は置換）:

```bash
gcloud projects add-iam-policy-binding kanade-orchestra \
  --member="serviceAccount:SERVICE_ACCOUNT_EMAIL" \
  --role="roles/cloudsql.client"

gcloud projects add-iam-policy-binding kanade-orchestra \
  --member="serviceAccount:SERVICE_ACCOUNT_EMAIL" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding kanade-orchestra \
  --member="serviceAccount:SERVICE_ACCOUNT_EMAIL" \
  --role="roles/storage.objectAdmin"
```

## 2. Secret登録確認

### 2.1 Secret の存在確認

- [ ] Secret `kanade-portal-db-password` が存在する

確認コマンド:

```bash
gcloud secrets describe kanade-portal-db-password
```

### 2.2 最新バージョンの登録確認

- [ ] Secret に最新バージョンが存在する

確認コマンド:

```bash
gcloud secrets versions list kanade-portal-db-password
```

### 2.3 Cloud Run に Secret 注入設定がある

- [ ] Cloud Run デプロイで `DB_PASSWORD=kanade-portal-db-password:latest` を指定している

確認コマンド:

```bash
gcloud run services describe kanade-orchestra --region asia-northeast2 --format="yaml(spec.template.spec.containers[0].env)"
```

## 3. Cloud SQL疎通確認

### 3.1 Cloud SQL インスタンス状態確認

- [ ] インスタンス `kanade-portal-pg` が RUNNABLE
- [ ] 接続名が `kanade-orchestra:asia-northeast2:kanade-portal-pg`

確認コマンド:

```bash
gcloud sql instances describe kanade-portal-pg --format="yaml(name,state,connectionName,region,databaseVersion)"
```

### 3.2 DB/ユーザー確認

- [ ] DB `kanade_portal` が存在する
- [ ] ユーザー `kanade_app` が存在する

確認コマンド:

```bash
gcloud sql databases list --instance=kanade-portal-pg
gcloud sql users list --instance=kanade-portal-pg
```

### 3.3 Cloud Run 側の接続設定確認

- [ ] `--add-cloudsql-instances kanade-orchestra:asia-northeast2:kanade-portal-pg` が設定済み
- [ ] 環境変数 `DB_HOST=/cloudsql/kanade-orchestra:asia-northeast2:kanade-portal-pg` が設定済み
- [ ] 環境変数 `DB_PORT=5432`, `DB_NAME=kanade_portal`, `DB_USER=kanade_app` が設定済み

確認コマンド:

```bash
gcloud run services describe kanade-orchestra --region asia-northeast2 --format="yaml(spec.template.metadata.annotations,spec.template.spec.containers[0].env)"
```

## 4. 動作確認

- [ ] Cloud Run の最新リビジョンが Ready
- [ ] アプリにアクセスして HTTP 500 が発生しない
- [ ] 管理画面「接続先情報」が表示される
- [ ] サイドメニューの Rev. 表示が最新化される

確認コマンド:

```bash
gcloud run services describe kanade-orchestra --region asia-northeast2 --format="yaml(status.latestReadyRevisionName,status.url)"
```

## 5. デプロイ実行コマンド（再掲）

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

## 6. 再発防止ルールチェック

- [ ] CI成功コミットのみデプロイ可
- [ ] 構文チェック実施
- [ ] テスト実行（backend / integration / operations）
