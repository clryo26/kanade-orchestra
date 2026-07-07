# 本番→テスト同期 Job 詳細設計書

最終更新: 2026-07-07

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
同期対象プレフィックスは以下とする。
- recordings/
- sheets/
- albums/
- promotion/

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

## 13. データ整合性方針
- 本番側は常に read-only ソースとして扱う。
- テスト側のみ更新対象とする。
- 同期失敗時に中間状態が残る可能性を考慮し、再実行可能な手順を設計する。

## 14. 事前バックアップ
同期前にテスト環境のバックアップを必須とする。
- テストDBバックアップ
- テストGCSバックアップ

## 15. テスト環境書き込み制御方針
同期開始から終了または復旧完了まで、テスト環境は書き込み保護状態にする。

- 同期Jobの排他ロック取得成功後、テスト環境の書き込み系APIは `423 Locked` または既存API仕様に沿う明示エラーで拒否する。
- 読み取り系APIは利用可能とする。ただし、同期途中の内容であることを画面に明示できるよう、実装時は同期状態取得APIを用意する。
- 管理画面での登録・更新・削除、録音・楽譜・画像のアップロード、端末認証情報を除く設定変更を含む書き込み操作を保護対象とする。
- 同期Jobが失敗した場合も、復旧処理または運用判断が完了するまで書き込み保護を解除しない。
- ロックの取得・解除・強制解除は通常のシステム管理者だけが実行でき、隠しシステム管理者には許可しない。

## 16. 実行順序
推奨順序は以下。
1. 権限・環境チェック
2. 排他ロック取得とテスト環境書き込み保護開始
3. テスト側バックアップ
4. DB同期
5. GCS同期
6. テスト側初期化対象の再作成
7. 整合性確認と同期履歴記録
8. テスト環境書き込み保護解除
9. 排他ロック解放

## 17. DB同期詳細
- トランザクション境界はテーブル単位または論理単位で設計する。
- 外部キー依存を考慮して親子順序を固定する。
- シーケンス/ID採番の整合を崩さない。
- 対象外テーブルに書き込みしない。

## 18. GCS同期詳細
- 対象プレフィックスごとに差分または全量同期を選択する。
- 上書き時はメタデータ保持方針を明示する。
- 削除方針は誤削除防止のためドライラン相当の確認を前提にする。

## 19. API契約
同期要求APIは実行基盤未接続時に success を返さない。
- execution_status: not_configured
- accepted: false

履歴は失敗理由つきで保存し、成功と誤認させない。

## 20. 監査と履歴
- 履歴保存先は `production_operation_histories` とする。
- 履歴には requested_by, requested_at, target_git_sha, execution_status, failure_reason を保持する。
- 履歴コレクションは汎用 extra API で公開しない。
- 同期開始・終了・復旧の判断に必要な計測項目を、同期実行ごとに保存する。

| 区分 | 保存項目 | 用途 |
|---|---|---|
| DB対象 | `db_target_table_count` | 同期対象テーブル数の確認 |
| DB結果 | `db_copied_row_count`, `db_failed_table_count` | コピー件数・失敗テーブル数の確認 |
| GCS対象 | `gcs_target_object_count`, `gcs_total_bytes` | 同期対象オブジェクト数・総容量の確認 |
| GCS結果 | `gcs_copied_object_count`, `gcs_failed_object_count` | コピー件数・失敗オブジェクト数の確認 |
| 時間 | `started_at`, `finished_at`, `duration_seconds` | 処理時間・障害切り分け |
| バックアップ | `backup_reference`, `restore_reference` | 退避先・復旧元の追跡 |
| 実行基盤 | `workflow_run_id`, `cloud_run_job_execution_id` | 実行基盤の追跡。未取得時は未設定として扱う |

- 実装時にDBまたはGCSの件数を取得できない場合、推測値を保存しない。未取得理由を `failure_reason` または専用の未取得項目として記録する。

## 21. 失敗時復旧
- バックアップからテストDB/GCSを復元できることを前提にする。
- 復旧手順は DB と GCS を分けて定義する。
- 復旧後に整合確認を行う。

## 22. 冪等性
- 同一入力で再実行した際に破壊的な差分を生まない方針を取る。
- ジョブ識別子と対象SHAを履歴に記録し、重複実行を追跡可能にする。

## 23. 排他制御
- 同時に複数同期が走らないよう、単一実行ロックを必須とする。
- ロック競合時は 409 または明示エラーで拒否する。

## 24. セキュリティ
- GitHub Secrets の値をログ出力しない。
- 本番資格情報は最小権限で運用する。
- 同期実行権限はシステム管理者の通常ユーザーに限定する。

## 25. GitHub Actions 設計方針
対象Workflowは以下。
- .github/workflows/deploy-test.yml
- .github/workflows/promote-production.yml
- .github/workflows/sync-prod-to-test.yml

テンプレート段階では `Template guard` により実行を停止し、誤実行を防止する。

## 26. Variables / Secrets 方針
実値は未確定のため、本書ではキー名のみ管理する。
- Variables: GCP_PROJECT_ID, GCP_REGION, ARTIFACT_REGISTRY_REPOSITORY, TEST_CLOUD_RUN_SERVICE, PROD_CLOUD_RUN_SERVICE, WIF_PROVIDER, CLOUD_SQL_INSTANCE, DB_NAME_PROD, DB_NAME_TEST, GCS_BUCKET_PROD, GCS_BUCKET_TEST
- Secrets: DEPLOY_SERVICE_ACCOUNT

## 27. 運用チェックリスト
- 実行者が許可権限か
- APP_ENV が test か
- バックアップ取得済みか
- 除外対象が同期対象に混入していないか
- 実行後に履歴が記録されたか

## 28. 既存実装との対応
- 同期方向と対象/除外は `production_ops_service.py` の `sync_rules` と一致させる。
- DBスキーマ名称は `db_schema.py` の定義と矛盾させない。
- execution_status は `not_configured` を維持し、擬似成功を返さない。

## 29. 未確認事項
以下は本設計時点で未確認。
- Cloud Run Job の実名称
- Cloud SQL インスタンス名と実DB名
- GCS バケット実名称
- GitHub Variables / Secrets の実登録値
- GitHub Actions の実行結果
