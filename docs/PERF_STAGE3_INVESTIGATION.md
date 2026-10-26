# 第3段階 調査結果 v1.1

## 1. 対象と証拠の区分

調査日: 2026-10-22。コード基準: `ce526c2`、ブランチ `perf/portal-stage2cde-20261022`。本書と[詳細設計](PERF_STAGE3_DETAILED_DESIGN.md)は、第3段階のPERF-R04（DBの更新検知）・PERF-R05（整合読取・接続制御）を対象とする。ソース、DB、デプロイ設定は変更していない。

「コード確認」はこのSHAの静的調査、「設定確認」はCloud Run APIの読取結果、「未確認」は実行結果を取得できなかった事項。「設計値」は将来の実装条件で、現行値や検証済み性能を意味しない。過去の会話の行番号・挙動より、現在のコードを優先した。

第2段階の実機/BFCache、実DB・GCS計測、キャッシュ整理時の端末メモリ・容量見積りは継続課題。今回それらを完了扱いにしていない。第3段階の調査・設計とローカルPostgreSQLでの試験整備は進められるが、実DBへの移行と有効化には後述の確認が必要。

## 2. DBスキーマと団体列

`src/backend/core/db_schema.py`の`JSON_COLLECTION_TABLES`には30親テーブル、`DB_CHILD_TABLES`には7子テーブルがある。トリガーの依存定義は、この既存定数と`DB_CHILD_PARENT_KEYS`から生成する。下表は調査時の表示用であり、別の手書き設定として実装しない。

| 親コレクション | 子テーブル |
|---|---|
| performances | performance_pieces |
| date_adjustments | date_adjustment_candidates |
| payments | payment_performance_fees |
| castings | casting_members、casting_extras |
| desired_pieces | desired_piece_votes |
| albums | album_photos |

`004_multi_tenant_organization_id.sql`は既存36テーブルへ団体列を追加する。後発の`concert_record_videos`等には個別マイグレーションがある。ただしファイルの存在は、本番・TESTへの適用証明ではない。`db_row_repository.table_has_organization_id()`には団体列なしの分岐が残り、判定をプロセス内にキャッシュしている。

親を参照して子の団体を決める方式は、親のカスケード削除に弱い。設計では対象の親・子自身の`organization_id`を必須とする。実DBで列の欠落・NULL・親子不一致があれば、業務データを推測で`default`へ寄せず、移行前に由来と補正を確認する。

`menu_visibility_settings`は上記37表の外側にあり、`016_menu_visibility_settings.sql`で団体列を持つ。lite/coreの本文・ETagの依存先なので、追加の版管理対象とする。`portal_json_collections`は汎用互換保存で、現行読取はcollection_nameのみをキーにする。団体列があるものとして扱わず、対象APIへの到達がある場合は個別分類が終わるまで版による省略を有効化しない。

## 3. 更新経路とトリガー

| 経路 | 確認した現状 | 設計への影響 |
|---|---|---|
| db_item_repository / PostgresRowStore | 行単位更新、独自トランザクション、保存競合のsave_busy | 既存の排他・結果契約を維持しDBトリガーで捕捉 |
| db_json_repository | 行読取、認証端末操作、replace_collection、ロック付き変更 | 互換ファサード経由も捕捉。二重接続を解消 |
| promotion_repository / portal_notice_repository | 独自接続・専用更新処理 | 一律の互換全置換へ戻さない |
| menu_settings_repository | メニュー設定をUPSERT | 専用版を更新、lite/coreへ反映 |
| 同期スクリプト | executemanyによるUPSERTと不要行DELETE | 通常の更新経路。特別保守として除外しない |
| 直接SQL・旧Cloud Runリビジョン | アプリ側の版更新を通らない可能性 | DBトリガーが必要。権限・トリガー状態の点検も必要 |

現在の`replace_collection()`は、promotionsを拒否し、albumsを含む行単位コレクションの通常全置換も制限している。過去のレビュー時点の「albumsを無条件に全置換できる」を、そのまま現状の事実として引き継がない。一方、内部の`_replace_collection_in`、明示的な一括経路、同期のDELETEは別途対象であり、入口だけの検査では不十分。

文レベルトリガーでも、`executemany()`がSQLを行ごとに送れば発火は行数相当になる。同じ団体×集合の版行のロックは確定まで保持されるため、文単位への変更だけで保存の直列化が消えるわけではない。同期の全面的な集合SQL化は計測まで保留する。

## 4. 読取・認証・ETag

- `db_json_repository.py`に`psycopg.connect()`が11か所ある。`load_auth_device_by_device_id`と`load_member_by_id`を含め、それぞれがプール接続を取得する。外側で接続を保持しただけでは「要求1件につき1本」にならない。
- 現行の集合ETagは親・子のCOUNTとxmin集約等から作られる。複数SQLがautocommitで動くため、本文と同一スナップショットを保証する実装ではない。
- 現行の`bootstrap._collection_etag()`はDBダイジェストを先に試し、失敗時などにメモリETagへ戻る。`combined_collection_etag()`もDB側のcallbackを優先する。旧資料の「メモリ優先」は現在のコードには当てはまらない。
- `json_collection_service.load_json_data()`は通常集合でメモリを先に返す。albums/promotionsはDB優先、sheet_libraryは専用APIという例外がある。新しい版だけを読む変更では、200の本文に旧メモリ値が混ざる危険が残る。
- 第2段階の`PortalCacheRoute`は一覧の本文を構築・検証した後にハッシュ化する。現在減らせるのは主に転送量であり、304だからDB読取が省略されるとは限らない。
- liteは8集合とメニュー、coreは現状の軽い本文とメニューに依存する。fullはno-store。第3段階でbootstrap v2や項目削除を追加する必要はない。
- データAPIの認証は端末と現在の団員を読み、書込はしない。一方`GET /api/auth/devices/{id}`はlast_seen_atの更新や期限切れ端末の削除を伴うので、READ ONLY対象にできない。
- テナントミドルウェアは現在、団体ヘッダーまたは既定値からコンテキストを設定する。性能変更で団体の選択・認可規則を変更しない。フロントが通常ヘッダーを送らないことと、サーバーがヘッダーを扱うことは区別する。

## 5. 接続・実行環境

`db_pool.py`はプロセスごとに最小1・最大5接続。`db_connection()`はpool未準備だけでなく、DSN不一致や追加kwargsがある場合にも直接接続へ分岐する。これを本番に残すとプール上限を迂回する。現行は、合意済みの「入場待ちと接続待ちの合計最大2秒」を満たす共通期限を持たない。通常書込の`db_item_repository.LOCK_TIMEOUT`は既存の5秒で、読取の1秒とは別の値として維持する。

起動は`lifespan.py`でプール準備→自己点検→初期データ投入の順。JSONローカルモードは別分岐なので、本番の直接接続を禁止するために起動順を変える必要はない。

監査は`call_next()`後のfinallyで、同期的な主体取得とINSERTを行う。応答送信完了後とは限らない。現在、主体の端末・団員取得とINSERTには別々のプール貸出があり、同じ最大5接続を使う。認証再利用は第2段階E1で保留中。監査の接続を「第6の接続」と数えず、要求本文の読取コンテキスト外の利用として予算に含める。asyncミドルウェア内の同期処理によるイベントループ停止時間も分けて計測する。

## 6. 同期と保守

通常同期は`sync_prod_to_test_db.py`によるUPSERT・逆依存順のDELETEで、pg_restoreではない。取得元0件なら対象表を全削除する。ソースはREPEATABLE READ READ ONLY、TESTは書込トランザクションを使う。auth_devices、監査・アクセスログ、プロモーション関連等に除外があるため、同期対象定数から検査対象を生成する。

ワークフローはTESTバックアップ→メンテナンスと排出→DB同期→GCS同期→メンテナンス解除。第3段階ではDBとGCS両方の成功後、解除前にTEST固有の世代を更新する工程が必要。gcs_onlyによる再開でも完了判定を省略しない。

独立した`restore_db.py`はpg_restoreの`--clean --if-exists --no-owner --no-acl`を使用し、`--disable-triggers`は指定していない。ただし復元はDDLを含む別経路であり、完了後のトリガー存在・有効性と新世代発行の検証は必要。

同期用接続はGitHubのPROD_DB_DIRECT_URL / TEST_DB_DIRECT_URL、実行アプリはCloud RunのDB_URL。名前が異なるだけではDBロールの分離を証明できない。通常同期で使う実ロールは未確認。アプリが自由にSETできるGUCだけで同期・保守を許可しない。

TESTの団体データは同期で上書き・削除され得る。専用計測領域が自動で保護されるとは扱わない。標準の架空fixtureをリポジトリ側に保持し、隔離ローカルDBで計測するか、同期後にTESTへ再投入して世代を更新し直す方式が必要。

## 7. 実環境での確認結果

Cloud RunサービスをAPIで読取確認した。プロジェクト`kanade-orchestra`、リージョン`asia-northeast2`。

| 項目 | 本番 | TEST |
|---|---|---|
| サービス | kanade-orchestra | kanade-orchestra-test |
| 100%配信先リビジョン | kanade-orchestra-images-20261020 | kanade-orchestra-test-images-20261020 |
| containerConcurrency | 80 | 80 |
| 最大インスタンス設定 | 3 | 3 |
| 要求タイムアウト秒 | 300 | 300 |
| 実行 | uvicorn、workers引数なし | 同左 |
| WEB_CONCURRENCY / UVICORN_WORKERS | 設定なし | 設定なし |
| データモード | DB | DB |

起動指定は単一ワーカー相当だが、実行中のプロセス数を観測した結果ではない。現在配信中のリビジョンが今回のローカルブランチと同じだとは扱わない。

両DB_URLの設定上のユーザー名は一致した。ただし接続できていないため、current_user・権限・接続先クラスタ・同期ロールとの一致は未確認。認証情報・接続先ホストは本書やログへ転記していない。

本番・TESTとも接続タイムアウトを設定し、read-onlyとSQL時間制限を指定してメタデータ読取を試みたが、TCP接続がタイムアウトした。SQL結果は取得していない。実団体列、制約、DBバージョン、トリガー、max_connections、使用中接続数は未確認。「該当なし」「0件」と解釈しない。Cloud SQL/GCEの当該プロジェクトの一覧も空だったが、外部DBがないことの証明ではない。

ローカル調査時のサニタイズ済み採取物は`.tmp/perf-stage3/`に保持した。本書には必要な許可項目だけを転記しており、Cloud Runの生JSONやDB_URLは成果物に含めない。

## 8. 設計への反映と残件

| 確認事項 | 今回の結論 | 完了させる手段 |
|---|---|---|
| 実DBの団体列・親子一致 | 接続できず未確認 | 到達可能な承認済み運用環境からメタデータと不整合件数を読取 |
| DB・同期のロール | アプリの設定ユーザー一致のみ確認 | current_user/session_user、権限、同期接続の同項目を照合 |
| ワーカー数・実接続予算 | 設定確認済み、実測未実施 | TESTでプロセス数、pool統計、DB接続数を負荷と併せて観測 |
| 版トリガーの性能・カスケード | 未実装・未試験 | 本番相当PostgreSQLの隔離DBで競合・遷移テーブル試験 |
| 読取削減量 | 未計測 | 同一データ・操作でxmin集約/本文構築/新しい版SELECTを比較 |

以上は設計書作成の妨げではないが、実DB移行・新読取の有効化を承認済みと扱う根拠にはならない。第3段階は設計・隔離試験→追加DB構造→整合読取→版による省略の順に分ける。物理ファイル回収、権限ロールの全面設計、同期処理の全面書換え、画面変更は含めない。

今回の資料検査: Python ASTで30親・7子と初回12物理表の依存閉包を照合し、2資料のローカルリンク・空の章の有無・受入試験S3-01〜16の記載を確認した。アプリケーションの試験、実DBでのSQL実行・競合試験、実機の確認は実施していない。Cloud Runの設定取得は実施したが、接続タイムアウトをDB検査の成功に数えていない。作成物は文書2ファイルのみで、コミット・push・PR変更は行っていない。
