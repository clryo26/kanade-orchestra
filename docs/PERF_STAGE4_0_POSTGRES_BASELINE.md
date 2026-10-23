# 第4段階4-0 PostgreSQL・接続・競合の修正前計測 v1.1

2026-10-23。[詳細設計v1.2](PERF_STAGE4_DETAILED_DESIGN.md) と [4-0の計画](PERF_STAGE4_0_BASELINE.md) に従う追加成果物。基準HEADは `92d0e6d`、本番ソースは `4ed586d` から変更していない。第4段階の実装・migration追加・有効化ではない。

## 1. 実施範囲と安全条件

[試験コード](../tests/backend/test_perf_stage4_postgres.py) は、明示した `PORTAL_PERF_STAGE4_DB_URL` だけを使う。アプリDB_URLや.envから接続先を推定しない。loopbackかつDB名 `portal_perf_stage4` を接続前に検証し、接続後にもcurrent_databaseを照合する。既存のpoolがあれば止め、未所有の表があるDBは初期化を拒否する。初回以外は `stage4_fixture_owner` の所有識別も確認する。

Dockerの既存イメージPostgreSQL 16.14/18.4から別々の使い捨てコンテナを作り、127.0.0.1:63816/63818だけに公開した。DBユーザーは専用のperf_stage4。PGDATAは各コンテナのtmpfs `/perfdata`、fsyncは両方on。専用DBのpublic schemaだけを各試験で作り直し、架空データを投入する。実DBへのDDL/DMLは行っていない。

本番のルーター、認証、モデル処理、row store、共通pool、監査middleware/サービスを使用する。SQL cursorは本来のexecute/fetchを呼び、poolのラッパーも本来のgetconn/putconnを呼ぶ。GCSだけは架空の辞書に置き換え、実GCS Clientの作成を拒否する。TestClientのlifespanは実行せず、起動時seed/外部通知を動かさない。Webのpool必須スコープは明示的に実行する。

各版15件成功。各版のHTTPは1,563要求、両版で3,126要求。4件は接続先拒否の単体試験であり、実PGを使う試験は各11件。SQL・接続の機能/局所計測であって、実Cloud Runの性能・接続数・永続性の証明ではない。2版を同じPCで並行実行したため、時間の優劣も比較しない。

## 2. schemaと架空データ

既存stage3Aのseed_baselineを再利用し、標準/2倍の団員100/200、予定200/400、出欠5,000/10,000、イベント20/40と回答1,000/2,000、アルバム20/40と写真500/1,000等を投入した。演奏会の曲目と会計子集合も非空。写真は1親25枚になるよう配置し、固定4画像の原画像と派生を架空GCSへ置く。

認証端末と団員1を架空管理者にし、認証も監査主体の再取得も実DBから読む。HTTP計測対象は1架空団体。複数団体・本番の認可・全データを網羅したものではない。

schemaは既存の互換schema生成、メニューmigration016、監査migration002で用意した。**全migrationの再現ではない。** 第3段階のread context/版ETagは無効、第4段階のガード/台帳/leaseも未実装。実DBと同じ制約があるとは仮定しない。実際の隔離schemaの列・制約は [ISOLATED_SCHEMA.json](perf_stage4/ISOLATED_SCHEMA.json) に保存した。FK/cascadeを含む新ガードの合格判定は4Cで別に必要。

この互換schemaではalbums/album_photosともid主キーとorganization_idのNOT NULLを確認したが、album_photosからalbumsへのFKはなかった。本計測の親子削除は現行repositoryの明示DELETEであり、実FK cascadeの試験と取り違えない。実DBにもFKがないと推測せず、4Cの適用前確認を残す。

写真GETの測定では派生キャッシュをwarmに固定する。`cold_columns_warm_thumbnail` は団体列の判定キャッシュだけを消し、`warm_columns_conditional_probe` はそれを保持してIf-None-Match:*を送る。OS/PG/GCS/ブラウザのcold/warmではない。現在はどちらも200。

## 3. 値の定義

- sql_statements: アプリのexecute 1回を1文、executemanyはパラメーター行数の文として計数。executemanyのPython呼出し1回をSQL1文にしない。ネットワーク往復数でもない。
- execute_calls/executemany_callsは別に保存。アプリのSET LOCALを含み、driverが内部送信するBEGIN/COMMIT/ROLLBACKは含まない。pool health checkの空クエリは除外する。
- fetched_rowsは実cursorのfetchone/fetchallが返した行数。PGが走査した行数・共有buffer読取数とは異なる。
- checkoutsはpoolからの延べ貸出数。同時接続数やTCP新規接続数ではない。photo GETは認証なしの公開経路を維持している。
- connection_acquire_msはgetconn全体の経過時間。pool_queue_wait_msはpoolのrequests_wait_msの差分で、前者と同一ではない。同時waveでは要求ごとに重複配賦せずwave全体の差分を記録する。
- connection_held_until_putconn_msはgetconn後からputconn開始まで。pool返却処理が終わるまでの厳密な貸出時間とは異なる。
- SQL/checkoutをbody、audit_actor、audit_writeに分ける。audit_elapsed_msは主体取得と書込を含む監査呼出し全体。
- audit_callback_delay_msは監査の直前に同じloopへ予約したcallbackが動くまでの遅れ。監査時間のほかにscheduler/ほかの処理を含み、監査INSERTだけのCPU時間とはしない。

原本JSONは [PG16](perf_stage4/POSTGRES16_BEFORE.json)、[PG18](perf_stage4/POSTGRES18_BEFORE.json)。旧画像計測・固定画像計測・過去の検証JSONは上書きしていない。

## 4. 写真GETのSQLと接続

各版60バッチ（2データ量×3表示枚数×2状態×5回）、1,520 GETを記録した。以下の回数は両PG版・両データ量・全反復で一致した。

| 表示枚数 | 状態 | アプリSQL文数 | 延べ貸出 | 実fetchした写真子行数 |
|---:|---|---:|---:|---:|
| 1 | 団体列判定cold | 7 | 1 | 25 |
| 1 | 団体列判定warm・条件付きprobe | 5 | 1 | 25 |
| 25 | 団体列判定cold | 127 | 25 | 625 |
| 25 | 団体列判定warm・条件付きprobe | 125 | 25 | 625 |
| 50 | 団体列判定cold | 252 | 50 | 1,250 |
| 50 | 団体列判定warm・条件付きprobe | 250 | 50 | 1,250 |

warmの写真1要求はSET LOCAL 3文、親SELECT 1文、子集合SELECT 1文。coldでは最初に団体列の確認2文が追加される。したがって写真1枚に対し子集合25行を実際にfetchしていることを、架空storeの推定ではなく実cursorで確認できた。

4Aの対象写真JOIN/取得の比較では、この子fetchを対象写真分に限定できるか、SQL/貸出/転送の追加負荷がどうなるかを測る。HTTPが25要求ある以上、「ギャラリー全体の接続が必ず1本になる」とは説明しない。台帳後の304でもDB照合は残る。

修正後は実fetch写真行数（25 GETの625行から25行を比較目標）と親/子SELECT文数を主指標にする。404の区別に必要な親照合を含む実際の文数を比較し、25回の貸出が減らなくてもSQL/行数の効果を独立して評価する。

## 5. 写真を変えない親名変更と監査

各版10 PUT（2データ量×5回）。**同じ写真25枚をpayloadに明示して、変更するのは親名だけ**とした。汎用PUTへ名前しか送らない試験とは分離する。

1 PUTにつき写真子DELETE 1文/25行、executemany INSERT 25文が実行される。SQL総数40〜42（団体列判定cacheで変動）、延べ貸出6、監査INSERT 1件。監査表へ実際にcommitされている件数も確認した。

貸出の内訳は、body3回（認証の端末/団員2回、更新tx1回）、audit_actor2回（端末/団員）、audit_write1回。**監査は主体取得とINSERTだけで計3貸出**であり、主体を端末だけの1読取と仮定して2回にしない。6貸出は順次の延べであり、pool上限5との矛盾ではない。

この計測で、親名変更でも写真全数の書直しが発生することを実DBで確認した。4Cではアルバムの差分更新に限定してこれを削減し、他集合の保存方式は変更しない。

## 6. 競合と同一イベントループ

### 行ロック

別の検査接続で親行をFOR UPDATEし、実HTTP PUTがLock待ちに入ったことをpg_stat_activityで確認した。待ちの間にも写真GETは200を返す。検査接続はアプリpool外で、pool予算の実運用値に加算するための接続ではない。

- 解放ケース: 検査接続がcommit後、保存200。要求時間は局所計測で約71〜80ms。
- timeoutケース: 通常書込の既存5秒でsave_busyの503。要求時間は約5.03〜5.05秒。写真子DELETEには到達しない。

これはTestClientを別スレッドから呼ぶ制御試験であり、同一ASGI loopの実験ではない。次のwaveと分ける。通常書込の上限を1秒へ変更していない。

### 同一loopのwave

各データ量で、httpxのASGI経路を同じasyncio loopに載せ、写真GET8件と、写真付き親名PUT4件を同時投入した。全12要求200、監査4件がcommitされ、総写真数も500/1,000のまま。poolの測定中最大貸出は各wave5。

PUT4件とGET8件で延べ32貸出。監査直前callbackの最大遅れは約11〜17ms。10ms周期のheartbeatの観測間隔最大は約32〜58msだった。同期の更新処理・監査・framework・同一PC上の他負荷を含む値で、監査だけに全遅延を帰属させない。wave全体のpool待ち統計と要求別の取得時間をJSONで分けた。

これは12要求の制御された局所負荷で、Cloud Run同時実行80・複数インスタンス・長い一括登録/同期の受入ではない。監査を本段階で背景化/スレッド化しない。

第3段階の監査・イベントループ待ちの修正前追跡値としても参照する（[第3段階実装記録](PERF_STAGE3_IMPLEMENTATION.md)「受入の追跡と残件」）。第3段階の新経路は無効の基準であり、有効化後の負荷や監査だけの遅延を証明しない。

## 7. 別に記録する既存のPUT挙動

名前だけを送る別の架空API試験では、PUT成功200、写真が空の応答となり、その親の写真25行がDBから除去された。汎用payloadの正規化が写真省略を空集合にする現状による。監査も1件commitされ、GCS削除は行われない。

これは現在のAPIの置換的な挙動を確認したもので、画面からのデータ損失が発生したと断定しない。`modules/albums.js` の明示呼出しには汎用PUTによる名前編集が見当たらないが、動的なname/URL指定や外部利用まで未使用と証明したわけではない。4Cの性能変更のついでに省略項目の意味を変更せず、変更する場合は独立した仕様/レビューが必要。

[別不具合 #150](PERF_STAGE4_ALBUM_PUT_ISSUE_DRAFT.md) として起票済み。現在は未修正。現状のGCS未削除と、将来の4C/4Dで候補・7日後の物理削除につながる危険を区別する。詳細設計v1.2の3/7.1/8.1/12/14章に、4C着手前の別仕様・修正レビューと、4D有効化前の修正・検証完了を必須条件として追加した。

## 8. 実環境の読取専用確認

[READ_ONLY_ENVIRONMENT.json](perf_stage4/READ_ONLY_ENVIRONMENT.json) は2026-10-23の再確認結果。gcloudの本番/TESTサービスdescribeをメモリ内で解析し、APP_ENVの一致を確認。接続値やユーザー名は保存せず、設定上のロール識別はfingerprintだけにした。

取得した設定へconnect_timeout5秒、接続開始からdefault_transaction_read_only=on、statement_timeout5秒、lock_timeout1秒を指定して接続を試みた。両環境とも接続が確立せず、OperationalError/timeoutとして記録した。クエリ段階へ到達していないので、実件数・実制約・実session_user/権限はnullのままである。DB名・資格情報・raw errorをログ/成果物へ出していない。

設定上の本番/TESTのロールfingerprintは同じだが、アプリと同期の実session_userが同じか、権限が分離できているかは未確認。GCSの設定bucketは存在するが、実際の有効保存先とDB参照を照合できないため、今回は実GCSのlist/get/削除を一切行わなかった。接続のための設定/権限/ネットワーク変更も行っていない。

したがってR25の実DB/GCS棚卸しは未完了。DBへ到達可能な承認された読取実行経路が必要であり、隔離DBの結果で代用しない。新しいCloud Run Jobやmigrationを勝手に配備して接続問題を解消しない。

## 9. 再実行と検証

専用コンテナは `POSTGRES_DB=portal_perf_stage4`、loopback公開、試験用ユーザーで用意する。本試験は専用schemaの初期化を伴うので、実DB_URLを流用しない。

```powershell
$env:PORTAL_PERF_STAGE4_DB_URL='postgresql://perf_stage4@127.0.0.1:<専用ポート>/portal_perf_stage4'
$env:PORTAL_PERF_STAGE4_PG_REPORT='docs/perf_stage4/POSTGRES16_BEFORE.json'
.venv/Scripts/python.exe -m pytest tests/backend/test_perf_stage4_postgres.py -q
Remove-Item Env:PORTAL_PERF_STAGE4_DB_URL
Remove-Item Env:PORTAL_PERF_STAGE4_PG_REPORT
```

DB変数が未指定なら、接続先拒否の4件だけを実行し、実DB試験11件はskipする。報告変数は全件を実行するときだけ指定する。不完全な件数のJSONを保存しない。

各版15件、全体ruff、compileallを確認した。最初の計測準備では監査表をfixtureへ適用していなかったため監査SQLが失敗し、写真を省略したPUTの期待も不適切だった。実ソースを変更せず、監査migration002のfixture適用と、写真を明示する比較条件に直し、全件を取り直した。以前の3つの依存警告は残る。最終の検証/ログhashは [POSTGRES_VALIDATION.json](perf_stage4/POSTGRES_VALIDATION.json) に記録する。

フロント全体・バックエンド全体・e2e・実ブラウザは今回再実行していない。本番ソース変更なしの追加計測として専用試験を実行した。検証コンテナ2つは所有ラベルを確認して停止・自動削除済み。既存の他作業用コンテナには触れていない。

4-0で残るものは、実DB/GCSのR25、実際の接続ロール/DB制約/保存先、複数団体・共有参照/欠落・一括処理との追加ケース、実ブラウザ/SDK/メモリ/実機の確認。4A・4C・4Dは未実装で、マージ・デプロイ・実環境有効化も行っていない。
