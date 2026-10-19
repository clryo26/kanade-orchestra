# PRODUCTION_RELEASE_CHECKLIST

最終更新: 2026-07-02

本番反映前に、以下を実運用チェック表として記録する。

## 記録欄

- 実施日:
- 実施者:
- 対象ブランチ/コミット:
- Cloud Run リビジョン:
- 判定: 実施可 / 保留

## 1. Cloud Run

- [ ] Cloud Run サービス名を確認した
- [ ] デプロイ先リージョンを確認した
- [ ] 最終反映リビジョンを記録した
- [ ] `CORS_ORIGINS` が本番 URL に限定されている
- [ ] `DATABASE_URL` が本番 DB を指している
- [ ] `GCS_BUCKET` が本番バケットを指している
- [ ] 起動確認（`/api/health` など）を実施した
- [ ] 起動直後ログに異常がない

## 2. PostgreSQL / DB

- [ ] 本番 DB 接続確認を実施した
- [ ] マイグレーション適用状態を確認した
- [ ] チューナーの履歴を公開する版では、`017_tuner_practice.sql` が `schema_migrations` に記録され、`members` のトリガー `trg_tuner_members_owner_guard_delete`／`_insert` があることを確認した（手順と戻し方は `docs/TUNER_ADVANCED_IMPLEMENTATION_STATUS.md` の8章）
- [ ] メトロノームの記録を使う版では、`019_metronome_practice.sql` が `schema_migrations` に記録され、`tuner_owners` のトリガー `trg_metronome_owner_revoked` があることを確認した（手順と戻し方は `docs/METRONOME_IMPLEMENTATION_STATUS.md` の8章）
- [ ] 楽譜ライブラリの信頼性対応の版では、`020_sheet_library_reliability.sql` と `021_sheet_zip_progress.sql` が `schema_migrations` に記録され、既存の楽譜件数と `sheet_files`（`legacy`）の件数が一致し、表示・DL・ZIPのURLが変わっていないことを確認した（`docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md` の10章）
- [ ] 楽譜の保存機能は、`docs/MANUAL_DEVICE_QA_CHECKLIST.md` の7-13を対象iPhone（ホーム画面のポータルとSafari）で完了するまで公開可能と判定しない
- [ ] `scripts/cleanup_sheet_storage.py` を確認実行（`--execute` なし）し、削除候補が想定どおりであることを確認した
- [ ] 楽譜のリリースでは `docs/SHEET_LIBRARY_RELEASE_READINESS.md` の残確認を完了した。ZIPの処理予算15秒は要求全体20秒の保証ではなく、実GCSで処理時間・キャンセル・復帰を確認した
- [ ] テーブル件数/主要データをスポット確認した
- [ ] バックアップ取得時刻を確認した
- [ ] 復元手順を確認した

## 3. Cloud Storage / GCS

- [ ] 本番バケット名を確認した
- [ ] CORS 設定が本番向けになっている
- [ ] サービスアカウント権限を確認した
- [ ] 署名 URL 生成を確認した
- [ ] 録音アップロード導線を確認した
- [ ] 楽譜 PDF 閲覧導線を確認した

## 4. 管理機能

- [ ] 管理者ログインできる
- [ ] 練習予定管理画面が表示される
- [ ] 演奏会管理画面が表示される
- [ ] 録音管理画面が表示される
- [ ] 楽譜管理画面が表示される
- [ ] 団員管理画面が表示される
- [ ] 支払状況画面が表示される

## 5. 団員画面

- [ ] 団員ログインできる
- [ ] 練習予定一覧を表示できる
- [ ] 練習予定で出席・欠席・遅刻・早退の登録フォームを表示できる
- [ ] 出欠確認で出席・欠席・未登録者を表示できる
- [ ] 録音一覧を表示できる
- [ ] 楽譜一覧を表示できる
- [ ] 演奏会情報を表示できる
- [ ] SNS / YouTube リンクを開ける

## 6. iPhone / PWA

- [ ] iPhone Safari で URL を開ける
- [ ] レイアウト崩れや横スクロールがない
- [ ] ホーム画面追加できる
- [ ] PWA 起動時に主要導線が使える
- [ ] 画面遷移後に戻る操作ができる

## 7. セキュリティ

- [ ] `.env` / credentials / 秘密鍵の混入がない
- [ ] 管理者専用 API の権限制御を確認した
- [ ] 不要な debug エンドポイントが無効
- [ ] CORS が過剰に開放されていない
- [ ] 監査ログまたはアクセスログを確認した

## 8. バックアップ

- [ ] DB バックアップ最新世代を確認した
- [ ] 録音・楽譜データのバックアップ方針を確認した
- [ ] 復旧担当者と連絡手段を確認した

## 9. ロールバック

- [ ] Cloud Run のロールバック先リビジョンを特定した
- [ ] DB ロールバック方針を確認した
- [ ] 障害時の判断基準（戻す/継続）を共有した

## 10. 障害時対応

- [ ] 障害一次切り分け手順を確認した
- [ ] Cloud Logging の参照先を確認した
- [ ] 連絡テンプレート（団員向け告知）を確認した

## 11. 本番反映前最終確認

- [ ] `npm run setup:local` 実施済み
- [ ] `npm run qa:local` 実施済み
- [ ] `npm run check:release-safety` 実施済み
- [ ] `npm run pre-release` 実施済み
- [ ] CI（通常 workflow）が成功している
- [ ] E2E workflow を必要時 `workflow_dispatch` 実行済み
- [ ] 共有 ZIP を生成し危険ファイル混入がない
- [ ] 診断API設定（`DIAGNOSTIC_CONFIG_ENABLED=false`, `DIAGNOSTIC_CONFIG_REQUIRE_ADMIN=true`）を確認した
- [ ] [docs/MANUAL_DEVICE_QA_CHECKLIST.md](docs/MANUAL_DEVICE_QA_CHECKLIST.md) の手動確認計画を確認した
- [ ] [docs/CLOUD_RUN_GCS_DB_CHECK.md](docs/CLOUD_RUN_GCS_DB_CHECK.md) の設定確認を完了した

## 備考欄

- 気づき:
- 保留項目:
- 次回改善:

## JST日時対応の追加条件（2026-10-19、未反映）

- [ ] [実装計画](JST_DATETIME_IMPLEMENTATION_PLAN.md) 10.5節のS00結果を記録した。TEST開始前にQ01〜Q04・Q09〜Q12・Q16が揃っている。
- [ ] 022は既存表を変更しない追加表・索引であり、保留マイグレーション全体と旧コードのexpand互換を確認した。
- [ ] S10/S11と画面・運用スクリプトを同じ候補リリースに含め、CI・隔離TESTのDB/GCS・再送・回収試験を終えた。
- [ ] 第1段: 通常稼働中に追加スキーマを反映した。
- [ ] 第2段: `scripts/manage_datetime_maintenance.py` で対象照合・メンテナンス開始・writer停止・drainを完了した。
- [ ] 第3段: 新コードを反映し、一般利用へ開放せずhealth・revision・digest・DB・移行状態を照合した。
- [ ] 第4段: 根拠付きマニフェストの旧参照移行を完了してからメンテナンスを解除した。
- [ ] 解除失敗時はメンテナンスへ戻す。新アセット参照利用後の非互換旧コード復帰を選ばず、前進復旧する。
- [ ] 回収ジョブは `cleanup_portal_file_assets.py` のドライランを確認してから有効化する。prefix一括削除・確定前削除は実行しない。

宣伝リセット用 `manage_production_maintenance.py` の解除ガードは今回のために緩めない。上記チェックはローカル合格だけでは完了にならない。
