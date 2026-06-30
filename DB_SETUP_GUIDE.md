# DB構築ガイド（はじめて向け）

最終更新: 2026-06-25

この資料は、「このシステムで、どのDBを、どこで、どう確認するか」を短くまとめた手順書です。

## 1. まず結論（何を構築するか）

このシステムで構築するDBは、次の構成です。

- DBサービス: Google Cloud SQL for PostgreSQL
- PostgreSQLバージョン: 18
- Cloud SQLインスタンス名: kanade-portal-pg
- データベース名: kanade_portal
- アプリ接続ユーザー: kanade_app
- パスワード保管先: Secret Manager（kanade-portal-db-password）
- スキーマ定義: PostgreSQL 側に適用済み

補足:
- 業務データの参照先は Cloud SQL（PostgreSQL）です。
- JSON や移行用SQLはこの手順では扱いません。

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
7. DB接続確認
8. Cloud RunにDB接続設定を入れてデプロイ
9. 稼働確認

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

### 4.7 DB接続を確認

DBスキーマは適用済みです。ここでは接続だけ確認します。

```bash
gcloud sql connect kanade-portal-pg --user=kanade_app --database=kanade_portal
```

psql で次を実行します。

```sql
\dt
```

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

### 4.9 稼働を確認

接続できたら、主要テーブルの件数だけ確認します。

```bash
gcloud sql connect kanade-portal-pg --user=kanade_app --database=kanade_portal
```

psql で次を実行:

```sql
\dt
SELECT COUNT(*) FROM performances;
SELECT COUNT(*) FROM members;
```

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

### 5.9 DB確認

Cloud Shell または Cloud SQL Studio では、既存テーブル一覧だけを確認します。

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

### 6.4 Cloud Run未接続時のローカル検証（必須）

Cloud Run に接続できない環境でも、次の手順で「DB移行後に必要な品質ゲート」を先に確認できます。

#### 6.4.1 実行前準備

```bash
uv sync
```

Windows 環境で文字コード由来のエラーを避けるため、実行時は UTF-8 モードを有効化してください。

PowerShell 例:

```powershell
$env:PYTHONUTF8='1'
```

#### 6.4.2 構文チェック

```bash
uv run python -m compileall -q src tests
```

合格基準:
- エラー 0 件

#### 6.4.3 バックエンド回帰テスト（DBモード含む）

```bash
uv run --with pytest pytest -q tests/backend tests/integration/backend tests/operations
```

合格基準:
- 失敗 0 件

#### 6.4.4 データ整合性ゲート（orphan 必須）

```bash
uv run --with pytest pytest -q tests/operations -k op_api_005_orphan_integrity_gate
```

合格基準:
- `/api/maintenance/orphans` の結果が `total=0`
- このケースが失敗するコミットはデプロイ不可

#### 6.4.5 DB設定確認

DB期待環境では、接続先と認証情報が正しく設定されていることだけ確認します。

補足:
- 実クラウド疎通（Cloud Run URL / Cloud SQL 実接続）は、接続可能な環境で 6.1〜6.3 の確認を追加実施してください。

#### 6.4.6 Node/npm が使えない環境の代替確認

ローカルで `npm run check:frontend:syntax` を実行できない場合は、次を必須ゲートにしてください。

確認項目:
- backend / integration / operations テストが成功していること（6.4.3）
- orphan 整合性ゲートが成功していること（6.4.4）
- PR の GitHub Actions で frontend syntax check が成功していること

補足:
- frontend syntax check は CI の `frontend-tests` ジョブで `npm run check:frontend:syntax` を実行します。
- Node 未導入環境では、ローカル代替としてこの CI 成功をデプロイ必須条件にします。

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

- [ ] Cloud SQL Studio または Cloud Shell でテーブル一覧を確認した結果画面
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
- [ ] テーブル一覧画面

### 7.8 事前完成（Cloud Run未接続時に先に埋める項目）

Cloud Run に接続できない期間でも、監査チェックリストの一部は先に完了できます。

先行して完了できる項目:
- [ ] 7.1 の「プロジェクト選択」「API有効化」
- [ ] 7.2 の「Cloud SQLインスタンス」「DB」「ユーザー」
- [ ] 7.3 の「Secret存在」「最新バージョン」
- [ ] 7.4 の「IAMロール付与」
- [ ] 6.4 のローカル品質ゲート（構文チェック / backend回帰 / orphan整合性 / Node未導入時のCI代替確認）

接続可能になってから完了する項目:
- [ ] 7.5 の Cloud Run DB接続設定証跡
- [ ] 7.6 のスキーマ適用証跡（Cloud SQL Studio / Cloud Shell 実行結果）
- [ ] 7.7 の最小セットで未完了の Cloud Run / テーブル一覧系

運用手順:
1. 先行完了できる項目は、`CLOUD_RUN_INITIAL_CHECKLIST_LOG.md` の該当行に証跡（コマンド結果やスクショファイル名）を先に記録する。
2. 未接続で実施できない項目は判定を `N/A（接続待ち）` として一時記録する。
3. 接続可能になったタイミングで `N/A（接続待ち）` の行だけを再実施し、最終判定を `OK/NG` に更新する。

## 8. つまずきやすい点（症状別の対処）

この章は「何が起きたら、どこを見て、どう直すか」を短時間で判断するための運用メモです。

### 8.1 Cloud Run で DB 接続できない / 500 が出る

よくある原因:
- Cloud SQL 接続名の誤り
- `DB_HOST` / `DB_NAME` / `DB_USER` の設定漏れ
- `DB_PASSWORD` Secret 注入漏れ
- 実行サービスアカウントに `roles/cloudsql.client` がない

確認手順:
```bash
gcloud run services describe kanade-orchestra --region asia-northeast2 --format="yaml(spec.template.metadata.annotations,spec.template.spec.containers[0].env,spec.template.spec.serviceAccountName)"
gcloud sql instances describe kanade-portal-pg --format="yaml(name,state,connectionName)"
gcloud secrets describe kanade-portal-db-password
```

対処:
- Cloud Run の DB 接続設定（5.8）を再設定して再デプロイ
- IAM ロール付与（5.7）を再確認

### 8.2 DB が空に見える

よくある原因:
- DB 接続設定の不備
- 参照先 DB が想定と異なる

確認手順:
```bash
gcloud sql connect kanade-portal-pg --user=kanade_app --database=kanade_portal
```

psql:
```sql
\dt
SELECT COUNT(*) FROM performances;
SELECT COUNT(*) FROM members;
```

対処:
- DB 接続設定を見直す
- `\dt` と主要テーブル件数を確認する

### 8.3 ローカルで Python 実行時に文字コードエラーが出る（Windows）

症状例:
- `UnicodeDecodeError`（cp932 系）

対処:
```powershell
$env:PYTHONUTF8='1'
```

その後、次を再実行:
```bash
uv run python -m compileall -q src tests
uv run --with pytest pytest -q tests/backend tests/integration/backend tests/operations
```

### 8.4 Node/npm が無く frontend 構文チェックできない

対処方針:
- ローカル代替として 6.4.6 を適用
- CI の `frontend-tests` で `npm run check:frontend:syntax` 成功を必須化

確認:
- `CLOUD_RUN_INITIAL_CHECKLIST_LOG.md` の 0.1 P-4 に記録

### 8.5 Cloud Run 未接続で監査証跡が揃わない

対処方針:
- 7.8 の「事前完成」を使い、先に取れる証跡を完了
- 取れない項目は `N/A（接続待ち）` で記録

更新手順:
1. 先行項目（7.1〜7.4, 6.4系）を `OK/NG` で確定
2. 接続待ち項目（7.5〜7.7 の一部）を `N/A（接続待ち）`
3. 接続可能化後に `N/A（接続待ち）` 行だけ再確認

### 8.6 最終デプロイ前の再発防止ルール

次の 3 点を満たしたコミットのみデプロイ可:
- CI 成功コミットのみデプロイ可
- 構文チェック実施
- テスト実行（backend / integration / operations）

## 9. 元資料（詳細版）

- CLOUD_RUN_DEPLOYMENT.md
- CLOUD_RUN_INITIAL_CHECKLIST.md
- SYSTEM_DESIGN.md
- db/postgresql_table_spec.md
- db/postgresql_table_layout.md
