# Cloud SQL → Neon 移行 実装設計書

## 1. 文書の目的

本書は、奏オケポータルのデータベースを Google Cloud SQL for PostgreSQL から Neon PostgreSQL へ移行するための実装設計を定義する。

対象は以下。

- 本番環境
- テスト環境
- Cloud Run デプロイ
- 本番→テストDB同期
- 事前バックアップ
- 接続確認
- 障害時ロールバック
- 運用ドキュメント
- 自動テスト

本書は「実装前に変更対象・変更内容・実装順序・検証条件を固定する」ことを目的とする。

---

## 2. 移行方針

### 2.1 採用方針

- Cloud Run は継続利用する。
- Cloud Storage は継続利用する。
- PostgreSQL は継続利用する。
- Cloud SQL のみ Neon へ置き換える。
- 本番DBとテストDBは Neon 上で分離する。
- アプリ実行時は Neon のプール接続URLを使用する。
- `pg_dump`、`pg_restore`、本番→テスト同期は Neon の直接接続URLを使用する。
- Cloud SQLは移行完了直後に削除せず、ロールバック期間中は保持する。

### 2.2 実測容量

| 対象 | 実測値 |
|---|---:|
| 本番DB `kanade_portal` | 約21 MiB |
| テストDB `kanade_portal_test` | 約20 MiB |
| DB合計 | 約41 MiB |
| 本番GCS | 約247 MiB |
| テストGCS | 約2.19 GiB |

DB容量はNeon Freeの容量内に十分収まる。

---

## 3. 目標構成

```text
Cloud Run 本番
    │
    └─ PROD_DB_URL（Neon pooled connection）
          │
          └─ Neon 本番DB

Cloud Run テスト
    │
    └─ TEST_DB_URL（Neon pooled connection）
          │
          └─ Neon テストDB

GitHub Actions 本番→テスト同期
    │
    ├─ PROD_DB_DIRECT_URL（Neon direct connection）
    └─ TEST_DB_DIRECT_URL（Neon direct connection）
```

Cloud Storageは現行構成を維持する。

```text
本番: gs://kanade-storage
テスト: gs://kanade-storage-test
```

---

## 4. 現行実装の評価

### 4.1 変更が少ない箇所

アプリ本体は `DB_URL` を最優先で利用する実装になっているため、Neon移行で大規模なDBアクセス層改修は不要。

対象:

- `src/backend/core/db_config.py`
- `src/backend/core/db_runtime.py`
- `scripts/backup_db.py`
- `scripts/restore_db.py`
- `scripts/migrate_db.py`
- `scripts/migrate_venue_settings_to_flyer_distributions.py`

### 4.2 変更が大きい箇所

現行の本番→テスト同期は以下に依存している。

- `CLOUD_SQL_INSTANCE`
- Cloud SQL Auth Proxy
- `gcloud sql instances describe`
- 同一Cloud SQLインスタンス内の2DB
- 共通パスワード
- `DB_HOST=127.0.0.1`

最大の改修対象は以下。

- `.github/workflows/sync-prod-to-test.yml`
- `scripts/sync_prod_to_test_preflight.py`
- `scripts/verify_prod_test_db_connections.py`
- `scripts/check_test_db_connections_drained.py`
- `scripts/sync_prod_to_test_db.py`
- `scripts/backup_test_environment_pre_sync.py`
- `scripts/check_workflow_static.py`
- 関連テスト

---

## 5. 環境変数・Secrets設計

### 5.1 GitHub Secrets

新規作成:

| Secret | 用途 |
|---|---|
| `PROD_DB_URL` | 本番Cloud Run用 pooled URL |
| `TEST_DB_URL` | テストCloud Run用 pooled URL |
| `PROD_DB_DIRECT_URL` | 本番DBの同期・バックアップ用 direct URL |
| `TEST_DB_DIRECT_URL` | テストDBの同期・復元用 direct URL |

### 5.2 廃止予定

移行完了後に廃止候補:

| 現行 | 扱い |
|---|---|
| `PROD_DB_HOST` | 不要 |
| `TEST_DB_HOST` | 不要 |
| `PROD_DB_USER` | URL内に含むため不要 |
| `TEST_DB_USER` | URL内に含むため不要 |
| `kanade-portal-db-password` | Neon移行完了後に廃止候補 |
| `CLOUD_SQL_INSTANCE` | 不要 |

ただし、ロールバック期間中は削除しない。

### 5.3 URLの条件

Neon URLはTLSを必須とする。

例:

```text
postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require
```

アプリ用URLは pooled endpoint、運用処理用URLは direct endpoint とする。

---

## 6. ファイル別実装内容

## 6.1 `src/backend/core/db_config.py`

### 現状
- `DB_URL` が存在すればそのまま返す。
- host方式では `sslmode=disable`。

### 変更内容
- `DB_URL` 使用時は現状維持。
- host方式はローカル開発互換用として残す。
- Neon移行のための必須変更はなし。
- テスト追加のみ検討する。

### テスト
- `DB_URL` が `sslmode=require` 付きでもそのまま返る。
- パスワード・URLがログに出ない。

---

## 6.2 `.github/workflows/deploy-test.yml`

### 現状
- `TEST_DB_URL` があれば `DB_URL` としてCloud Runに設定。
- 未設定時はhost方式へフォールバック。
- `DB_PASSWORD` Secretを常にCloud Runへ注入。

### 変更内容
1. Neon移行後は `TEST_DB_URL` を必須化。
2. host方式フォールバックを廃止する。
3. `DB_PASSWORD=kanade-portal-db-password:latest` の注入を削除する。
4. `TEST_DB_HOST`、`TEST_DB_NAME`、`TEST_DB_USER` の検証を削除する。
5. URL自体はログへ出力しない。
6. 必須Secret検証に `TEST_DB_URL` を追加する。

### 完了条件
- テストCloud Runの環境変数に `DB_URL` が設定される。
- Cloud SQL接続設定がなくても起動する。
- `/api/revision` が成功する。
- DB参照・更新が成功する。

---

## 6.3 `.github/workflows/promote-production.yml`

### 現状
- `PROD_DB_URL` を優先。
- 未設定時はhost方式。
- Cloud SQL用パスワードSecretを注入。

### 変更内容
1. `PROD_DB_URL` を必須化。
2. host方式フォールバックを廃止する。
3. `DB_PASSWORD` Secret注入を削除する。
4. `PROD_DB_HOST`、`PROD_DB_NAME`、`PROD_DB_USER` を廃止する。
5. 同一digest昇格の現行ルールは維持する。

### 完了条件
- テスト確認済みdigestを本番へ昇格できる。
- 本番Cloud RunがNeon本番DBへ接続する。
- テストDBを参照しない。

---

## 6.4 `.github/workflows/sync-prod-to-test.yml`

### 現行で削除する処理

- `CLOUD_SQL_INSTANCE` 検証
- `gcloud sql instances describe`
- Cloud SQL Auth Proxyのダウンロード
- Proxy起動・待機・終了処理
- Secret Managerから共通DBパスワード取得
- `DB_HOST=127.0.0.1`
- 共通パスワード前提
- Cloud SQL固有ログ

### 新規利用するSecrets

```text
PROD_DB_DIRECT_URL
TEST_DB_DIRECT_URL
```

### 維持する処理

- `operation_id`
- `target_git_sha`
- `dry_run`
- `sync_scope`
- `gcs_only`
- テスト環境メンテナンス
- テスト環境接続数0確認
- テストDB事前バックアップ
- manifest生成・検証
- DB同期
- DB同期後検証
- GCS同期
- GCS検証
- メンテナンス解除
- 失敗時の復旧判定
- 操作履歴

### 新しい処理順

```text
1. 入力値検証
2. Neon接続URLの存在検証
3. PostgreSQL 18 client導入
4. 本番direct URL read-only接続確認
5. テストdirect URL接続確認
6. テスト環境メンテナンス化
7. テストCloud Run接続数0確認
8. テストDBバックアップ
9. 本番DB→テストDB同期
10. DB検証
11. GCS同期
12. GCS検証
13. メンテナンス解除
```

### URLの秘匿

以下を必須とする。

```bash
echo "::add-mask::${PROD_DB_DIRECT_URL}"
echo "::add-mask::${TEST_DB_DIRECT_URL}"
```

コマンド表示時にURL全文を出力しない。

---

## 6.5 `scripts/sync_prod_to_test_db.py`

### 現状
`DbSyncConfig` は以下を保持。

- host
- port
- prod_database
- test_database
- prod_user
- test_user
- password

### 変更後

```python
@dataclass(frozen=True)
class DbSyncConfig:
    prod_db_url: str
    test_db_url: str
    connect_timeout: int
```

### 引数

新規:

```text
--prod-db-url
--test-db-url
```

環境変数:

```text
PROD_DB_DIRECT_URL
TEST_DB_DIRECT_URL
```

### 廃止

```text
--db-host
--db-port
--db-name-prod
--db-name-test
--db-user-prod
--db-user-test
--db-password
```

### 接続

```python
psycopg.connect(
    config.prod_db_url,
    connect_timeout=config.connect_timeout,
    application_name=APPLICATION_NAME_PROD,
    options="-c default_transaction_read_only=on",
)
```

```python
psycopg.connect(
    config.test_db_url,
    connect_timeout=config.connect_timeout,
    application_name=APPLICATION_NAME_TEST,
)
```

### DB同一性検証

現行の「DB名が異なること」だけでなく、以下を確認する。

- 本番URLとテストURLが文字列として一致しない。
- `current_database()` が期待DB名と一致する。
- 接続先ホストまたはendpointが一致していないことをログに秘匿形式で確認する。
- production接続はread-onlyトランザクションに固定する。

---

## 6.6 `scripts/verify_prod_test_db_connections.py`

### 変更内容

現行のhost/user/password方式を廃止し、以下を受け取る。

```text
PROD_DB_DIRECT_URL
TEST_DB_DIRECT_URL
```

確認内容:

- 両URLが設定されている。
- URLが同一ではない。
- 本番接続成功。
- テスト接続成功。
- `SELECT current_database()` の取得成功。
- 本番接続のread-only指定成功。
- `members` テーブルの存在確認。
- URL文字列を出力しない。

---

## 6.7 `scripts/check_test_db_connections_drained.py`

### 設計変更

現行は同一Cloud SQLインスタンスで `pg_stat_activity` を参照している。

Neon移行後はテストDBのdirect URLへ接続し、以下を確認する。

```sql
SELECT count(*)
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
  AND application_name NOT IN (...)
```

注意:

- Neon側で参照可能な `pg_stat_activity` の範囲を実接続テストで確認する。
- 権限制約により完全確認できない場合は、Cloud Runの最大インスタンス数0化またはメンテナンス応答確認を主判定へ変更する。
- 未確認のまま従来ロジックを流用しない。

---

## 6.8 `scripts/backup_test_environment_pre_sync.py`

### 変更内容

- `DB_HOST`、`DB_USER_TEST`、`DB_PASSWORD` を廃止。
- `TEST_DB_DIRECT_URL` を入力とする。
- `pg_dump` はdirect URLを使用。
- 出力ファイル名・manifest・GCS配置は現行維持。
- URLはログへ出さない。

コマンド:

```bash
pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file <dump_path> \
  "${TEST_DB_DIRECT_URL}"
```

---

## 6.9 `scripts/sync_prod_to_test_preflight.py`

### 変更内容

削除:

- `CLOUD_SQL_INSTANCE` 必須確認
- 同一Cloud SQL内のDB名不一致前提

追加:

- `PROD_DB_DIRECT_URL` 必須
- `TEST_DB_DIRECT_URL` 必須
- URL同一禁止
- 接続先情報の秘匿表示
- GCS設定検証は維持
- テストCloud Runサービス名・リージョン制約は維持

---

## 6.10 `scripts/check_workflow_static.py`

### 変更内容

現行のCloud SQL固有必須文字列チェックを廃止。

削除対象例:

```text
CLOUD_SQL_INSTANCE
gcloud sql instances describe
cloud-sql-proxy
DB_HOST: 127.0.0.1
```

追加対象:

```text
PROD_DB_DIRECT_URL
TEST_DB_DIRECT_URL
::add-mask::
PostgreSQL 18 client
Cloud SQL Auth Proxy文字列が存在しないこと
DB URLをechoしないこと
```

### セキュリティチェック

禁止パターン:

```text
echo "${PROD_DB_DIRECT_URL}"
echo "${TEST_DB_DIRECT_URL}"
set -x
printenv
env
```

Secret URLがジョブログへ露出しないことを静的検査する。

---

## 6.11 `.env.example`

追加:

```dotenv
# Application runtime connection (pooled)
DB_URL=postgresql://user:password@pooled-host/dbname?sslmode=require

# Operations only (direct)
PROD_DB_DIRECT_URL=
TEST_DB_DIRECT_URL=
```

注意事項を記載する。

- pooled URLはアプリ実行用。
- direct URLはバックアップ・同期用。
- `.env`をGitへ登録しない。

---

## 7. テスト設計

## 7.1 単体テスト

更新対象:

- `tests/scripts/test_sync_prod_to_test_preflight.py`
- `tests/scripts/test_verify_prod_test_db_connections.py`
- `tests/scripts/test_check_test_db_connections_drained.py`
- `tests/scripts/test_backup_test_environment_pre_sync.py`
- `tests/operations/test_workflow_static.py`
- `tests/backend/test_config_status.py`
- `tests/backend/test_db_json_layer.py`

### 必須観点

1. URL未設定で失敗。
2. 本番・テストURL同一で失敗。
3. URL前後空白の正規化。
4. passwordを含むURLがエラー文へ出ない。
5. pooled URLとdirect URLを取り違えた場合の検出。
6. 本番接続がread-only。
7. テスト接続のみ書き込み可能。
8. `JSONB` 同期。
9. sequence値同期。
10. FK依存順維持。
11. 除外テーブル非変更。
12. DB同期失敗時にGCS同期へ進まない。
13. `gcs_only`ではDB操作を行わない。

---

## 7.2 結合テスト

### テスト環境接続

- NeonテストDBへ接続。
- Cloud Runテストを起動。
- `/api/revision` 成功。
- ログイン成功。
- CRUD成功。
- DB起動セルフチェック成功。
- 低アクセス後のスリープ復帰成功。

### データ移行

- 本番Cloud SQL dump作成。
- Neonテストへrestore。
- テーブル数一致。
- 行数一致。
- 主キー・FK・sequence一致。
- JSONB値一致。
- 日時・タイムゾーン一致。
- 日本語文字化けなし。

### 本番→テスト同期

- full同期成功。
- DB同期成功。
- GCS同期成功。
- manifest成功。
- メンテナンス解除成功。
- DB成功後GCS失敗の `gcs_only` 再開成功。

---

## 8. 実装順序

## Phase 1: Neon準備

1. Neon本番プロジェクト作成。
2. Neonテストプロジェクト作成。
3. PostgreSQLバージョン確認。
4. pooled/direct URL取得。
5. GitHub Secrets登録。
6. URL接続テスト。

完了条件:

- 本番・テスト両direct URLで `SELECT 1` 成功。
- pooled URLでアプリ接続成功。

## Phase 2: ソース対応

1. 同期スクリプトをURL方式へ変更。
2. preflight変更。
3. backup変更。
4. connection drain変更。
5. workflow変更。
6. static checker変更。
7. テスト更新。
8. CI全成功。

## Phase 3: テストDB移行

1. Cloud SQLテストDBバックアップ。
2. Neonテストへrestore。
3. テストCloud Run接続先をNeonへ変更。
4. テスト動作確認。
5. 24時間以上の継続確認。
6. スリープ復帰確認。

## Phase 4: 本番DB移行

1. 本番メンテナンス開始。
2. 最終dump取得。
3. Neon本番へrestore。
4. 行数・整合性検証。
5. 本番Cloud Run接続先変更。
6. 本番動作確認。
7. メンテナンス解除。

## Phase 5: 同期再構築

1. Neon版 full同期 dry-run。
2. Neon版 full同期実行。
3. GCS失敗再現テスト。
4. `gcs_only`再開テスト。
5. 操作履歴確認。

## Phase 6: ロールバック待機

- Cloud SQLを7～14日保持。
- Neon使用量監視。
- 障害・性能問題・無料枠超過を確認。
- 問題がなければCloud SQL削除準備。

---

## 9. ロールバック設計

### 9.1 テスト環境

Neon接続失敗時:

1. テストCloud Runの `DB_URL` をCloud SQL接続へ戻す。
2. 直前の正常digestへ戻す。
3. `/api/revision` 確認。
4. CRUD確認。

### 9.2 本番環境

本番切替後に重大障害が発生した場合:

1. 本番をメンテナンス化。
2. Cloud SQLを再接続可能状態として保持していることを確認。
3. 本番Cloud RunのDB接続をCloud SQLへ戻す。
4. 直前正常digestを再配信。
5. データ差分を評価。
6. メンテナンス解除。

### 9.3 データ差分

Neon切替後に書き込みが発生した場合、単純な接続先戻しではNeon上の更新が失われる。

そのため、本番ロールバック前に以下を判断する。

- Neonへの書き込み件数
- Cloud SQLとの差分
- 差分をCloud SQLへ戻すか
- Neonを継続してアプリ側のみ戻すか

---

## 10. Cloud SQL削除条件

以下をすべて満たすまで削除しない。

- Neon本番が7～14日正常稼働。
- Neonテストが正常稼働。
- 本番→テストfull同期成功。
- `gcs_only`再開成功。
- Neonバックアップ取得成功。
- Neon復元テスト成功。
- Cloud Runスリープ復帰問題なし。
- DB容量・CU使用量が無料枠内。
- ロールバック不要と判断。
- Cloud SQL最終バックアップをGCSへ保存。
- 削除対象インスタンスが `kanade-portal-pg` であることを最終確認。

---

## 11. 変更対象一覧

### 実装必須

- `.github/workflows/deploy-test.yml`
- `.github/workflows/promote-production.yml`
- `.github/workflows/sync-prod-to-test.yml`
- `scripts/sync_prod_to_test_preflight.py`
- `scripts/verify_prod_test_db_connections.py`
- `scripts/check_test_db_connections_drained.py`
- `scripts/sync_prod_to_test_db.py`
- `scripts/backup_test_environment_pre_sync.py`
- `scripts/check_workflow_static.py`
- `.env.example`

### テスト必須

- `tests/operations/test_workflow_static.py`
- `tests/scripts/test_sync_prod_to_test_preflight.py`
- `tests/scripts/test_verify_prod_test_db_connections.py`
- `tests/scripts/test_check_test_db_connections_drained.py`
- `tests/scripts/test_backup_test_environment_pre_sync.py`
- `tests/scripts/test_sync_prod_to_test_db.py`
- 必要に応じてbackend設定系テスト

### 文書更新必須

- `docs/SYNC_PROD_TO_TEST_JOB_DETAIL_DESIGN.md`
- `docs/CI_CD_PLAN_A_RELEASE_FLOW.md`
- `SYSTEM_DESIGN.md`
- `ACCESS_AND_SOURCE_SYNC_GUIDE.md`
- `DB_SETUP_GUIDE.md`
- `CLOUD_RUN_DEPLOYMENT.md`
- `CLOUD_RUN_INITIAL_CHECKLIST.md`

### 履歴資料として維持可能

- `CLOUD_RUN_INITIAL_CHECKLIST_LOG.md`
- 過去の構築レポート
- 旧Cloud SQL移行前記録

履歴資料には「旧構成」と明記し、現行手順として参照されないようにする。

---

## 12. 実装着手条件

以下が確定するまで、Cloud Runの接続先変更は行わない。

- Neon本番・テストプロジェクト名
- Neonリージョン
- PostgreSQLバージョン
- pooled URL
- direct URL
- GitHub Secret名
- 切替日時
- メンテナンス時間
- ロールバック責任点
- Cloud SQL保持期間

---

## 13. 実装完了条件

- CI全成功。
- テストNeon接続成功。
- 本番Neon接続成功。
- 本番・テストデータ一致。
- CRUD成功。
- 本番→テスト同期成功。
- GCS同期成功。
- `gcs_only`成功。
- Secret漏洩なし。
- Cloud SQL依存コードが現行経路から除去済み。
- 運用文書更新済み。
- ロールバック手順確認済み。

---

## 14. 現在の結論

アプリ本体は既に `DB_URL` 対応済みで、DBアクセス処理の作り直しは不要。

実装の中心は次の3点。

1. Cloud Runデプロイを `DB_URL` 必須へ整理する。
2. 本番→テスト同期をCloud SQL Proxy方式からNeon direct URL方式へ変更する。
3. Cloud SQL固有の設定・テスト・文書を更新する。

この順序で進めれば、既存のCloud Run、Cloud Storage、本番／テスト分離、同一digest昇格、メンテナンス、GCS同期、`gcs_only`再開の仕組みを維持したまま移行できる。
