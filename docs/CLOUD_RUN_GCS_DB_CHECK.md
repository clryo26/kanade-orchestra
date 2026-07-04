# CLOUD_RUN_GCS_DB_CHECK

最終更新: 2026-07-02

本番/検証環境で Cloud Run・GCS・DB 設定を確認するための運用ドキュメント。

## 1. Cloud Run 環境変数チェック

- [ ] `DATABASE_URL`
- [ ] `DATA_BACKEND`
- [ ] `LOCAL_JSON_FALLBACK_ENABLED`
- [ ] `GCS_BUCKET`
- [ ] `CORS_ORIGINS`
- [ ] `GOOGLE_CLOUD_PROJECT`
- [ ] `PORT`
- [ ] `DIAGNOSTIC_CONFIG_ENABLED`
- [ ] `DIAGNOSTIC_CONFIG_REQUIRE_ADMIN`
- [ ] `DIAGNOSTIC_CONFIG_VERBOSE`

確認メモ:

- サービス名:
- リビジョン:
- 確認日時:

## 2. `.env.example` 対応確認

- [ ] `.env.example` のキーと Cloud Run 設定の対応を確認した
- [ ] 開発専用値が本番に混入していない
- [ ] 秘密情報がリポジトリに含まれていない

## 3. CORS 設定

- [ ] 本番 URL のみ許可されている
- [ ] `*` の無制限許可をしていない
- [ ] preflight 応答が想定通り

## 4. DATABASE_URL / DB 接続

- [ ] `DATABASE_URL` が本番 DB を指している
- [ ] Cloud Run から DB 接続できる
- [ ] 主要 API 呼び出しで DB エラーがない

## 5. GCS_BUCKET / 権限

- [ ] `GCS_BUCKET` が本番バケットを指している
- [ ] Cloud Run サービスアカウントに必要権限がある
- [ ] 楽譜/録音の取得で 403/404 が頻発していない

## 6. 署名 URL 確認

- [ ] 署名 URL 生成 API が正常応答
- [ ] 生成 URL の有効期限が想定通り
- [ ] 期限切れ時に適切なエラーになる

## 7. アップロードサイズ制限

- [ ] Cloud Run 側のリクエストサイズ制限を確認した
- [ ] 大容量音源は GCS 直接アップロード導線を利用している
- [ ] アップロード失敗時に UI エラーメッセージが出る

## 8. ログ確認

- [ ] 起動時ログに異常がない
- [ ] `/api/health` アクセスログが確認できる
- [ ] 例外発生時にトレースが記録される
- [ ] 機密情報がログ出力されていない
- [ ] 診断APIアクセスが監査ログへ記録される（有効時）

## 9. バックアップ確認

- [ ] DB バックアップ取得状況を確認した
- [ ] GCS バケットの保護設定/ライフサイクルを確認した
- [ ] 復元手順が最新化されている

## 10. ロールバック確認

- [ ] Cloud Run のロールバック先リビジョンを確認した
- [ ] DB ロールバック方針を確認した
- [ ] 障害時連絡フローを確認した

## 11. 本番/検証環境の切り分け

- [ ] 本番と検証でプロジェクト/バケット/DB が分離されている
- [ ] 誤反映防止の命名規則を確認した
- [ ] 環境ごとの URL 一覧を更新した

## 実行コマンド例（手動確認）

```bash
uv run python -m compileall -q src/backend tests
uv run pytest -q
npm run check:frontend:syntax
npm run test:frontend
```

```bash
npm run test:e2e
```

## 備考

- iPhone 実機確認は [docs/MANUAL_DEVICE_QA_CHECKLIST.md](docs/MANUAL_DEVICE_QA_CHECKLIST.md) を参照する。
- 本番反映前の最終判定は [docs/PRODUCTION_RELEASE_CHECKLIST.md](docs/PRODUCTION_RELEASE_CHECKLIST.md) を使用する。
