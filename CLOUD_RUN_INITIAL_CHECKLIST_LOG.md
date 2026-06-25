# Cloud Run 初回構築チェックリスト 実施ログ

最終更新: 2026-06-19
元チェックリスト: CLOUD_RUN_INITIAL_CHECKLIST.md

## 0. 実施メタ情報

- 実施日:
- 実施者:
- 対象環境: production
- 対象プロジェクトID: kanade-orchestra
- Cloud Run サービス名: kanade-orchestra
- 対象リージョン: asia-northeast2
- 対象リビジョン名:
- 変更チケット/PR:

判定ルール:
- OK: 要件を満たし、証跡を確認済み
- NG: 要件を満たしていない
- N/A: 今回対象外

## 1. IAM付与確認ログ

| No | 確認項目 | 期待値 | 判定 (OK/NG/N/A) | 証跡（コマンド結果/画面） | 備考 |
|---|---|---|---|---|---|
| 1-1 | Cloud Run 実行サービスアカウント確認 | kanade-orchestra の実行SAが特定できる |  |  |  |
| 1-2 | Cloud SQL Client 付与 | roles/cloudsql.client が付与済み |  |  |  |
| 1-3 | Secret Accessor 付与 | roles/secretmanager.secretAccessor が付与済み |  |  |  |
| 1-4 | Storage Object Admin 付与 | roles/storage.objectAdmin が付与済み |  |  |  |

## 2. Secret登録確認ログ

| No | 確認項目 | 期待値 | 判定 (OK/NG/N/A) | 証跡（コマンド結果/画面） | 備考 |
|---|---|---|---|---|---|
| 2-1 | Secret存在確認 | kanade-portal-db-password が存在 |  |  |  |
| 2-2 | Secretバージョン確認 | latest を含む有効バージョンが存在 |  |  |  |
| 2-3 | Cloud Run 注入設定確認 | DB_PASSWORD が Secret 参照設定済み |  |  |  |

## 3. Cloud SQL疎通確認ログ

| No | 確認項目 | 期待値 | 判定 (OK/NG/N/A) | 証跡（コマンド結果/画面） | 備考 |
|---|---|---|---|---|---|
| 3-1 | インスタンス状態確認 | kanade-portal-pg が RUNNABLE |  |  |  |
| 3-2 | 接続名確認 | kanade-orchestra:asia-northeast2:kanade-portal-pg |  |  |  |
| 3-3 | DB存在確認 | kanade_portal が存在 |  |  |  |
| 3-4 | DBユーザー確認 | kanade_app が存在 |  |  |  |
| 3-5 | Cloud Run 側接続設定確認 | add-cloudsql-instances と DB_HOST/DB_PORT/DB_NAME/DB_USER が一致 |  |  |  |

## 4. 動作確認ログ

| No | 確認項目 | 期待値 | 判定 (OK/NG/N/A) | 証跡（コマンド結果/画面） | 備考 |
|---|---|---|---|---|---|
| 4-1 | 最新リビジョンReady | latestReadyRevisionName が存在 |  |  |  |
| 4-2 | アプリ基本動作 | 起動時に HTTP 500 が発生しない |  |  |  |
| 4-3 | 接続先情報表示 | 管理画面「接続先情報」が正常表示 |  |  |  |
| 4-4 | Rev表示 | サイドメニュー Rev. が最新に更新 |  |  |  |

## 5. 再発防止ルール確認ログ

| No | 確認項目 | 期待値 | 判定 (OK/NG/N/A) | 証跡（コマンド結果/画面） | 備考 |
|---|---|---|---|---|---|
| 5-1 | CI成功コミットのみデプロイ | 対象コミットのCI成功を確認 |  |  |  |
| 5-2 | 構文チェック実施 | 構文チェック結果を確認 |  |  |  |
| 5-3 | テスト実行 | backend/integration/operations の結果を確認 |  |  |  |

## 6. 総合判定

- 総合判定 (OK/NG):
- 本番反映可否 (可/不可):
- 判定理由:

## 7. 不備一覧と対応計画

| No | 不備内容 | 影響 | 暫定対応 | 恒久対応 | 期限 | 担当 |
|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |

## 8. 承認

- 実施者サイン:
- レビュアー:
- 承認者:
- 承認日時:
