# 本番→テスト同期 Job 詳細設計書

最終更新: 2026-07-14

## 1. 目的
本設計書は、本番環境のデータをテスト環境へ安全に同期するための詳細設計を定義する。
対象は運用設計と静的検証観点であり、実接続・実同期の実行手順は含めない。

## 2. 背景
テスト検証の再現性を高めるため、本番データを一定ルールでテスト環境へ反映する必要がある。
一方で、監査情報や認証系データを誤ってコピーすると運用事故を招くため、同期対象と除外対象を明確化する。

## 3. スコープ
- 対象: 本番DB→テストDB、本番GCS→テストGCS の一方向同期設計
- 非対象: テスト→本番同期、実デプロイ、実GCP操作、実ジョブ実行

## 4. 用語
- 同期: 本番データをテスト環境へ反映する処理
- 本番DB/テストDB: Cloud SQL 同一インスタンス内で分離される想定の論理DB
- 本番GCS/テストGCS: 本番とテストで分離されたバケット

## 5. 前提
- 実サービス名、実DB名、実バケット名、実Job名は未確定である。
- APP_ENV=test の管理UIからのみ同期操作を受け付ける。
- 実行基盤未接続フェーズではテンプレート停止を維持する。

## 6. 権限制御
同期を実行できるのは「システム管理者」の通常ユーザーのみとする。
以下は同期不可とする。
- 一般団員
- 管理者
- 隠しシステム管理者
- APP_ENV=test 以外の環境

## 7. 同期方向
許可する同期方向は固定で以下のみ。
- 本番DB -> テストDB
- 本番GCS -> テストGCS

逆方向 (テスト -> 本番) は設計対象外とし、機能を実装しない。

## 8. 実行トリガー
- 手動トリガー: GitHub Actions `workflow_dispatch`
- APIトリガー: システム管理の同期要求API

ただし現フェーズでは実処理は無効化し、テンプレートガードで停止させる。

## 9. 同期対象 (DB)
同期対象は既存の同期ルール実装に従う。代表的には以下。
- performances
- performance_pieces
- schedules
- announcements
- events
- members
- absences
- event_responses
- date_adjustments
- date_adjustment_candidates
- date_adjustment_responses
- piece_infos
- practice_instructions
- performance_day_infos
- payments
- payment_performance_fees
- castings
- casting_members
- casting_extras
- desired_pieces
- desired_piece_votes
- promotions
- albums
- album_photos
- part_settings
- venue_settings
- flyer_distributions
- flyer_distribution_assignments
- org_settings
- sns_settings
- connection_settings
- drive_files
- recording_metadata
- sheet_library

## 10. 同期対象 (GCS)
実バケットの保存構造に合わせ、固定同期対象プレフィックスは以下とする。
- sheets/
- albums/

録音は固定プレフィックスを持たず、バケット直下の `<YYYY-MM-DD>/` に保存される。
動的同期対象は `^\d{4}-\d{2}-\d{2}/` に一致する先頭プレフィックスとし、
オブジェクト形式は `<YYYY-MM-DD>/<曲名>/<ファイル名>` とする。

`recordings/` と `promotion/` は同期対象として扱わない。`promotion/` は実バケットに存在せず、
バックエンドにも専用GCSアップロード処理がないためである。

## 11. 同期除外 (DB)
以下は同期除外とする。
- auth_devices
- access_logs
- audit_logs
- production_operation_histories

## 12. 同期除外 (GCS)
以下プレフィックスは同期除外とする。
- auth/
- audit/
- sync-history/
- backups/

`app-data/` は JSON 互換データであり、上記のGCS資産同期対象には含めない。

## 13. データ整合性方針
- 本番側は常に read-only ソースとして扱う。
- テスト側のみ更新対象とする。
- 同期失敗時に中間状態が残る可能性を考慮し、再実行可能な手順を設計する。

## 14. 事前バックアップ
同期前にテスト環境のバックアップを必須とする。
- テストDBバックアップ
- テストGCSバックアップ

## 15. 実行順序
推奨順序は以下。
1. 権限・環境チェック
2. 排他ロック取得
3. テスト側バックアップ
4. DB同期
5. GCS同期
6. テスト側初期化対象の再作成
7. 監査ログ記録
8. 排他ロック解放

## 16. DB同期詳細
- トランザクション境界はテーブル単位または論理単位で設計する。
- 外部キー依存を考慮して親子順序を固定する。
- シーケンス/ID採番の整合を崩さない。
- 対象外テーブルに書き込みしない。

## 17. GCS同期詳細
- 対象プレフィックスごとに差分または全量同期を選択する。
- 上書き時はメタデータ保持方針を明示する。
- 削除方針は誤削除防止のためドライラン相当の確認を前提にする。

## 18. API契約
同期要求APIは実行基盤未接続時に success を返さない。
- execution_status: not_configured
- accepted: false

履歴は失敗理由つきで保存し、成功と誤認させない。

## 19. 監査と履歴
- 履歴保存先は `production_operation_histories` とする。
- 履歴には requested_by, requested_at, target_git_sha, execution_status, failure_reason を保持する。
- 履歴コレクションは汎用 extra API で公開しない。

## 20. 失敗時復旧
- バックアップからテストDB/GCSを復元できることを前提にする。
- 復旧手順は DB と GCS を分けて定義する。
- 復旧後に整合確認を行う。

## 21. 冪等性
- 同一入力で再実行した際に破壊的な差分を生まない方針を取る。
- ジョブ識別子と対象SHAを履歴に記録し、重複実行を追跡可能にする。

## 22. 排他制御
- 同時に複数同期が走らないよう、単一実行ロックを必須とする。
- ロック競合時は 409 または明示エラーで拒否する。

## 23. セキュリティ
- GitHub Secrets の値をログ出力しない。
- 本番資格情報は最小権限で運用する。
- 同期実行権限はシステム管理者の通常ユーザーに限定する。

## 24. GitHub Actions 設計方針
対象Workflowは以下。
- .github/workflows/deploy-test.yml
- .github/workflows/promote-production.yml
- .github/workflows/sync-prod-to-test.yml

`deploy-test.yml` と `promote-production.yml` はアプリ本体の案Aリリース経路として実処理を行う。`sync-prod-to-test.yml` は DB/GCS 同期の別機能であり、実同期接続が確定するまで `Template guard` により停止する。

## 25. Variables / Secrets 方針
実値は未確定のため、本書ではキー名のみ管理する。
- Variables: GCP_PROJECT_ID, GCP_REGION, ARTIFACT_REGISTRY_REPOSITORY, TEST_CLOUD_RUN_SERVICE, PROD_CLOUD_RUN_SERVICE, WIF_PROVIDER, CLOUD_SQL_INSTANCE, PROD_DB_NAME, TEST_DB_NAME, PROD_GCS_BUCKET, TEST_GCS_BUCKET
- Secrets: DEPLOY_SERVICE_ACCOUNT, PROD_DB_USER, TEST_DB_USER
- Secret Manager: kanade-portal-db-password (database password; not stored as a GitHub Secret)

## 26. 運用チェックリスト
- 実行者が許可権限か
- APP_ENV が test か
- バックアップ取得済みか
- 除外対象が同期対象に混入していないか
- 実行後に履歴が記録されたか

## 27. 既存実装との対応
- 同期方向と対象/除外は `production_ops_service.py` の `sync_rules` と一致させる。
- DBスキーマ名称は `db_schema.py` の定義と矛盾させない。
- execution_status は `not_configured` を維持し、擬似成功を返さない。

## 28. 未確認事項
以下は本設計時点で未確認。
- Cloud Run Job の実名称
- Cloud SQL インスタンス名と実DB名
- GCS バケット実名称
- GitHub Variables / Secrets の実登録値
- GitHub Actions の実行結果

## 29. Stage 3-1 Preflight Policy

Stage 3-1 adds a preflight step before real prod-to-test DB/GCS sync.

- The preflight runs only when `dry_run=false`.
- The preflight validates required settings, prod/test DB separation, prod/test GCS bucket separation, fixed DB exclusion tables, fixed GCS target/exclusion prefixes, the dynamic recording prefix policy, and the deterministic backup path.
- Fixed GCS targets are `sheets/` and `albums/`. Recording targets use the bucket-root `<YYYY-MM-DD>/` policy and the `<YYYY-MM-DD>/<曲名>/<ファイル名>` object layout.
- The deterministic backup path is `gs://<GCS_BUCKET_TEST>/backups/prod-to-test/<operation_id>/`.
- The workflow may run read-only checks with `gcloud sql instances describe` and `gcloud storage buckets describe`.
- The preflight must not run DB sync, GCS sync, test DB backup creation, test GCS backup creation, delete operations, restore operations, or any write operation.
- `Template guard` remains enabled after preflight, so real sync is still intentionally blocked.

## 30. Stage 3-2 Read-only Database Connection Verification

Stage 3-2 verifies connectivity to the production and test logical databases without changing
either environment.

- GitHub Actions connects through a pinned Cloud SQL Auth Proxy v2 binary to the production and
  test databases in the same Cloud SQL instance.
- The database password is obtained from Secret Manager as `kanade-portal-db-password`. Production
  and test database user names are supplied by the `PROD_DB_USER` and `TEST_DB_USER` GitHub Secrets.
- The password is registered with the GitHub Actions log masker before use and is not written to
  `$GITHUB_ENV` or printed as a connection string.
- Every connection starts with `options=-c default_transaction_read_only=on`.
- The only SQL statements executed are `SHOW transaction_read_only`,
  `SELECT current_database()`, and `SELECT 1`.
- Connections are explicitly rolled back and closed. No commit is performed.
- Proxy startup, finite readiness checking, secret retrieval, verification, and proxy cleanup run
  in one shell step so the cleanup trap always stops the proxy.
- DB/GCS sync, backup, restore, DDL, DML, table enumeration, and row-count queries remain
  unimplemented.
- `Template guard` and the final `exit 1` remain enabled, so synchronization is still blocked.
- Stage 3-2 does not change GitHub, GCP, DB, or GCS resources; it only performs read-only checks.

## 31. Stage 3-3 Backup Target Policy

Stage 3-3 のテストGCS事前バックアップ対象には、同期対象と同じ資産規則を適用する。

- 固定対象は `sheets/` と `albums/` とする。
- 録音対象はバケット直下の `<YYYY-MM-DD>/` 形式とし、オブジェクト形式は `<YYYY-MM-DD>/<曲名>/<ファイル名>` とする。
- `recordings/`、`promotion/`、`app-data/`、`auth/`、`audit/`、`sync-history/`、`backups/` は資産バックアップ対象に含めない。
- バックアップ格納先 `backups/prod-to-test/<operation_id>/` は同期・資産バックアップの入力対象から除外し、再帰的なバックアップを防止する。

### 31.1 第1実装の範囲

事前バックアップ専用スクリプトとして `scripts/backup_test_environment_pre_sync.py` を実装する。
このスクリプトはテスト環境だけを対象とし、本番DB名、本番DBユーザー、本番GCSバケットを入力に持たない。

- テストDB全体を PostgreSQL 18 対応の `pg_dump` により custom 形式、`--no-owner`、`--no-acl` で取得する。
- DBパスワードはコマンド引数へ含めず、子プロセスの `PGPASSWORD` だけに設定する。
- dump作成後に `pg_restore --list` を実行し、読み取り可能性を検証する。
- dumpのSHA-256とファイルサイズを計算し、SHA-256をGCSオブジェクトのcustom metadataへ設定する。
- DB dumpアップロード後にblobを再読込し、GCS上のgeneration、size、SHA-256 metadataを検証する。
- GCSは上記の固定・動的対象だけを同一テストバケット内の `gcs/<元のオブジェクトパス>` へコピーする。
- 日付prefixは正規表現相当の書式だけでなく、暦上実在する日付であることを検証する。
- 列挙時に取得した各コピー元generationを必須とし、コピー処理中も同じgenerationへ固定する。
- コピー先blobを再読込し、generationとsizeを検証する。crc32cまたはMD5がコピー元に存在する場合はコピー先との一致も検証する。
- 失敗時は自動復元、作成済みバックアップの削除、実同期を行わず、エラー終了する。

### 31.2 保存先と上書き防止

保存先は `gs://<GCS_BUCKET_TEST>/backups/prod-to-test/<operation_id>/` とし、配下を以下の構造にする。

- `database/<安全化したDB_NAME_TEST>.dump`
- `gcs/<元のオブジェクトパス>`
- `manifest.json`

同一 `operation_id` 配下に既存オブジェクトが1件でもある場合は開始前に失敗させる。
さらに各GCS書き込みへ新規作成の世代一致条件を付け、事前確認後の競合による上書きも禁止する。
資産コピーでは `source_generation` と `if_source_generation_match` に列挙時のgenerationを指定し、
コピー元が列挙後に更新・削除された場合は別generationをコピーせず失敗させる。
`operation_id` の許可文字規則は Stage 3-1 preflight と同じものを使用する。

### 31.3 manifest完了条件

`manifest.json` はDB dumpの検証・アップロードと全GCSコピーが成功した後、最後の書き込みとして作成する。
manifestには識別情報、開始・完了時刻、対象環境、DB dumpのパス・サイズ・SHA-256・検証結果、
DB dumpのgeneration、GCS対象規則、コピー件数・合計サイズ・コピー済み一覧、`backup_status` を記録する。
GCSコピー済み一覧にはコピー元generation、コピー先generation、検証済みsizeと、存在する場合はchecksumを記録する。

アップロード後にmanifestを再読込し、以下が一致した場合だけバックアップ成功とする。

- `operation_id`
- `backup_status=completed`
- DB dumpのSHA-256
- DB dumpのgenerationとsize
- GCSコピー件数
- GCSコピー合計サイズ
- 各コピー先generationが空でなく、コピー完了時に記録したgenerationと一致すること

コピー元generation競合、DB/GCSのsize・SHA-256 metadata・checksum不一致、generation欠落が
発生した場合は、`manifest.json` を作成せず失敗する。manifest再読込検証が不一致の場合も
成功扱いにせずエラー終了し、既存の失敗時方針どおり自動削除は行わない。

### 31.4 CLI安全条件とworkflow接続

CLIの既定動作はdry-runとする。明示的な `--execute` がある場合だけ、DB dump、GCSコピー、
manifestアップロードを許可する。dry-runは対象規則、保存先、予定処理を表示するだけで、
GCSクライアント生成、subprocess実行、GCS書き込みを行わない。

`.github/workflows/sync-prod-to-test.yml` は `dry_run=false` の場合だけ、preflightと本番・テストDBの
読み取り専用接続確認が成功した後に、`python scripts/backup_test_environment_pre_sync.py --execute` を
正確に1回実行する。`dry_run=true` では依存導入を含むGCP・DB・GCS処理をすべてスキップする。
実行するスクリプトは `github.workflow_sha` の信頼済みworkflow revisionからcheckoutし、
入力された `target_git_sha` はバックアップmanifestのmetadataとしてのみ使用する。

バックアップ実行環境は以下の安全条件を満たす。

- `google-cloud-storage==2.14.0` を明示的に導入する。
- 公式PGDG apt repositoryの署名鍵をfail-closedで取得し、fingerprintを照合してから `postgresql-client-18` を導入する。
- 専用バックアップスクリプトが `pg_dump` と `pg_restore` のmajor versionを実行直前に確認し、18以外または判定不能の場合は停止する。
- Cloud SQL Auth Proxyの起動、ready確認、Secret ManagerからのDB password取得、マスク登録、バックアップ実行、trap cleanupを同一shell stepで行う。
- DB passwordはコマンド引数、ログ、`GITHUB_ENV`へ出さず、同一step内の子プロセス環境変数だけで使用する。
- workflow内にはDB/GCS同期・削除・復元コマンドを直接記述しない。

バックアップ完了後も同workflowの `Template guard` と最終 `exit 1` で必ず停止する。
静的な書き込み禁止ガードを維持し、DB/GCS同期、削除、復元は引き続き未実装とする。

### 31.5 実バックアップ #7 のfail-closed停止とPG18 PATH固定

2026-07-14の実バックアップ #7 は、PostgreSQL 18 client導入とDB read-only接続確認の成功後、
専用バックアップスクリプトの `pg_dump major version must be 18` 検証でdump作成前に停止した。
保存先 `backups/prod-to-test/stage3-3-backup-20260714-01/` は空であり、再実行は行っていない。

原因は、GitHub-hosted runnerの既定PATHで、PGDGから導入した18以外のclientが先に解決された
可能性が高い。この再発を防ぐため、以下をfail-closed条件とする。

- PGDG client導入直後に `/usr/lib/postgresql/18/bin/pg_dump` と `pg_restore` が実行可能であることを確認する。
- 両絶対パスの `--version` 出力がmajor 18であることを確認する。
- バックアップstep内で `PATH=/usr/lib/postgresql/18/bin:${PATH}` を設定する。
- `command -v pg_dump` と `command -v pg_restore` の解決先が上記PG18絶対パスと完全一致することを確認する。
- 専用バックアップスクリプト側のmajor 18検証も維持し、workflowとスクリプトの二重検証とする。

PATH解決先、実行可能性、versionのいずれかが不一致の場合は、Secret取得およびdump作成前に停止する。
