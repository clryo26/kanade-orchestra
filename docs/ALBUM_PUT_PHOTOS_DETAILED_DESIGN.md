# Issue #150 アルバムPUTの写真省略を安全に扱う別仕様・詳細設計 v1.1

作成日: 2026-10-24（JST）。調査基準: `0060e1c`。対象: [Issue #150](https://github.com/clryo26/kanade-orchestra/issues/150)。**状態はv1.0レビューを反映した別仕様・未実装**。性能改善4Cの差分更新と分けて修正・レビューするための別仕様であり、本書の作成で4C着手・4D有効化の条件を満たしたとはしない。マージ・デプロイは最後にまとめる。

## 1. 解決する問題と対象外

汎用 `PUT /api/extra/albums/{id}` で `photos` を省略しただけで写真メタデータがすべて消える問題を修正する。提案する契約は **省略は保存済みの写真を維持、明示的な空配列だけが全写真参照の削除**。未検証の入力を空集合として受け入れない。

名前だけのPUTを安全に扱うため、省略された `created_by_member_id` と `created_by_member_name` も現在の行から維持することを提案に含める。これは写真保持と別のAPI差分なので、レビューで明示的に確認する。親の全項目を一律に部分更新へ変える提案ではない。

対象はalbumsの行更新、PostgresRowStoreと明示ローカルJSONのListRowStore、そこへ到達するHTTP/互換サービス。写真の追加・削除専用APIの権限と正常操作は維持する。他集合、親の作成/削除、ID割当、時刻仕様、親子全置換の差分SQL化、GCSの物理回収、ロール、migration、GCS条件付きGET、新しい画面要素や正常操作の文言変更は対象外。型不正の422 detailだけはR04の日本語文言を既存の警告へ渡すAPI差分として扱う。

実DBの欠損調査・復元は別作業。本書だけでメタデータ修復スクリプトを実行したり、既存ファイルを削除したりしない。

## 2. 現行経路の調査結果

| ID | 経路 | 確認済みの現状 / この修正での扱い |
|---|---|---|
| AP150-P01 | `routers/albums.py::update_extra_item` → `extra_service.update_item/build_update_mutate/update_row` | HTTP登録済み。実効payloadを正規化するが、現在行と全面mergeしない。認可はロックした現在行で行う。共通行更新で補正する |
| AP150-P02 | `parse_extra_upsert_request` | 平坦JSON、payload辞書、payloadのJSON文字列を処理し、expected_updated_atを分離。photosの有無は実効 `upsert.payload` で判定する。外側の同名項目で上書きしない。parser全体の仕様は変えない |
| AP150-P03 | `PostgresRowStore.update` | 親ロック・現在行/子集合読取 → 期待版確認 → mutate → 親全列UPDATE → `_write_children` の子全DELETE/INSERT。省略された子を空集合へ変換する |
| AP150-P04 | `ListRowStore.update` | ロック・現在行 → mutate結果で保存データを置換。省略された写真が結果から落ちる。DBだけ修正して終わりにしない |
| AP150-P05 | `album_service.update_album` → AlbumRepository/BaseRepository.update | 公開関数は存在。本番の明示呼出元は検索で未検出。現行mutatorはcurrentとpayloadをmergeするので省略写真を既に維持する。共通の行更新へ到達する |
| AP150-P06 | `upload_album_photo` / `delete_album_photo` | 専用HTTP入口。currentを基にphotosを明示してstore.updateへ進む。uploadは事前のUUID/create-onlyと全団体一意ID、deleteは写真所有者/管理者判定とcommit後の既存ファイル処理を持つ。これらを変更しない |
| AP150-P07 | `modules/albums.js` / `saveExtra` | createAlbumEventはphotos:[]付きPOST。saveExtra自体もPOSTだけ。写真追加/削除は専用API、アルバム削除はDELETE。汎用PUTで名前を編集する明示呼出しは見つからない。動的URL/外部利用の未使用までは証明しない |
| AP150-P08 | `update_columns/update_many` | 親列の更新で子全置換を呼ばない。photos部分更新の新しい入口にはしない。既存用途を変更しない |
| AP150-P09 | save_all/save_json_data、allow_bulk、mutate_collection_locked、低位SQL | 集合全体の置換へ到達可能。行更新の省略契約を自動適用できない。今回の修正で安全になったとは扱わず、4Cの全経路禁止/DBガードの対象として残す |
| AP150-P10 | 同期UPSERT/DELETE、pg_restore、修復スクリプト | HTTPの部分payloadとは別の保守契約。今回変更・実行しない。4C以降に同期/保守モードと候補0を検証する |

`normalize_extra_for_collection` はalbumsをそのまま返す。ExtraUpsertRequestにもphotosの既定値はない。根本原因は「Pydanticがphotos:[]を補完する」ことではなく、mutate結果にphotosがなく、後段の `db_child_rows_for_collection` が `_list_or_empty(parent.get("photos"))` を通すため空集合になること。`normalize_extra_payload` はsystem項目を整えるが現在行の一般項目を補わない。

親の作成者2列も更新対象であり、名前だけのmutate結果には両項目がない。実際のdb_row_tupleではその更新値がNULL/NULLになる。これは入力変換で確認した結果であり、今回実DBへ書き込んで再現したものではない。

### 2.1 アルバム以外の子集合の省略棚卸し（v1.1追加）

[調査JSON](perf_stage4/ISSUE150_SIBLING_COLLECTION_AUDIT.json) に11ケースを記録した。本番のサービス/collection guard/mutateとListRowStoreを使用し、load/saveだけを架空メモリ辞書に置換。子行変換も本番関数で行った。認証済みの架空主体をサービスへ直接渡しており、HTTP/認証middleware・実PGの永続化や実画面の実行試験ではない。DB/GCS/外部URLを禁止し、mainをimportしてもlifespanを起動していない。

| 集合・子項目 | サービスでの統合/拒否 | 省略した架空保存状態と子行変換の結果 | 今回の扱い |
|---|---|---|---|
| performances / pieces | 汎用extraはEXTRA_COLLECTIONS対象外で404。専用update_performanceはmergeするが、その前のnormalizeで省略piecesが[]になる | 専用・flyer keep/操作キーなしの経路で曲目1→0。汎用は保存0回で1件のまま | 別の不具合候補。専用PUTを対象とし、汎用PUTで起きたとはしない。ファイル操作/操作キー経路は追加検証が必要 |
| date_adjustments / candidates | validate_date_adjustment_payloadが省略/空を400で拒否。currentとの子mergeはしない | titleだけの更新は400、保存0回、候補1件を保持 | このHTTPサービス経路では省略で消えない。直接store.updateの到達能力まで安全とみなさない |
| payments / performance_fees・performance_fee_amounts | 汎用extraはmergeしない。別のpayment_service.update_paymentはmergeするがpaymentsルーターは空で、汎用HTTPを保護しない | 汎用で両map省略は2明細→0。feesのみ明示すると明細2件を維持しても金額100/200→0/0へ変換。mergeサービスでは1→1で保持 | 別の不具合候補。現行savePaymentStatusはfeesだけを送りamountsを省略することをコードで確認。実画面/実DBの損失は未確認 |
| castings / members・extras | 汎用extraはmergeしない | 両方省略で1/1→0/0。membersだけ明示なら1/1→1/0 | 別の不具合候補。現行UIは両集合を明示するため、この調査だけで画面障害とは断定しない |
| desired_pieces / votes | 他人の票はdesired_piece_merged_votesで統合するが、payloadに本人票がなければ本人票は戻らない | 作成者本人1票のみなら省略で1→0。本人+他人は2→他人1。未投票管理者は他人1票を維持 | 別の不具合候補として省略と明示取消の契約を確認する。「統合ありだから全員の票を常に保持」と説明しない。現行の投票UIはvotesを明示 |

上記は他集合をalbumsと同じ仕様で直す根拠にはしない。各集合の省略/空/null/部分更新と現在のUIの契約を別に確定する。修正・実PGでの再現・実データの欠損調査は未実施で、4C/4Dの直接の着手条件には加えない。[追跡資料](ISSUE150_REVIEW_FOLLOWUP.md) にIssue #150追記案と別Issue4件の本文を保存した。GitHubコメントは自動承認審査に拒否されたため未送信で、別Issueも未起票。本文の送信承認後に番号・リンクを追記する。

## 3. 修正前の確認と証拠の範囲

[ISSUE150_CONTRACT_BEFORE.json](perf_stage4/ISSUE150_CONTRACT_BEFORE.json) は9入力の実parser・純粋なmutate・子行変換と、作成者2列のDB値変換の確認結果。入力・団員・写真は架空。通常と同じmain先行importで互換ファサードを初期化し、lifespanは起動せず、psycopg.connectとstorage.Clientを禁止して実行した。最初のextra_service直接importは既存の初期化順の循環で失敗したため、通常の順にして取り直した。アプリのimport構造は変更していない。

| 実効photos入力 | 現行の子行変換結果（写真1件からの例） |
|---|---:|
| 省略（平坦/辞書wrapper/文字列wrapper） | 0行 |
| `[]` / `null` / `{}` / `"bad"` | 0行 |
| `[既存写真辞書, "bad"]` | 1行（不正要素を無視） |
| 同じ既存写真の辞書配列 | 1行 |

この確認はHTTP・認可・トランザクション・監査の新しい実行試験ではない。隔離PG16/18で25行が実際に消えた過去の証拠は [4-0計測7章](PERF_STAGE4_0_POSTGRES_BASELINE.md) / [PG16](perf_stage4/POSTGRES16_BEFORE.json) / [PG18](perf_stage4/POSTGRES18_BEFORE.json) に分けて残す。実環境や画面で同じ損失が起きたとは断定しない。

## 4. 提案する更新契約

以下は認証・現在行の認可・期待版確認を通過した更新の契約。提案の採用前に実装しない。

| ID | 入力/状況 | 決定案 |
|---|---|---|
| AP150-R01 | photosを省略 | ロック後に読み取った現在のphotosを維持。取得前のメモリ・リクエスト前のpeekから補わない |
| AP150-R02 | photos:[] | 明示的な全写真参照削除として従来どおり受け入れる。GCS削除を新たに追加しない |
| AP150-R03 | photosが辞書だけの配列 | 従来の集合置換として扱う。配列内に書いた写真を採用し、省いた写真は参照除去となる。ID/日時/団体の既存処理を維持する |
| AP150-R04 | null、文字列、辞書、数値、真偽値、配列中に辞書以外の要素 | HTTP422 `写真情報の形式が正しくありません`。一部だけ採用せず、親/写真の更新を全rollbackする。API利用者への意図した契約変更。既存のdetail警告に表示される可能性を考慮した日本語文言とし、利用者に表示されないことを前提にしない |
| AP150-R05 | 作成者ID/名前をそれぞれ省略 | 省略された項目だけ現在の値を維持する。写真が維持されても次の認可に必要な作成者情報を失わないための追加変更 |
| AP150-R06 | 作成者項目を明示 | 既存の認可と値の処理を維持。本修正で所有者移管の新制度を作らず、既存仕様の厳格化も混ぜない。認可には変更後の自己申告ではなくcurrentを使う |
| AP150-R07 | その他の親項目を省略 | 既存PUTの契約を維持。例としてevent_nameを送らない更新を、本修正だけで一般的PATCHに変えない |
| AP150-R08 | expected_updated_at不一致 | 従来の409。写真を補完して保存し直すことで競合を隠さない。未指定の旧クライアントは現行どおり受け付ける |
| AP150-R09 | 既存行にphotosがない、またはNone（ローカルlegacy） | 参照0件として扱う。DBモードでは既存の子読取結果が配列を返す |
| AP150-R10 | 既存行のphotosがそれ以外の不正型・不正要素 | 意味を推測して空集合にせず、固定の理由で停止・保存しない。入力不正422とは区別してRuntimeErrorと固定schema/data診断にする。識別値や保存値をログへ出さない |

辞書の各フィールド・ID重複/他親IDの扱いは、既存のserver-managed値補正・ID割当・DB制約に従う。新しい写真スキーマを本件で導入しない。例えばDBのPK競合を「重複を黙って捨てる」処理に変えず、エラー時に親/子ともrollbackされることを検証する。ローカルとDBの既存制約差を、この形状検証だけで解消したとは扱わない。

## 5. 実装位置と処理順

実装候補は `repositories/db_item_repository.py` のalbums専用の小さな共通補正関数と、PostgresRowStore.update / ListRowStore.updateの2か所。HTTP層だけで補うと、BaseRepositoryや内部store.updateが迂回するため不十分。db_child_rows_for_collectionを全集合の部分更新器へ変更しない。

1. 現行どおり現在行をロックして読み、現在の期待版を確認する。
2. albumsの場合だけ、mutate前のphotosと作成者2項目の値・有無を独立したsnapshotとして保持する。photosはdeepcopyし、mutateへ渡した浅いdict経由でネストが変更されても、保存済みsnapshotを壊さない。既存photosの不正型を検出しても、この時点では認可に先行して新しい外部エラーを返さず、補正時まで判定を保持する。
3. 現行のmutateを実行する。汎用APIではこの中でcurrentに対する作成者/管理者の認可を行う。認可失敗の403を、入力photosの422に変えない。現在の権限判定、version異常・期待版の既存順序も変えない。
4. albumsだけ共通補正を適用する。更新結果にphotosがなければsnapshotから補う。明示されていれば配列と全要素の形状を検証する。省略された作成者2項目もsnapshotから補う。stored photos不正の場合は、新しいpayloadの有無によらず保存せず停止し、別の修復判断へ戻す。
5. 現行どおりsystem項目・apply_server_child_fieldsを適用し、親UPDATEと子保存を同じtransactionで行う。POST/insertへ新しい省略ルールを適用しない。他集合では従来の処理をそのまま通す。
6. DBでは既存のsaved再読取結果、ローカルでは保存後の同等のphotos付き結果を返す。監査は既存middlewareで記録し、write内に別の監査やGCSアクセスを追加しない。

補正はDELETEより前に行う。UPDATEのrollback/例外・通常5秒のlock timeout・DB時計/期待版は現状維持。認可や期待版をsnapshot補完で省略しない。データのdeepcopyはalbumsにだけ限定し、全コレクションの大量コピーを増やさない。

**この修正では写真のSQL DELETE/再INSERTは残る。** 省略で論理的に写真が失われないことと、写真行の書直しが0文になることを混同しない。写真行のID・参照・日時等が保持されることを検証し、SQLの差分更新・回収候補生成の抑制は4Cで別に行う。4Cの実装前に削除トリガーや回収ワーカーを有効化しない。

## 6. 権限・既存呼出元・API互換性

汎用PUTは従来どおりアルバム作成者/管理者の更新であり、photos:[]もその認可を通る。写真専用DELETEは従来どおり写真所有者/管理者の判定を使う。この既存の違いを本件で統合・緩和しない。汎用APIを匿名利用可能にせず、別団体の親へ更新しない。

追加/削除専用サービスはphotosを明示し、uploadのUUID/create-only・全団体で一意の子IDと補償処理、deleteのcommit後処理を維持する。元のFileを保持するフロントや、保存結果不明の扱いは変更しない。新しいUI・通知は作らない。

意図するAPI差分は、写真省略時の保持、不正形状の422、省略作成者2項目の保持、保存済み不正写真型の停止のみ。**photos:null は、現行の空集合/全削除扱いから422拒否へ変わる。全削除するAPI利用者はphotos:[]を明示する。**未確認の外部API利用者が「省略で削除」を期待している場合は、空配列を明示する必要がある。利用がないと断定せず、リリース説明にこの契約差分を記載する。明示的な写真集合の変更・全削除は引き続き許可され、既存のHTTP成功形式は変えない。

## 7. 試験と計測の設計

| ID | 実行経路 | 合格条件 |
|---|---|---|
| AP150-T01 | 本物router→parser→mutate→PG16/18、平坦/辞書wrapper/文字列wrapper | photos省略PUTで親名だけ変わり、写真25行のID/参照/所有者/保存日時が一致。応答photos25件、作成者2項目も保持 |
| AP150-T02 | 同じ経路でphotos:[]、同一集合、追加/変更/一部削除 | 明示集合どおりになり、空配列だけが0写真となる。ID/日時のserver管理は既存契約どおり |
| AP150-T03 | null/文字列/辞書/数値/真偽値/混合配列 | 認可成功後422、detailは上記の日本語文言。親名/期待版/写真の確定状態は変更前と同じ。子DELETEに到達しない |
| AP150-T04 | ローカルListRowStore＋実HTTP、直接store.update、AlbumRepository/album_service.update_album | 共通行更新を通るすべてで省略写真を維持。legacy欠落/Noneは空、stored不正型は保存しない。mutateのネスト変更でsnapshotを壊さない |
| AP150-T05 | 作成者・一般の他人・管理者・システム管理者・未認証・別団体 | 既存401/403/404等を維持。第三者が不正photosを送っても認可を422で上書きしない。作成者が省略PUT後も同じ権限を保つ |
| AP150-T06 | 期待版一致/不一致/未指定、同じtimestampのZと+09:00 | 競合409・旧クライアント互換・JST時刻の既存判定を維持 |
| AP150-T07 | 別接続で写真uploadを先に確定し、名前PUTを待機させる | ロック後の最新集合を保持し、事前peekの集合で上書きしない。削除が先の場合は削除写真を復活させない。逆順も確認 |
| AP150-T08 | row write途中例外、PK競合、rollback、lock timeout | 親と写真の原子性を維持。save_busyの既存5秒・既存detail.codeを変更しない |
| AP150-T09 | 写真追加/削除とアルバム作成/削除の既存回帰 | 専用APIが動作し、写真の所有者/管理者判定・upload補償・GCS削除呼出しの条件が変わらない |
| AP150-T10 | 名前PUT/422/403/409、実監査 | 通常の監査内容・対象・statusの意味を維持。拒否された要求の監査まで0件と期待しない。監査を含む貸出と本体の貸出は分ける |
| AP150-T11 | 既存4Aの写真GET/サムネイルとフロント | 表示・404・キャッシュキー・画像本文・原画像選択時だけ取得する挙動を維持 |
| AP150-T12 | 将来の4Cの実DB guard/候補と組合せ | 省略/同一集合で実質的な参照解放/回収候補0、明示的な削除だけ候補、rollback候補0。4Cが未実装の間は未実行として残す |

追加する試験は `tests/backend/test_album_put_photos.py` と専用の隔離PG試験を候補とする。接続先はloopback・専用DB・所有マーカーを必須とし、アプリDB_URLや.envを暗黙利用しない。既存4-0/4Aの「写真省略で0行」の試験は修正後の新契約へ更新するが、保存済みBEFORE JSONを上書きしない。API差分の修正前/修正後を別ファイルへ記録する。

基準量は親20/40、写真500/1,000（対象親25枚）、固定4写真。同じ写真行・参照・HTTP結果・監査、SQL/貸出/lock待ちを比較する。子の書直しは今回残るため、SQL削減を完了条件にしない。純粋変換9ケースの実行を、上記の新契約の合格試験へ流用しない。

実装後はcompileall・ruff・バックエンド全体・フロント構文/全単体・全e2eを最終ソースで実施し、必要な写真表示のWebKit/実機は自動試験と分けて記録する。実DB/GCSは接続・書込・修復・削除を別の最終リリース手順へ委ねる。

## 8. 導入・戻し方・完了条件

1. この別仕様のphotos契約と作成者2項目の保持をレビューし、性能改善とは別の修正単位として確定する。
2. source変更と回帰試験を実装し、PG16/18・ローカル・専用APIで比較する。今回の資料作成ではここへ進んでいない。
3. 修正レビューの完了後、4Cの着手条件の「#150の別仕様・修正・回帰試験レビュー」が済んだ記録を残す。4Cで初めて実装できるAP150-T12は、4C着手条件へ循環依存させず、その時点では未完了と明記する。
4. 4Cのguard/候補ができた段階でT12を実施し、別不具合修正と参照/候補が整合することを確認する。4D有効化条件は、この検証とロール分離・実DB/GCS等の他条件も満たしてから判断する。T12前にIssue全体・4Dが完了したとは報告しない。

物理回収は本件に含めず、今回の実装だけで有効にならない。旧サーバーへ戻すと省略による写真除去が再発するため、rollback中は汎用アルバム更新を停止するか安全な対応版を配備する。schema追加は不要で、DBを巻き戻して修復したと説明しない。後に4C/4Dが導入された場合は、既存設計どおりワーカーを停止し削除ガードを維持する。

この別仕様で新たに実データを修復しない。既存の欠損の有無は未確認であり、修復が必要なら実データ・原画像・バックアップを読取照合したうえで別途扱う。4A配備前の本番/TESTのNOT NULL団体列確認も依然未完了で、本件の設計・隔離試験では代用しない。

## 9. 今回の成果物と残件

今回の成果物はこの設計案と、現行変換の9入力/作成者列の確認JSON、既存設計からの参照のみ。src・tests・DB・GCS・設定は変更していない。新契約の試験、隔離PGの追加実行、全体試験は未実施。旧資料・旧測定値を新契約の検証結果に読み替えない。

基準0060e1cの履歴は第2/3段階・第4段階4-0/4Aを含む。今回の差分は文書だけであり、mainからの独立した不具合修正PRが既にできたとは説明しない。実装時は変更ファイルの依存を確認し、不具合修正と性能改善を独立してレビューできるcommit/PR単位にする。

作成時の整合確認: 入力9ケースと作成者NULL/NULLの変換結果、記録したソースhash、要件AP150-R01〜10と試験設計AP150-T01〜12、ローカル参照リンク、旧計測JSONの非変更を確認した。`npm run check:release-safety` は全項目PASS。ソース・試験コードを変更していないため、pytest・フロント全体・e2e・隔離PGは今回実行していない。

## 10. v1.0レビューへの追跡

| ID | 指摘 | v1.1の反映 |
|---|---|---|
| AP150-REV-01 | 他の子集合の省略時の棚卸し | 2.1章と11ケースのJSON。mergeだけでなく事前normalize/入力拒否/本人票除去を区別し、別Issue4件の原稿に分離 |
| AP150-REV-02 | 422の英語文言 | R04とT03で日本語「写真情報の形式が正しくありません」。既存のdetail警告に出る可能性を前提とする |
| AP150-REV-03 | nullの変更を明記 | 6章のAPI差分にphotos:nullの全削除扱い→422と、photos:[]の明示を記載 |
| AP150-REV-04 | 作成者2項目のIssue #150への追記 | 追跡資料に具体的なコメント本文を保存。投稿は自動承認審査で拒否され未送信。外部へのコメントや起票を済ませたとは扱わない |

v1.1の作成でphotos省略の修正や4C着手のレビューを完了扱いにしない。他集合の調査は新契約の合格試験ではなく、修正前の架空メモリ保存と子行変換の観察である。

今回の補足確認: 棚卸し11ケースの保存結果/子行変換、ソースhashと文書リンクを照合した。共有ZIPの安全検査は全項目PASS。src・tests・DB・GCS・設定は未変更で、新しい実PG/HTTP認証試験・全体pytest・e2eは実行していない。GitHubへのコメント1件と別Issue4件だけは送信承認待ちである。
