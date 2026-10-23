# 第4段階4-0 通信・書込・保守経路の棚卸し v1.0

2026-10-23。[設計v1.1](PERF_STAGE4_DETAILED_DESIGN.md) のPERF-R25と、4A/4Cの実装前調査。設計承認は文書のみの `43c88c3`。本資料はその後の4-0成果物である。

本番ソースの読取で確認した経路と、汎用関数が持つ到達能力を分ける。実DB/GCSを読んだ結果ではない。実データの件数・保存容量・参照整合性・ロールを未確認のまま0や正常と記録しない。変更・削除は実施していない。

## 1. 読取・通信経路

パスは `src/backend/` を基準とする。HTTP入口は現在のrouter registryから登録されている。写真GETに新しい認証を加える調査ではない。

| ID | 入口 / 経路 | 現在の読取・通信と対象 | 証拠 / 4Aで維持する点 |
|---|---|---|---|
| R01 | GET `/api/extra/albums` | albums一覧と写真子集合 | `routers/albums.py::get_extra_items` → `extra_service.list_items` → `json_collection_service.load_json_data`。DBモードのalbumsは古いメモリ本文を使わない |
| R02 | GET `/api/bootstrap` | full payloadにalbumsが含まれる | `services/bootstrap_service.py::bootstrap_payload`。lite/coreの契約変更と混同しない |
| R03 | GET `/api/albums/{album_id}/photos/{photo_id}` | 対象親のgetと子集合全体から写真を探索。その後、原画像をGCS downloadまたはローカルFileResponse | `album_service._find_photo/_original_response`。DB参照確認が先。GCS原画像にサービス側ETagはない |
| R04 | GET 同 `/thumbnail` | 同じ写真探索 → v1派生画像をdownload。NotFoundなら原画像download・変換・派生upload | `album_service._thumbnail_response`。正常なキャッシュヒットはmetadata 0、派生media 1。写真GETはworker pool上で実行 |
| R05 | DB row storeのget/list | 対象アルバムまたは集合のSQL読取と子集合attach | `db_item_repository.PostgresRowStore.get/list/_select`、`attach_collection_children`。実SQL/貸出/返却行数は今回未計測 |
| R06 | ギャラリーと写真拡大 | 一覧は `/thumbnail`、明示選択で原画像URL | `src/static/js/modules/albums.js`。loading=lazy、既存レイアウト・順序を維持 |

写真ルートの団体はmiddlewareのX-Organization-Id/X-Tenant-Idまたは既定値で決まる。公開GETであっても対象団体と親子の照合を維持する。今回のHTTP計測は既定の架空団体だけで、団体間の実DB分離を証明しない。

## 2. 通常書込・互換経路

「1tx」はrow storeの `autocommit=False` の処理を示す。GCS操作はそのDB txとは別である。現在はalbum v2 SET LOCAL、世代台帳、回収候補、配信leaseは実装されていない。

| ID | 入口 / 関数 | 到達根拠 | tx・写真への影響 / 4Cでの扱い |
|---|---|---|---|
| W01 | POST `/api/extra/albums` | HTTP登録あり、`extra_service.create_item/create_row` | 認証/権限確認後row insert。写真付きpayloadの最終受理範囲は境界試験で固定する。v2設定と内部asset検証が必要 |
| W02 | PUT `/api/extra/albums/{id}` | HTTP登録あり、`extra_service.update_item/update_row` | 1txで親ロック・更新・子全置換。親名だけの更新でも `_write_children` が走る。写真差分へ変更する |
| W03 | DELETE `/api/extra/albums/{id}` | HTTP登録あり、`extra_service.delete_item` | album作成者/管理者を判定し、store.deleteが子→親を削除。原画像/派生の物理削除をこの経路では実行しない。OLDから候補化が必要 |
| W04 | POST `/api/extra/albums/{id}/photos` | HTTP登録あり、`album_service.upload_album_photo` | GCS UUID/create-only upload→1txでグローバル写真ID割当と親update。現在は写真追加でも子全置換。確定generationの登録が必要 |
| W05 | DELETE 同 `/{photo_id}` | HTTP登録あり、`album_service.delete_album_photo` | 写真所有者/管理者判定→親update→commit後 `_delete_unreferenced`。現在団体の全album参照確認後に世代条件なしの原画像delete。回収へ置換 |
| W06 | upload後DB失敗の補償 | W04の例外分岐 | `_delete_unreferenced` を使用。自己UUIDでも世代不明の即時削除へ残さず、補償候補とその登録失敗の追跡が必要 |
| W07 | `album_service.create_album/update_album/delete_album` | 公開サービス関数として存在。今回検索では本番呼出元を確認できず | AlbumRepository→BaseRepository→row store。HTTP経由だけをガードしても防げないため対象。削除/統合は別の未使用棚卸し |
| W08 | `BaseRepository.save_all` / `save_json_data` / app_core互換 | 任意collection指定が可能。albums直書き呼出しはtestsで確認、本番src/scriptsでは未検出 | 通常DB replaceのrow-level拒否はある。動的nameや外部保守の未使用までは証明しない |
| W09 | `db_json_repository.replace_collection(..., allow_bulk=True)` | 汎用内部機能として存在 | 1txで `_replace_collection_in` に到達。通常replaceが拒否されることと、この迂回可能性を分ける。albumsでは通常用途を禁止する |
| W10 | `db_json_repository.mutate_collection_locked` | 任意collection、互換 `mutate_json_data` から呼出可能 | 1txのadvisory lock→読取→ `_replace_collection_in`。通常replaceの拒否を経由しない。albumsでの実呼出未確認でも禁止対象 |
| W11 | PostgresRowStoreのinsert/update/delete/update_columns/update_many、内部SQL | 汎用storeとして存在。全てがalbumsの実呼出を持つという意味ではない | 主なupdateは子全置換、update_columnsは列更新。DBガードで全I/U/DとTRUNCATE、内部asset省略の参照も検査する |
| W12 | `_replace_collection_in` / db_insert_rows / db_upsert系 | 低位のSQL helper。公開APIとは別 | 子の再登録やsource空のDELETEが可能。上位サービスのv2設定だけに依存せずDBで拒否/許可を確定 |

APIの認可は `extra_collection_helpers.assert_extra_collection_permission`、写真単体は `album_service._can_delete_photo` に分かれる。現在の作成者/所有者/管理者の判定をasset UUIDの有無に置き換えない。

今回、実PostgresRowStoreの `_write_children` と子変換/INSERT helperを、SQLを送らない記録cursorに対して呼んだ。25/50枚の写真を変えずに親名だけ変えた入力でも、各呼出しが子DELETE 1文と写真全数のexecutemany INSERTを生成する。親updateからこのhelperへ進むことはコードで確認した。これは全update tx/実DB trigger/ロックの計測ではない。

## 3. 同期・復元・修復・保存先

| ID | 経路 | 現状 / 未確認 | 第4段階への接続条件 |
|---|---|---|---|
| M01 | `scripts/sync_prod_to_test_db.py` | 対象にalbums/album_photos。autocommit=False、UPSERTと不要行DELETE。source 0件は全DELETE | 実session_userの同期許可を確認し候補0。内部asset UUIDをそのまま環境間コピーしない |
| M02 | `scripts/sync_prod_to_test_gcs.py` | 明示的な本番→TESTの差分。既存のgeneration条件でコピー/削除 | 通常7日回収と混ぜない。DB/GCS完了後の台帳再照合・世代更新が必要 |
| M03 | 同期前backup / manifest | `backup_test_environment_pre_sync.py`、`check_backup_manifest.py` の固定prefixはsheets/とalbums/、録音は有効日付prefix | `album-thumbnails/` は現行対象に入らない。派生画像までバックアップ/同期済みと報告しない |
| M04 | `scripts/restore_db.py` | pg_restore --clean/--if-exists。--disable-triggersは使わない。復元前後に第3段階clockを確認 | 回収停止・復元元bucket/環境を不採用・再照合後に再開。今回は実行していない |
| M05 | `scripts/repair_album_photo_metadata.py` | 明示execute時、psycopgの1txで親を確認し、失われた既知6写真のメタデータだけINSERT。dry-runあり | 既存維持対象。ガード導入時の許可プロトコルとasset登録を対応。実行/バックアップ取得は今回行わない |
| M06 | 手動SQL / 外部ツール | コードから全利用者/接続を列挙することはできない | 実ロールの一覧と書込権限調査が残る。アプリロールへ保守権限を追加しない |
| M07 | `services/production_ops_service.py` の同期計画 | 同期対象名とprefixを持ち、既存workflowを動かす運用入口 | 実装時、計画表示とスクリプト定数の差分を照合。UIから新しい回収操作を追加しない |
| M08 | ローカルJSON / UPLOAD_DIR | 明示ローカルモード・試験のみ。FileResponseとv1派生保存あり | 本番DB Onlyを変えず、ローカルファイルの物理回収を本段階で追加しない |
| M09 | `drive_storage.py` のbucket設定 | 設定レコード/環境からbucketを得る。現在の写真行にbucket/generation列はない | keyに現在設定のbucketを無条件に当てて回収しない。実bucketの変更履歴・設定の実値は未確認 |

派生画像が同期対象外であることは現在の再生成可能なキャッシュとして説明できるが、4Cで派生assetをDBへ保存した後も「コピー済み」として扱うことはできない。再生成/再紐付けまたは未解決としての保留を9章の同期手順に接続する。今回は同期仕様を変更しない。

## 4. 原画像・派生画像の現行対応

- 原画像は新uploadで `albums/<album_id>/<JST日付>/<UUID>_<filename>`。create-onlyのgeneration=0条件で作成するが、応答の確定generationは写真行へ保存していない。
- 写真にはid/album_id/url/object_nameまたはpath/filename/uploaded_at等がある。実DBの列・型・制約は未確認。コードのDB_CHILD_COLUMNSにはasset UUID/generationの項目はない。
- v1派生keyは `repr((tenant, object_name, path, url, uploaded_at))` のSHA-256。原画像generationは含まず、派生keyはDB列へ保存していない。
- 同じsource keyでも、団体/url/uploaded_atの違いで別の派生keyになり得る。原画像1件対サムネイル1件とは断定せず、現在写真ごとに再計算して実オブジェクトへ照合する。
- 反対に、source keyの本文だけが外部で変わり他の入力が不変なら、v1 keyは変わらない。模擬HTTP試験では原画像は新本文なのにサムネイルが旧本文のままになる現状を固定した。実データで発生したと断定しない。
- DB参照を消した写真のGETは、GCSの派生キャッシュが残っていてもDB確認で404になる。これは維持する挙動。
- 原画像/派生の実存在・共有・孤児・容量は未確認。「見つからない」「参照がない」「所有者が不明」を同じ削除候補に分類しない。

## 5. 実環境のR25棚卸しで残る作業

本章は `55d624c` 時点の棚卸し計画。この時点では接続情報を.envやCloud Runから取得せず、実環境への接続も行っていない。その後、[PG追加計測資料8章](PERF_STAGE4_0_POSTGRES_BASELINE.md) でCloud Run設定をメモリ内だけで確認し、READ ONLY接続を試みたが、接続は確立できなかった。下記の実データ棚卸しは引き続き未実施である。

1. 明示した接続先/期待DB/環境/bucketを照合し、実接続ロールと権限を読取専用で確認。DBはREAD ONLY、statement timeoutとconnect timeoutを付ける。
2. 全団体の親子の件数、PK/FK/団体列、孤立/親子不一致、object_name/path重複、原画像参照と他の保存先参照の重複を集計。個人名やファイル名を公開成果物へ出さない。
3. DBの保存先参照と原画像・v1派生のkeyを照合し、GCS list/get metadataのgeneration/sizeと突き合わせる。prefix全体に参照がないだけで削除可能とは断定しない。
4. bucket/IAM/保持/soft deleteと、同期・保守の実ロールを確認。外部の直接書込・保存先変更を調査する。
5. 正常/欠落/共有/未参照候補/未解決を集計し、制限された原本と匿名化集計を分けて保存。台帳の登録/修復/削除は実行しない。

初回棚卸し時点では、上記の実環境棚卸しと、隔離PGでのSQL・競合・監査を含む基準計測は未完了だった。4-0全体や4D有効化条件を完了扱いにしない。

後続で隔離PGのSQL・競合・監査の最初の基準は採取した（PG追加計測資料）。実環境・複数団体/共有参照・長時間の一括処理等を含む受入の残件とは区別する。

## 6. 今回の境界

R18/R19の録音再生・汎用GCS最適化は第5段階5Bのまま。新しい削除ガード、asset台帳、lease、GC CLI、migrationは実装していない。#145/#146とnpm audit依存更新も別の作業として残す。
