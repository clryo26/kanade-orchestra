# PRODUCTION_RELEASE_CHECKLIST

最終更新: 2026-07-01

本チェックリストは、奏オケポータルを本番反映する前に必ず確認する運用手順です。

## 1. Cloud Run

- [ ] サービス名を確認した
- [ ] リージョン（asia-northeast1/2 など）を確認した
- [ ] 必須環境変数を確認した
- [ ] CORS 設定を確認した
- [ ] ヘルスチェック（`/api/health` または起動確認）を実施した
- [ ] 起動直後ログを確認した
- [ ] 異常時のロールバック手順を確認した

### 1.1 確認項目メモ

- サービス名:
- リージョン:
- 反映対象リビジョン:
- ロールバック先リビジョン:

## 2. PostgreSQL / DB

- [ ] 接続確認を実施した
- [ ] マイグレーション適用状態を確認した
- [ ] バックアップ取得時刻を確認した
- [ ] 復元手順を確認した
- [ ] 初期データ投入要否を確認した

### 2.1 実行ログ

- 接続確認コマンド:
- マイグレーション確認:
- バックアップ確認:
- 復元手順リンク:

## 3. Cloud Storage / GCS

- [ ] 対象バケット名を確認した
- [ ] CORS 設定を確認した
- [ ] IAM 権限を確認した
- [ ] 録音アップロードを確認した
- [ ] 楽譜 PDF 閲覧を確認した
- [ ] 署名 URL 生成を確認した

### 3.1 実行ログ

- バケット:
- CORS 設定ファイル:
- テストアップロード結果:
- 署名 URL テスト結果:

## 4. 管理機能

- [ ] 管理者ログイン
- [ ] 団員登録
- [ ] 練習予定登録
- [ ] 演奏会登録
- [ ] 録音管理
- [ ] 楽譜管理
- [ ] 乗り番表
- [ ] 支払状況
- [ ] イベント調整

## 5. 団員画面

- [ ] iPhone Safari で確認した
- [ ] Android Chrome で確認した
- [ ] PWA 追加確認をした
- [ ] 練習予定確認
- [ ] 欠席連絡
- [ ] 録音再生
- [ ] 楽譜 PDF 閲覧
- [ ] SNS リンク
- [ ] YouTube リンク

## 6. セキュリティ

- [ ] `.env` 未混入を確認した
- [ ] GCP 認証情報未混入を確認した
- [ ] CORS 本番設定を確認した
- [ ] 管理 API 権限を確認した
- [ ] audit log を確認した
- [ ] 不要な debug endpoint を無効化した

## 7. 運用

- [ ] バックアップ手順を確認した
- [ ] 障害時の確認手順を確認した
- [ ] 共有 ZIP 作成手順を確認した
- [ ] 個人 PC / 会社 PC 同期手順を確認した
- [ ] 本番反映前チェック手順を確認した

### 7.1 E2E workflow_dispatch 実行手順

- [ ] GitHub Actions の `E2E` workflow を `workflow_dispatch` で手動実行した
- [ ] `playwright-smoke` ジョブが成功した
- [ ] `Run E2E smoke` ステップで `3 passed` を確認した
- [ ] `playwright-report` artifact を確認した

実行前チェック:

1. 対象ブランチが最新であること
2. `tests/e2e/` と `playwright.config.js` の差分が意図どおりであること
3. CI で backend/frontend の軽量テストが通過済みであること

失敗時の確認:

1. `Install Playwright browsers` 失敗: TLS/プロキシ設定を確認
2. `Run E2E smoke` 失敗: `playwright-report` と失敗スクリーンショットを確認
3. `webServer` 起動失敗: `DATA_BACKEND=local` と `LOCAL_JSON_FALLBACK_ENABLED=true` を確認

ローカル実行補足（Node/npm未搭載端末）:

1. `npm` / `npx` が利用できない端末では、ローカルE2Eを無理に実行せず `workflow_dispatch` の `E2E` workflow を実行して結果を採用する
2. 代替として backend 健全性は `uv run python -c` + `TestClient` で `/api/health` と `/` の 200 応答を確認する

最新実行メモ（2026-07-01）:

- ローカル再検証: `npm run test:e2e` は `3 passed`
- 社内プロキシ向け環境変数を設定した実行でも同結果
- `python scripts/create-source-zip.py` 実行で `dist/source-share/oke-portal-source-20260701-214249.zip` を生成
- ZIP混入チェック結果: `OK: no dangerous entries found`

## 最終サインオフ

- 実施者:
- 実施日時:
- 承認者:
- リリース判定: 実施可 / 保留
