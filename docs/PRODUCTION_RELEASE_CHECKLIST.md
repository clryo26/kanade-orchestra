# PRODUCTION_RELEASE_CHECKLIST

最終更新: 2026-10-26

本番反映前に、以下を実運用チェック表として記録する。

## 第1〜4A 最終一括配備の実行票（準備のみ・未実行）

対象は `ac5b4e337bcbab06de7008098b38baf41a810f90`（#161）。追加migrationは023だけ、024〜033・4C/4Dは含めない。本票の追加で配備候補SHAを変更しない。以下のコマンドは**配備を決定した時点だけ**実行する。

### 開始条件・履歴照合

- [ ] TEST→本番の順に [履歴照合SQL](sql/PERF_RELEASE_MIGRATION_HISTORY_READONLY.sql) を利用者が全文実行し、環境・実行日時・結果を記録した。配備前は001〜022の `checksum_matches=true`、023だけNULL、余分なversionなしが合格。false、023以外のNULL、SQLエラーは中止する。出力はversionと一致判定だけで、接続情報を記録しない。
- [ ] SQLの期待値は候補SHAの23ファイルを `migrate_db.py` と同じUTF-8テキスト読込（改行正規化・BOM保持）でSHA256化したもの。23件の再計算と隔離PG16での正常・不一致・別version欠落・余分なversion・全適用の5ケースを検証済み。**実DBの履歴照合は利用者の実行待ち**。
- [ ] 対象SHAのCI・Isolated collection clock testsがすべて完了・成功し、実行待ち/実行中のmain CI・配備がないことを再確認した。Deploy Testを有効にしている**全期間**、mainへのpushを止める。他のCI再実行によるmain成功イベントも発生させない。
- [ ] TESTと本番それぞれの直前の100%配信revision・digest、バックアップ時刻・復元手順を記録した。利用の少ない時間帯に実行する。023が `lock_timeout` で失敗したら、配備されていないことを確認してから再実行する。023は5秒のロック待ちで失敗するとトランザクション全体が戻り、workflowも配備へ進まない。通常配備workflowのTEST maintenance検査は迂回しない。
- [ ] 第3段階の `PORTAL_READ_CONTEXT_PATHS`・`PORTAL_VERSION_ETAG_PATHS` は未指定/空、TEST日次照合も無効を維持する。pooler容量とアプリロールの条件を満たす前に有効化しない。

### 保存性能を比較する環境

TESTの既存ログは標本不足で保存性能を比較できないため、TESTは機能受入を行う（必要なら利用者が前後で同じ保存操作を数回行い所要時間を記録する）。集計結果は `.tmp/` に置き、リポジトリには保存しない。

本番昇格の直前に、既存スクリプトで `python scripts/capture_test_release_baseline.py --environment production --hours 24 --output .tmp/production-before.json` を実行し、昇格後も同じ長さの観測窓で `.tmp/production-after.json` に集計する。昇格後24時間の比較なら24時間経過後に採取し、両方とも対象revisionだけの24時間が揃うことを確認する。短い窓で比較する場合は前後とも同じ `--hours` にする。APIごとのp50/p95・標本数・HTTPエラー/504・ASGIログ行数を比較し、API構成や時間帯の違いも記録する。上限件数に達した集計は不完全として使わない。生ログ・要求URL・本文は保存しない。

`save_busy`とタイムアウト総数は応答本文/クライアント失敗等が一律にログへ出ないため未計測（null）とし、HTTP 503/504や文字列検出0件で代用しない。ASGIは例外の一意件数ではなくログ行数。標本なしを応答0msとせず、ログ除外/サンプリングの可能性も残す。この準備では実際の保存操作や本番ログ集計は行っていない。

### TEST実行と受入（この票では未実行）

```powershell
gh workflow enable deploy-test.yml --repo clryo26/kanade-orchestra
gh workflow run deploy-test.yml --repo clryo26/kanade-orchestra --ref main -f target_sha=ac5b4e337bcbab06de7008098b38baf41a810f90
# dispatchの対象SHA・開始時刻から当該run IDを特定して記録し、完了まで確認する。
gh run watch <当該run-ID> --repo clryo26/kanade-orchestra --exit-status
# 成否を問わず再び無効化し、disabled_manuallyを確認してからpush停止を解除する。
gh workflow disable deploy-test.yml --repo clryo26/kanade-orchestra
```

dispatch失敗・watch中断時も無効化を忘れず、開始済みrunは別途状態確認する（無効化は実行のキャンセルではない）。workflowは未適用migration全件を適用してから直ちに配備する。migration失敗時は配備へ進まない。migration後・配備前の検証停止点はなく、023の検証は以下の配備後受入で行う。

受入は次の順で、実施時刻・判定・対象revisionを記録する。

1. **023**：同じ履歴照合SQLで001〜023がすべてtrue・余分なし。加えて [第3段階のschema検証](PERF_STAGE3_IMPLEMENTATION.md) に従い追加表・有効トリガーを確認する。履歴の一致だけで実schemaの完全性を代用しない。運用接続が確保済みなら `scripts/portal_collection_clocks.py preflight`（対象DB/環境を明示、`--application-role`なし）の読取専用検査を使える。
2. **health**：期待SHA・digest・単一revisionへの100%配信と `/api/health`、第3段階の無効を確認する。
3. **画像・録音**：原画像・サムネイル・EXIF回転、録音のアップロード/再生、実音声のMP3変換を確認する。
4. **保存**：TESTは保存機能の受入を行い、必要なら前後で同じ操作の所要時間を記録する。p50/p95等の性能比較は本番昇格前後のログで行う。5秒ロック待ちは変更しない。
5. **ログ**：ASGI例外・`No response returned`・5xxを同じ窓/母数で確認する。切断時ログを根拠なく無害と判定しない。
6. **実iPhone**：[実機チェックリスト](MANUAL_DEVICE_QA_CHECKLIST.md) をSafari・ホーム画面で実施する。自動試験や端末エミュレーションで代用しない。未完了なら本番昇格の判定を保留する。

### 中止・切り戻し・本番昇格

配備失敗、schema/health/SHA/digest/交通配分の不一致、保存不能・画像/録音の主要機能の破損、継続する5xx/タイムアウト増加なら中止し、事前記録した**当該環境の直前revisionへ100%**を戻してhealth・ログを再確認する。自動rollbackはない。023は追加表/トリガーを残し第3段階を無効のままにする（トリガーの書込負荷は残るため観測を続け、schemaの巻戻しを即興で行わない）。標本不足だけで性能悪化とは判定せず、受入不足として記録する。

本番の [Promote Production](../.github/workflows/promote-production.yml) は2026-10-26確認時 **active・workflow_dispatchのみ**。TESTへの配備では起動しない。本番昇格は別の実行判断とし、`tested_sha` と `tested_image_digest` を渡す。TESTのサービスtemplateのdigestとの一致を強制し、同一digestを再ビルドせず本番へ配備する。その前に**本番DBの全未適用migration**を適用するため、本番でも未適用が023だけという照合結果が必要。

workflow自身は「TESTで実際に100%配信するrevisionのdigestとtemplateの一致」「そのイメージのビルドSHAと入力tested_shaの一致」までは検査しない。昇格前にこの両方を実像のrevision情報・イメージのrevisionラベルで確認・記録する。migration後の停止点、health受入、自動rollbackもないため、本番も同じ検証・切り戻しを行う。現時点ではDeploy Testの無効、本番workflowのactiveを変更しておらず、配備・実DBへのmigrationは一切実行していない。

## 記録欄

- 実施日:
- 実施者:
- 対象ブランチ/コミット:
- Cloud Run リビジョン:
- 判定: 実施可 / 保留

## 1. Cloud Run

- [ ] Python 3.12 / Pillow 13を含む版では、候補Linuxイメージの起動・画像（EXIF回転、不正入力を含む）・録音変換/解析依存の検証結果を記録し、実機の受入は自動試験と分けて確認した

- [ ] Cloud Run サービス名を確認した
- [ ] デプロイ先リージョンを確認した
- [ ] 最終反映リビジョンを記録した
- [ ] `CORS_ORIGINS` が本番 URL に限定されている
- [ ] `DATABASE_URL` が本番 DB を指している
- [ ] `GCS_BUCKET` が本番バケットを指している
- [ ] 起動確認（`/api/health` など）を実施した
- [ ] 起動直後ログに異常がない

## 2. PostgreSQL / DB

- [ ] #150対応版は、[単独修正の契約・検証記録](ALBUM_PUT_PHOTOS_FIX.md)を確認し、写真の省略は保持、`photos: null` 等は422、全写真参照の削除には `photos: []` が必要、省略した作成者ID・名前は維持、という契約差分をリリース説明へ記載した。
- [ ] 本番 DB 接続確認を実施した
- [ ] マイグレーション適用状態を確認した
- [ ] 第4段階4Aの対象写真取得を含む版は、**本番・TESTの両方**で `public.albums.organization_id` と `public.album_photos.organization_id` が存在し、両方ともNOT NULLであることを、実DBへの読取専用照会で確認してから配備する。環境ごとの確認日時・対象コミット・2表の結果を記録し、未確認・列欠落・NULL許容なら配備を保留する。隔離PGの成功やmigrationファイルの存在で代用しない。手順は [4A実装記録](PERF_STAGE4A_IMPLEMENTATION.md#6-配備前の必須schema確認) を参照する。この確認はDDL適用の許可ではない。
- [ ] 第3段階を含む版では、[実装記録](PERF_STAGE3_IMPLEMENTATION.md)に従って023の団体列・主キー/FK・親子一致・ロール前提とバックアップを確認した。今回の適用は上の実行票に従い、5秒のロック待ちで競合したら配備へ進まず、未配備を確認して再実行する。
- [ ] 第3段階のAPI設定とTEST日次照合は既定無効を確認し、実ワーカー数/監査を含む接続予算・旧版書込・完全ダイジェスト・API別計測を完了した対象だけ有効化した
- [ ] 023のトリガーは機能無効でも書込時に動くため、配備前後の保存API応答時間・エラー/タイムアウト・save_busy件数を比較して記録した。読取専用preflightの成功を実環境の書込負荷検証と扱わず、通常書込の5秒ロック待ちは維持した
- [ ] 同期/復元後の世代再発行とトリガー検証を、メンテナンス解除前に完了した。失敗時は解除しない

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
