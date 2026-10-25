# 第4段階4C 第5単位：写真の内部参照と同期境界

2026-10-25。設計7.3の写真内部参照・公開JSON保護と、9章の環境間UUID持込み防止を実装する。**実画像の登録・backfill・状態ガード・候補生成・lease・物理回収の完成ではない。** 024の有効化禁止は維持し、実環境への適用・紐付けは行わない。

## 1. Migration 026

`026_album_photo_asset_references.sql`を追加する。既存024/025のチェックサムは変えない。ガード禁止制約、台帳owner、albums/album_photosのNOT NULL団体列、参照する写真の識別列が存在することを確認してから変更する。実適用にはバックアップ・書込排出・実schema/所有者の確認が必要。

album_photosにnullableな`original_asset_id` / `thumbnail_asset_id`を追加する。定数の`original_asset_kind` / `thumbnail_asset_kind`も追加し、NOT NULLの既定値とCHECKでoriginal/thumbnailに固定する。4列とも内部専用である。複合FKにより、原画像の種類、派生の種類と親原画像の一致をDBで検査する。派生だけの登録はできない。FKのため台帳へ2つの複合UNIQUE、写真側へ2つの参照索引を加える。PKと重複して見える索引も、複合FKに必要なものである。実データの索引容量・登録負荷はR25/R28の残件とする。

生成STORED列の代わりに定数既定値を使い、隔離PG16/18ではheapのfilenodeが変わらないことを確認した。これは実DBでのDDL所要時間・ロック時間を測った結果ではない。既存行のUUIDはNULLのままで、generationを推測して埋めない。

BEFORE UPDATEの`album_detach_changed_photo_asset()`はSECURITY INVOKER、search_path=pg_catalog、PUBLIC実行権限なし。新しい非ownerの既定関数権限が残る場合はmigrationを止める。NEW/OLDだけを扱い、アプリへ台帳の権限は付与しない。

| 写真の変更 | 内部参照 |
|---|---|
| 親名称、写真省略、同じ写真、filename等のmetadataのみ | 両方保持 |
| object_name / pathの変更 | 原画像・派生をともにNULLへ外す |
| url / uploaded_at / organization_idの変更 | v1派生キーの要素なので派生のみ外す |

外した参照に対する候補生成は後続のAFTER文トリガーでOLDから行う。現在は候補を作らず、即時GCS削除のserviceも変更しない。ownerによる実環境の手動backfillを本単位で許可したとは扱わない。UUIDと実key/generation、asset状態の照合も後続である。

## 2. 公開JSONと通常更新

4列の定義はstartupをimportしない`services/album_asset_fields.py`へまとめる。`db_row_to_json(..., 'album_photos')`で4列を除外するため、一覧、RowStore.get、対象写真取得の公開表現へ出さない。他の表の同名フィールドは削らない。

子の書込列は従来のpublicなDB_CHILD_COLUMNSを維持する。クライアントのUUIDやkindをSQLへ渡さない。名称変更や省略では既存の差分更新により子を触らず、写真のmetadataを更新する場合も内部列をSETしないので、ロック後の現在の紐付けを保持する。新規写真はNULLのままである。

既存のSELECT *は維持し、内部列はDB取得後に公開JSONから除外する。アプリ発行SQLの増加はないが、DB内部の読取バイト増分を0と報告しない。この実データ上の値は未計測。公開本文の項目・順序やサムネイルの既存キーは変更しない。

**配備順**: 内部列を除外するサーバーを先に配備し、古いserializerの全リビジョンと処理中要求を排出してから026を扱う。旧JSは同じ公開本文を受け取る。古いサーバーはSELECT *の新列を公開し得るため、DDL後に旧serializerへトラフィックを戻さない。今回これらの配備は行わない。

## 3. DB同期

同期のTableSpecは写真の4列をsource/targetの輸送列から外す。4列がそろわないschemaや型が違うschemaは拒否する。旧schemaには追加照会なし。片側が旧schemaでもpublic列が一致すれば比較でき、PROD UUIDをTESTへコピーしない。

TEST側が新schemaなら、最初のテーブルDMLより前に、album_photosのSHARE ROW EXCLUSIVEロックをNOWAITで取得する。書込が排出されていなければ即座に失敗し、1件でも解決済みUUIDがあれば、**再照合処理未実装として同期を止める**。成功時はcommit/rollbackまでロックを保持し、確認後に別セッションが紐付ける競合を防ぐ。NULLしかない場合だけ従来のUPSERT/不要行DELETEへ進む。これは同期CLIの入口での制約であり、任意の直接SQLを保護するものではない。

この拒否は、UUIDを無条件に消したり、古い世代のままGCS同期を続けたりしないための暫定境界。後続の信頼済み同期モードとTEST台帳再照合を実装してから置き換える。gcs_only、復元、GCS直接保守については、このDB前検査だけでは保護できない。再照合と停止条件がそろうまで、実環境へ026を単独適用・実画像を紐付ける運用は行わない。同期/バックアップ用SELECT権限の確認も引き続き必要。

## 4. トリガーの負荷計測

[PG16](perf_stage4/STAGE4C_REF_COST_PG16.json) / [PG18](perf_stage4/STAGE4C_REF_COST_PG18.json)にrawサンプルを保存する。制御行を用意してguard=falseの状態で、今回までの名前付きuserトリガーだけを無効/有効にする。nativeなFKは外さない。25枚のINSERT/DELETEは各5回、別の親に属する写真を8セッションが1行ずつ更新する波は各1回。全変更はrollbackして戻す。

8セッションのUPDATE後に全員がbarrierへ到達してから終了することで、共有制御行のロックを持つ8つのtransactionが共存できることも検査する。DBへ直接接続した計測であり、アプリのプール上限5・同じ親のロック・認証・監査・親のDML・GCSは含まない。接続・barrier・commitの時間も除外する。

| 操作 | PG16中央値 ms（無効→有効） | PG18中央値 ms（無効→有効） |
|---|---:|---:|
| 写真25枚INSERT | 1.094 → 1.371 | 0.984 → 1.816 |
| 写真25枚DELETE | 0.971 → 1.264 | 0.928 → 1.105 |
| 8セッション別行UPDATE | 1.324 → 3.762 | 3.732 → 3.558 |

有効時のプロトコル関数はINSERT/DELETEで各25回、UPDATEで各セッション1回。参照解除関数はUPDATEで各1回。PGのtransaction内関数統計から数えた値で、Python発行SQL文数ではない。時刻の値は共有開発機の負荷・順序・キャッシュの影響を受け、同時書込では大小関係も逆転している。実Cloud Runの上乗せや有効化可否をこの少数サンプルで断定せず、文単位ロックへの変更も今回は行わない。

## 5. 残件と戻し方

[検証記録](perf_stage4/STAGE4C_REFERENCES_VALIDATION.json)に結果を保存する。実DB/GCS/R25、状態と実key/generationの照合・登録、候補生成、lease、既存即時削除の置換、同期全工程とgcs_onlyの再照合、実ロール、旧サーバー並行稼働、実機・WebKit画像比較は未完了。4Dの有効化・AP150-T12の合格とは扱わない。

戻す場合も列・台帳をDROPせず、公開JSON保護は維持する。内部UUIDが存在するDBへ古いserializerや古い同期実装を戻さない。完全なガード/回収導入後は、既存設計どおりワーカー停止とDBガード維持で復旧する。

実環境へのDDL適用・紐付け・有効化、push・PR・マージ・デプロイは行わない。docs/archiveと#150独立worktreeは保持する。

## 6. 最終検証（2026-10-25）

- バックエンド全体：1,085件成功、274件skip。PostgreSQLを必要とする試験は別途実行した。既存の警告3件あり。
- フロント単体：1,385件成功。構文検査170ファイル、compileall、ruff、共有ZIPの安全検査は成功。
- 隔離PostgreSQL 16 / 18：各133件成功（今回の参照の試験12件、計測1件、既存の120件）。専用コンテナは停止・削除済み。
- e2e：通常の並列設定では2回とも94件成功・1件失敗。1回目はモバイルホームのconsole監視で `net::ERR_NO_BUFFER_SPACE`、2回目は出欠編集直後の `timeHidden` の判定で失敗した。各ケースの単独再実行は成功した。
- 全e2eを `npm run test:e2e -- --workers=1` で実行し、95件成功。通常の並列設定での失敗原因は未確定で、解消したとは扱わない。今回、フロントのソース・e2eの期待値・Playwright設定は変更していない。

単独・直列実行の成功で通常設定の失敗を置き換えない。実DB/GCS・実ロール・実機・WebKitの確認に加え、通常設定のe2eの安定性の確認も未完了として引き継ぐ。全検証のコマンド、終了コード、ログのhashは検証JSONに記録する。
