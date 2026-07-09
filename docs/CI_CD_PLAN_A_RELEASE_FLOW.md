# CI/CD 案A リリースフロー設計

最終更新: 2026-07-09

## 1. 目的

GitHub push だけでは本番へ反映せず、CI 成功後にテスト Cloud Run へ自動デプロイし、テスト環境のシステム管理者が確認済み image digest を本番 Cloud Run へ昇格する。

## 2. フロー

1. `main` へ push
2. GitHub Actions `CI` が実行される
3. `CI` 成功時のみ `Deploy Test` が `workflow_run` で起動する
4. `Deploy Test` が Docker image を build し、Artifact Registry へ push する
5. push 済み image digest を解決し、`kanade-orchestra-test` 相当のテスト Cloud Run へ deploy する
6. テスト環境で Git SHA / image URI / image digest / build time / Cloud Run revision を確認する
7. テスト環境の通常システム管理者だけが「本番リリース」を押す
8. アプリ API が GitHub Actions `Promote Production` を `workflow_dispatch` で起動する
9. `Promote Production` がテスト Cloud Run の現在 image digest と要求 digest の一致を確認する
10. 同一 image digest を本番 Cloud Run へ deploy する

## 3. 分離ルール

- `Deploy Test` は本番 Cloud Run を更新しない。
- `Promote Production` は DB/GCS 同期を行わない。
- 本番データ同期は `Sync Prod to Test` の別機能として扱う。
- 本番リリースは `latest` tag を参照せず、テストで稼働中の image digest を使用する。

## 4. GitHub Variables

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `ARTIFACT_REGISTRY_LOCATION`（未設定時は workflow 内で `GCP_REGION` を使用）
- `ARTIFACT_REGISTRY_REPOSITORY`
- `ARTIFACT_REGISTRY_IMAGE`
- `TEST_CLOUD_RUN_SERVICE`
- `PROD_CLOUD_RUN_SERVICE`
- `TEST_GCS_BUCKET`
- `PROD_GCS_BUCKET`
- `TEST_DB_NAME`（`TEST_DB_URL` を使わない場合）
- `PROD_DB_NAME`（`PROD_DB_URL` を使わない場合）
- `WIF_PROVIDER`

## 5. GitHub Secrets

- `DEPLOY_SERVICE_ACCOUNT`
- `TEST_DB_URL` または `TEST_DB_HOST` / `TEST_DB_USER` / `TEST_DB_PASSWORD`
- `PROD_DB_URL` または `PROD_DB_HOST` / `PROD_DB_USER` / `PROD_DB_PASSWORD`

アプリから workflow を起動するテスト Cloud Run には、以下を環境変数として設定する。

- `PRODUCTION_OPERATION_EXECUTOR=github-actions`
- `GITHUB_REPOSITORY`
- `GITHUB_ACTIONS_TOKEN`
- `PROMOTE_PRODUCTION_WORKFLOW=promote-production.yml`
- `PROMOTE_PRODUCTION_REF=main`

## 6. GCP 側設定

- Workload Identity Federation provider
- deploy 用 service account
- Artifact Registry push 権限
- テスト Cloud Run 更新権限
- 本番 Cloud Run 更新権限
- テスト/本番 Cloud Run runtime service account の DB/GCS 権限

## 7. 監査

本番リリース要求は `production_operation_histories` に保存する。保存項目には実行者、Git SHA、image URI、image digest、対象環境、実行状態、失敗理由を含める。

## 8. ロールバック

アプリ変更のロールバックは Cloud Run の既存リビジョンへ戻す。本番リリース workflow が失敗した場合、本番 Cloud Run の既存リビジョンは維持される。DB/GCS は本番リリース処理で変更しない。
