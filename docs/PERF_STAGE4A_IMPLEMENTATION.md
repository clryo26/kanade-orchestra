# 第4段階4A 実装記録 v1.1

2026-10-23。基準 `143d8d9`、ブランチ `perf/portal-stage4a-20261023`。[詳細設計v1.2](PERF_STAGE4_DETAILED_DESIGN.md) の5.1（PERF-R13）を実装した。**4A全体の完了ではない。** 5.2/5.3のGCS条件付きGET・世代付きサムネイル（PERF-R14）は、SDKの全体時間予算の方式が未確定のため保留する。4C/4Dは未着手で、Issue #150も未修正。

## 1. 変更内容と互換性

- `AlbumRepository.find_photo` がDBモードの対象写真だけを取得する。親albumsと子album_photosをLEFT JOINし、album_id・photo_id・親子両方のorganization_idを照合する。子のFKがなくても別団体・別親の写真を返さない。
- 親なしは従来の `Data not found`、写真なしは `Photo not found` の404。親と写真を1文の同じsnapshotで判定する。親不在の孤立子も返さない。
- `album_service._find_photo` はこのrepositoryへ委譲する。明示的なローカルJSON/試験用storeでは、従来の対象アルバム内検索を維持し、全団体のリストキャッシュは使わない。
- 共通poolと既存row storeの短いtransactionを使い、重い読取の枠へ追加しない。両テーブルに団体列がない場合は短絡取得を拒否し、団体条件を外したSQLに切り替えない。実DBの列・PK・団体整合性の確認はリリース前に必要。
- 公開GETを認証必須にはしない。画像URL・項目・向き・品質・寸法・順序・HTTPヘッダー・サムネイルv1保存方式は変更しない。GCSの既存SDK再試行も維持する。
- 書込・削除・子集合の全置換・物理回収・migration・運用設定を変更しない。写真省略PUTの既存挙動は、別不具合 [#150](https://github.com/clryo26/kanade-orchestra/issues/150) のまま記録する。

## 2. 修正前後のDB比較

架空標準/2倍量、同じ固定写真4枚、同じ実router・pool・cursor・監査を使用。PG16/18とも各16件成功、60バッチ・1,520写真GETを含む。新しい契約試験の12要求を加え、各版のHTTP合計は1,575要求。全migrationのschemaではなく、FKなしの互換schemaである点も前回と同じ。

| 写真表示数 | warm SQL 修正前→後 | 親/子の取得文 修正前→後 | 写真fetch行 修正前→後 | 延べ貸出 修正前→後 |
|---:|---:|---|---:|---:|
| 1 | 5→4 | 親1＋子1→JOIN1 | 25→1 | 1→1 |
| 25 | 125→100 | 親25＋子25→JOIN25 | 625→25 | 25→25 |
| 50 | 250→200 | 親50＋子50→JOIN50 | 1,250→50 | 50→50 |

SQLには既存SET LOCAL 3文/要求を含む。団体列判定coldは各バッチに2文を追加する。fetch行はcursorから受け取った写真行数であり、DB走査行数ではない。JOINの親行を二重に写真行へ加算しない。延べ貸出が減った、GCS往復が減った、HTTP転送が減ったとは報告しない。全対応バッチの画像本文バイト数は修正前と一致した。

原本は [PG16 AFTER](perf_stage4/POSTGRES16_TARGET_AFTER.json) / [PG18 AFTER](perf_stage4/POSTGRES18_TARGET_AFTER.json)。[PG16 BEFORE](perf_stage4/POSTGRES16_BEFORE.json) / [PG18 BEFORE](perf_stage4/POSTGRES18_BEFORE.json) と旧画像fixture/計測JSONは変更しない。測定時刻・局所遅延を本番性能やPG版の優劣に読み替えない。

## 3. 回帰試験と検証

追加の実HTTP/PG契約試験は、認証ヘッダーなしの写真GET、親なし・写真なしの原画像/サムネイル404、別親・別団体、親と団体が不整合な子行、別接続による削除/再登録後のID再利用、親がない孤立子を含む。DBで拒否した404ではGCS呼出しも増えない。通常保存・監査・行ロックの既存比較も再実行した。

固定 `143d8d9` の旧 `_find_photo` を別プロセス内だけで再生すると、対象1行取得の比較試験が失敗する（旧経路にはJOIN計数がない）。本番ファイルは戻していない。再生用一時ハーネスは最初にcp932でgit出力を読んで失敗したためUTF-8を指定して取り直した。最初のPG試行はログディレクトリ不足で試験自体が起動せず、作成後に実行した。これらを合格試験数に含めない。

`f115212` 時点の確認（以下のschemaログ補正前）: バックエンド全体1,005件成功/141件skip、フロント全体1,385件成功、全e2e95件成功、構文170ファイル、ruff・compileall成功。隔離PG16/18各16件は、通常の全体pytestでskipする接続変数を明示して別に実施した。既存の写真表示・固定写真等の対象28件も成功した。詳細/ソースhashは [TARGET_VALIDATION.json](perf_stage4/TARGET_VALIDATION.json)。

本番フロント資産は変更しておらず、固定WebKit画像比較は今回再実行していない。e2eはChromiumの架空/ローカルAPIであり、実iPhone・実DB・実GCS・BFCacheの証明ではない。検証用PGコンテナ2件は所有ラベルを確認して停止・自動削除済み。既存コンテナと別作業のdocs/archive/は保持した。

## 4. GCS条件付きGETの保留理由

導入済みSDKは google-cloud-storage 2.14.0 / google-resumable-media 2.10.0 / google-api-core 2.31.0。[調査記録](perf_stage4/SDK_READ_BUDGET_REVIEW.json) に対象ソースhashを保存した。

- `google.cloud.storage._helpers._api_core_retry_to_resumable_media_retry` はRetryの期限をresumable-mediaのmax_cumulative_retryへコピーする。
- mediaの `wait_and_retry` はtotal_sleepを加算して再試行可否を判定するが、失敗したI/O自体の経過時間を引かない。例えば30秒ずつ失敗した通信が複数回あると、待機時間の合計が小さくても60秒を超え得る。
- metadataのRetry期限も実行中の通信を打ち切る期限ではない。requestsのtimeoutを全操作の実時間上限と同一視できない。

したがってretryのtimeoutだけを設定して「metadata30秒/media60秒以内」を達成したとは扱えない。設計5.2の保留条件に従い、新しい外側の再試行・retry=None・通信途中で裏I/Oを残すthread timeoutを導入しない。SDK更新やtransportの新設も今回のついでには行わない。

次は、SDKの実呼出経路で経過時間と各試行の残り時間を管理できる方式を、既存の再試行条件・回復率と両立させる設計に補足する。その方式をレビュー・検証してから、原画像generation固定・v2派生・ETag/304を実装する。現行v1の同名原画像置換で古い派生が残る問題も、その部分まで未解消。対象行取得の成功だけでPERF-R14を完了扱いにしない。

## 5. 残件と戻し方

実DB/GCSのR25、実団体列/PK/FK/整合性・接続ロール、共有参照/複数団体の実データ、実ブラウザ転送量・実機は未確認。今回新たな実環境接続や棚卸しを行っていない。4C着手前には#150の別仕様・修正レビューが必要で、4D有効化前には同不具合の修正検証とロール分離等の条件も必要。

読取の戻し方は、写真取得委譲を従来の対象アルバム内検索へ戻す。DBスキーマや画像ファイルの復元・削除は不要。削除ガードや回収を導入した状態のrollbackではなく、本変更にそれらは含まれない。push・PR作成・マージ・デプロイ・実環境有効化は行っていない。

## 6. 配備前の必須schema確認

本番・TESTの両方で、`public.albums` と `public.album_photos` に **NOT NULLのorganization_id** があることを実DBで確認してから、この対象写真取得を含む版を配備する。現時点では両環境とも未確認であり、配備条件未達。列がないと原画像・サムネイルともRuntimeError/500になるため、隔離試験の成功では代用しない。[リリースチェックリスト](PRODUCTION_RELEASE_CHECKLIST.md) 2章にも必須条件として記載した。

各環境に対応する接続先を確認し、読取専用トランザクションで以下を実行する（今回実行したものではない）。

```sql
BEGIN READ ONLY;
SELECT table_schema, table_name, column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('albums', 'album_photos')
  AND column_name = 'organization_id'
ORDER BY table_name;
ROLLBACK;
```

各環境で2表の2行が揃い、両方とも `is_nullable = 'NO'` であることが必要。0/1行、YES、照会失敗、接続先未確認は保留する。環境名・確認日時・配備対象コミット・表/列/NULL許容の結果を記録し、DSN・資格情報は記録しない。データ整合性・PK/FK等の既存条件も別に残し、列確認だけでR25全体を完了としない。確認中に列を追加・NOT NULL化するDDLを自動実行しない。

列存在の実行時ガードで止まった場合は、`src.backend.repositories.album_repository` のERRORログに `PERF-R13 album photo lookup blocked: <table>.organization_id is missing; deployment schema prerequisite not met` を出す。固定の表名のみで、団体・写真・利用者の識別値や接続情報は含めない。これは列存在の診断であり、NOT NULL検証を要求ごとに追加したものではない。例外・HTTPの挙動は変更しない。

## 7. 再試行の締切＋最後の要求timeout案の判断

提案はmetadataの設計候補として残す。ただし今回の「全体時間予算」の定義は変更せず、GCS条件付きGETの保留も解除しない。

metadataのgoogle-api-core Retryでは、再試行の判定時刻に締切を使うので、最後に開始した要求のtimeoutを足す考え方は有用。ただしrequestsのtimeoutは単一要求の厳密な総経過時間上限ではなく、接続/読取待ち・資格情報更新等の区間を同じものとして扱えない。「締切10秒＋timeout10秒＝約20秒」は条件付きの運用目安であり、保証値にするにはSDK実経路と遅延注入で検証する必要がある。

本文のresumable-mediaは依然として実経過時間ではなく累積sleepを判定するため、同じ式は適用できない。仮に1回10秒で失敗する通信を3回、累積sleepを1秒＋2秒とすると、sleep予算10秒内でも経過は約33秒になる。これはSDKの計数方式からの説明例で、実GCSで測った値ではない。metadataだけの式を本文にも流用し、PERF-R14全体の条件を満たしたとは扱わない。

次の設計補足ではmetadata/mediaを分け、操作期限・最後のI/O・実際の要求timeoutの意味と回復率を定義して比較する。SDK更新、再試行停止、transport新設を今回のschema診断の変更に混ぜない。

## 8. f115212レビューの補正検証

2026-10-23、schema診断ログと配備前確認条件を追加した。新規の列欠落ログ2件＋既存の写真表示8件、計10件が成功。両表それぞれの欠落でSELECT前に停止すること、理由がログに出ること、団体/写真識別値をログへ出さないことを確認した。ruff・compileallも成功。今回の変更はエラー経路のログと文書だけで、正常時のSQLや画像処理は変更していないため、全体pytest・フロント全体・e2e・隔離PG・WebKit比較は再実行していない。3章と既存TARGET_VALIDATION.jsonはf115212の履歴として保持し、今回の結果とソースhashは [SCHEMA_GUARD_REVIEW_VALIDATION.json](perf_stage4/SCHEMA_GUARD_REVIEW_VALIDATION.json) に分けた。

実DBへの照会・DDL・配備は行っておらず、本番/TESTのNOT NULL確認は依然未完了。今回のログ追加はその確認を代用しない。
