# 第3段階A 修正前計測・隔離PostgreSQL試験 v1.0

2026-10-22。基準は[第3段階設計v1.1](PERF_STAGE3_DETAILED_DESIGN.md)。承認済み設計・調査資料は先に文書のみの`39e1315`へ分離した。本資料はその後の3A成果物であり、3Bのマイグレーション適用や3C/3Dの有効化ではない。

## 1. 環境と再現方法

ローカルDockerの既存イメージPostgreSQL 16.14 / 18.4を用いた。各版は別の使い捨てコンテナで、接続ポートは127.0.0.1にだけ公開した。実DB_URL、実データ、GCS、本番/TESTへの接続は使用していない。実環境のPostgreSQL版は未確認なので、どちらかを本番同等とは扱わない。

試験は[tests/backend/test_perf_stage3a_postgres.py](../tests/backend/test_perf_stage3a_postgres.py)。専用変数PORTAL_PERF_STAGE3_DB_URLが未指定ならスキップする。接続先はloopbackかつDB名portal_perf_stage3aに限定し、アプリのDB_URLを暗黙に転用しない。試験用schemaを生成し、試験後にそのschemaだけを削除する。HTTP計測は専用DBのpublic表をTRUNCATE・再投入するため、必ず専用の使い捨てDBを使う。

再実行例（コンテナ公開ポートを指定。PORTAL_PERF_STAGE3_REPORTは任意）:

```powershell
$env:PORTAL_PERF_STAGE3_DB_URL='postgresql://perf_stage3a@127.0.0.1:<local-port>/portal_perf_stage3a'
$env:PORTAL_PERF_STAGE3_REPORT='docs/perf_stage3a/BASELINE_POSTGRES18.json'
.venv/Scripts/python.exe -m pytest tests/backend/test_perf_stage3a_postgres.py -q
```

計測先のアプリ設定は試験内で一時的に上書きし、終了時に戻す。TestClientのlifespanを実行せず、起動時の初期投入や外部サービスを起動しない。APIルーター・モデル検証・シリアライズ・既存ミドルウェア・本来のリポジトリと共通プールは実物を使う。計測のためのラッパーは元の関数を呼び、応答や取得データを差し替えない。

## 2. 架空fixtureと計測条件

| データ | 標準量 | 2倍量 |
|---|---:|---:|
| 団員 | 100 | 200 |
| 演奏会 | 10 | 20 |
| 予定 | 200 | 400 |
| 出欠 | 5,000 | 10,000 |
| イベント / 回答 | 20 / 1,000 | 40 / 2,000 |
| アルバム / 写真 | 20 / 500 | 40 / 1,000 |
| payments / part_settings / org_settings / sns_settings 各集合 | 30 | 60 |

端末は架空の1件。団体も架空の1団体。IDは投入した親・団員の範囲で結び付ける。PERF-R28とCDE設計の件数を使用し、実データをコピーしない。今回の8経路が読まないその他extraは未投入。performance_pieces/payment_performance_feesは空で、子のSQL取得経路は通るが、非空子の転送量・処理量の基準にはならない。

HTTP用schemaは既存ensure_db_schema_compatibilityとメニューmigrationで生成した互換schema。全migrationの再現・実制約やインデックスの同等性確認ではない。トリガー検証は別schemaに明示的なFKとCASCADEを持つ親子表を作る。

8経路×2データ量×3状態×5回=240サンプル/版、合計480サンプルを保存した。

- cold200: プロセスメモリと団体列判定キャッシュを消して初回取得。
- warm304: 本文とETagを保持した状態で条件付き取得。
- cleared_memory304: 同じETagを送り、本文メモリだけ消して取得。他プロセス切替の実測ではなく、その状態の模擬。

OS/DBのページキャッシュ、接続プール、ネットワークを冷却した計測ではない。Accept-Encodingはidentity。端末のHTTPキャッシュ・IndexedDB・HAR・実ブラウザは今回測っていない。2版の最終試験は同じホストで並行実行しているため、所要時間を版の優劣や実環境の受入閾値に使わない。

## 3. 計測した値

保存先:

- [PostgreSQL 16の240サンプル](perf_stage3a/BASELINE_POSTGRES16.json)
- [PostgreSQL 18の240サンプル](perf_stage3a/BASELINE_POSTGRES18.json)

sqlはラッパーを通ったアプリSQLの実行数。xmin_sqlはそのうちxmin集約を含む文数。checkoutsはpooled_psycopg.connectから実際に接続を得た回数で、同時接続数や新規TCP接続数ではない。プールの内部health check等はアプリSQL数に含めない。

connection_acquire_msは接続コンテキストへの入場時間（health check等を含む）。pool_queue_wait_msはプール統計requests_wait_msの差分で、これらを混同しない。connection_body_hold_msは取得後yield内の保持時間で、返却処理まで含めた厳密な貸出時間ではない。sql_roundtrip_msはcursor.executeの経過時間で、fetch・変換・シリアライズをすべて含むDB処理時間ではない。

payload_buildsは既存の一覧・紹介response・bootstrap本文構築関数の呼出数。CPU時間そのものではない。application_body_bytesはTestClientで受けた本文長で、HTTPヘッダーや圧縮を含む実回線転送量ではない。

標準量・両PG版で一致したSQL/貸出/本文構築回数:

| 経路 | cold200 SQL / 貸出 | warm304 SQL / 貸出 | メモリなし304 SQL / 貸出 | warm304本文構築 |
|---|---:|---:|---:|---:|
| bootstrap-lite | 34 / 19 | 13 / 11 | 13 / 11 | 0 |
| bootstrap-core | 1 / 1 | 1 / 1 | 1 / 1 | 0 |
| performances | 4 / 1 | 0 / 0 | 2 / 1 | 1 |
| schedules | 2 / 1 | 0 / 0 | 1 / 1 | 1 |
| announcements | 2 / 1 | 0 / 0 | 1 / 1 | 1 |
| events | 2 / 1 | 0 / 0 | 1 / 1 | 1 |
| members | 2 / 1 | 0 / 0 | 1 / 1 | 1 |
| member-introductions | 5 / 3 | 3 / 3 | 3 / 3 | 1 |

liteのwarm304ではxmin集約10文を行う。5一覧はwarm304でDB読取がない場合でも、メモリから本文を構築・モデル検証して判定する。団員紹介の貸出3回は、端末・団員・紹介用SELECTによる。これは第3段階の「認証を含む接続1本」が現状では未実装であることを数値で示す。

計測結果だけで新経路の高速化を達成済みと扱わない。3Dでは版SELECTのコストが加わるため、既存warm304がSQL0の一覧も含め、削減する本文構築と増えるSQLを両方比較する。

## 4. 隔離PostgreSQLで確認したこと

各版9試験（PG原理7件＋HTTP計測2件）が通った。版トリガーは試験内のプロトタイプで、実装用SQLとして配布・適用しない。

| 原理試験 | 確認した結果 | 設計との対応 |
|---|---|---|
| 文レベルI/U/D・0行・rollback・団体変更 | 複数行INSERTは1回、0行UPDATEは0回、rollbackで版も戻る。団体移動で旧新両方更新 | S3-02の原理部分 |
| FKカスケード | 親削除後も子OLDの団体を使って更新。親・子で各1回 | S3-02の原理部分 |
| executemany / 同値UPDATE | 10行のexecutemanyは10回、同値UPDATEも保守的方式では版が増える | 4.3・9.1 |
| UPSERT / 複数団体 | 影響した遷移行だけで団体版を更新 | S3-02の原理部分 |
| RRと別接続の確定 | 読取中に別接続で変更しても本文・版は旧組で一致、次の読取で新組になる | S3-04の原理部分 |
| READ ONLY / SET LOCAL / pool返却 | 書込を拒否、返却後に同じbackend PIDを再貸出しても同期GUC・timeout・READ ONLYが漏れない | S3-08の原理部分 |
| 版行ロックの競合 | 異なる親行へのUPDATEでも版行で競合し、試験用lock_timeoutで停止できる | S3-11の原理部分 |

最後の原理試験は1秒で終了させるために試験接続へlock_timeout=1sを設定する。通常アプリ書込へその値を適用した検証ではない。通常書込の既存5秒はソースを変更していない。

同値UPDATEの報告は「追加版更新1、追加200になり得るもの1」。将来のHTTP版ETagを実装していないため、実際の追加200件数・転送量はnullのままにし、測定済みへ置き換えていない。

## 5. 実行記録と残件

- PostgreSQL 16: 9件成功。
- PostgreSQL 18: 9件成功。
- 追加試験ファイルのruff: 終了コード0。
- 追加試験ファイルのcompileall: 終了コード0。
- 専用DB変数なしの実行: 新試験9件がスキップ、既存HTTPキャッシュ試験23件成功。

Windowsの制限付き実行では既存_pydantic_core DLLの読込が拒否されたため、pytestは承認された制限外実行で確認した。アプリや依存ライブラリを変更して回避していない。

初回のHTTP計測は架空fixtureの任意文字列・時刻をNULLで投入したため応答モデル検証で失敗した。fixtureを画面APIで扱う型・空値に直し、元のモデル検証を変更せずに再実行して全件通過した。保存JSONはその成功した最終実行で作り直した。

3A全体の完了とはしない。残件は以下。

- 非空の子集合、別団体・権限取消、直接SQL後の旧メモリ、新旧リビジョン並行、通常保存・監査との負荷を含む修正前計測。
- 全体5秒、入場＋接続2秒、入場1.5秒後getconn0.5秒、取消・枠解放、追加接続禁止の実装に接続する試験。今回の原理試験だけでS3-01〜16を合格にしない。
- 本番相当migration・制約・インデックスの隔離再現と、実DBメタデータの取得。実環境の版・ロール・接続余力・ワーカー実測は引き続き未確認。
- ダイジェスト、同期モードのロール検証、復元後の世代確定は将来の実装と統合して確認する。

アプリのソース・migration・workflowは変更していない。フロント・バックエンド全体・全e2e・WebKit画像比較は本作業では再実行していない。3B以降の実環境適用条件は未達のまま。push・PR変更・デプロイは行っていない。

今回作成した試験コンテナ2件はタスクラベルを照合して停止した。--rmの使い捨てDBであり、再実行には新しい専用コンテナを用意する。架空計測JSONは上記成果物として保持する。
