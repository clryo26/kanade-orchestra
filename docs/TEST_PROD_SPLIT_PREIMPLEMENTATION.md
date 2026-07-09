# テスト系 / 本番系 二系統化 実装メモ

このドキュメントは、Cloud Run をテスト系 / 本番系で分離運用するための実装範囲を記録する。

## 今回の実装範囲

- APP_ENV による本番操作 API の環境ガード
  - APP_ENV=test のときのみ本番操作 API を許可
  - APP_ENV 未設定 / production / 不明値は拒否
- 本番操作専用権限ガード
  - システム管理者のみ
  - hidden_user=true の隠しシステム管理者は拒否
- テスト環境専用 UI
  - システム管理配下に「環境管理」タブを追加
  - 通常システム管理者のみ表示
  - 隠しシステム管理者には非表示
- 本番操作 API 契約
  - GET /api/system/environment/status
  - GET /api/system/release/history
  - POST /api/system/release/promote
  - GET /api/system/sync/history
  - POST /api/system/sync/prod-to-test
- 同期ルールの明文化
  - DB/GCS の対象・除外・同期前後要件を status API で返却
- GitHub Actions 実行経路
  - .github/workflows/deploy-test.yml
  - .github/workflows/promote-production.yml
  - .github/workflows/sync-prod-to-test.yml
  - すべて OIDC/WIF 前提、実値は Variables/Secrets 参照
  - deploy-test は CI 成功後の workflow_run でテスト Cloud Run へ自動デプロイする
  - promote-production はテスト Cloud Run の現在 image digest と要求 digest を照合して本番 Cloud Run へ反映する

## 未実装（今回の意図的な非対応）

- GCP IAM の実設定
- Cloud SQL 実バックアップ/実復元
- GCS 実同期
- GitHub Secrets / Variables の実登録

## 実行基盤未実装時の扱い

- `PRODUCTION_OPERATION_EXECUTOR=github-actions` と GitHub dispatch 設定が不足している場合、POST /api/system/release/promote は 503 を返す
- POST /api/system/sync/prod-to-test は 503 を返す
- 本番リリース workflow を起動できた場合のみ execution_status は queued を返す
- 失敗履歴は API 履歴に残し、成功扱いにしない

## 履歴永続化

- 履歴はメモリ保持ではなく、既存 JSON 永続化レイヤに保存する
- 保存先コレクション: production_operation_histories
- 履歴コレクションは汎用 `/api/extra/*` では公開しない
- 同期除外対象に production_operation_histories を明示する
