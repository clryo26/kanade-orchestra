# 宣伝機能の登録・表示障害 修正詳細設計

作成日: 2026-10-18  
改訂: 第1回レビューの5指摘、および第2回レビューの2指摘（本番停止手順、全操作台帳更新の試行条件）を反映。  
状態: 実装済み。DBマイグレーション適用、既存データ削除、本番・クラウド操作は未実施。

## 1. 目的と合意事項

画像付き宣伝の登録で500となり、その後の一覧取得も500となる障害を解消する。DB保存の成否と画像・キャッシュの後処理を分離し、再送・同時更新・サーバー停止でも登録内容や画像を失わないようにする。

- 宣伝の登録・更新・削除はDBの行単位で行う。IDはDBで採番し、更新競合を検出する。
- 宣伝の一覧、画像参照、更新対象、権限判定に使う対象行はDBから取得する。
- 既存の宣伝データおよび対応画像は、移行時に全件削除してよいというユーザーの許可がある。
- 既存データの削除は過去データの移行負担を減らす措置であり、将来のキャッシュ不整合・再送対策の代わりにはしない。
- 新画像は上書きしない。DB更新成功後に旧画像を削除対象とする。
- 団員写真、演奏会チラシ、団体アイコン、希望曲の既存データは削除しない。
- 本番はDB Onlyを維持する。一般団員・管理者の既存の利用権限を維持する。

## 2. 調査結果と修正の境界

### 2.1 確認済みの原因

前段の調査で取得したCloud Runログには、本番・テストの登録処理で `Object of type UploadFile is not JSON serializable`、本番の一覧応答で `PydanticSerializationError` が記録されていた。

現行コードとの対応は次のとおり。

| 箇所 | 問題 |
|---|---|
| `services/extra_collection_helpers.py:parse_extra_upsert_request` | フラットなmultipartフォームのファイル項目もpayloadへコピーする |
| `services/extra_service.py:create_item/update_item` | キャッシュ由来の一覧を直接変更し、ファイルが残ったpayloadを保存する |
| `services/json_collection_service.py:save_json_data` | DB保存後のキャッシュ例外が呼び出し元へ伝わる |
| `services/memory_cache.py:MemoryCache.set` | JSON変換前にキャッシュへ代入する |
| `services/extra_service.py` の画像ロールバック | DB保存後の例外でも画像を削除し得る |
| `services/image_asset_service.py` | 同じID・同じ拡張子では画像保存先が固定される |
| `services/extra_service.py:delete_item` | DB削除前に画像を削除する |

画像404もログにあったが、各欠損画像の削除原因や影響件数は未確定。ローカルでの障害再現試験は未完了であり、本書の試験項目を実装時に実施する。

### 2.2 対象範囲

宣伝専用のservice/repository/画像管理を追加し、既存URLをその入口へ接続する。`app_core.py` は互換ファサードのままにする。

他コレクションへの共通修正は「アップロードファイルをpayloadへ含めない」「MemoryCache.setの変換前代入をなくす」に限定する。共通の保存API全体について、例外を握りつぶす変更はしない。宣伝以外の行単位DB化・全体キャッシュ刷新は本件に含めない。

## 3. コンポーネントと責務

| ファイル（新設を含む予定） | 責務 |
|---|---|
| `src/backend/services/promotion_service.py` | 入力正規化、所有者情報、認可、操作ID、画像保存、DB公開、公開応答 |
| `src/backend/repositories/promotion_repository.py` | 一覧・単件のDB取得、行ロック、採番、revision比較、操作台帳・画像台帳のトランザクション |
| `src/backend/services/promotion_image_service.py` | 宣伝専用の画像参照形式、制限付き読込、ハッシュ計算、GCS/local保存・配信・削除 |
| `src/backend/routers/albums.py` | 既存 `/api/extra/promotions` 系URLを専用serviceへ分岐。HTTP要求の解釈 |
| `src/backend/routers/promotions.py` | 操作結果照会API。ルーター登録も追加 |
| `src/backend/services/extra_service.py` | 宣伝を汎用の一覧書き戻し経路へ流さず専用serviceへ委譲 |
| `src/backend/services/bootstrap_service.py` | 宣伝データだけ専用serviceから取得 |
| `src/backend/services/json_collection_service.py` | 宣伝の読み取りを専用repositoryへ接続。旧キャッシュを参照しない |
| `src/backend/services/memory_cache.py` | 変換・ETag生成の成功後にキャッシュを更新 |
| `src/static/js/modules/date_piece_promotion/api.js` | 操作ID・expected_revision送信、再送、結果不明時の照会 |
| `src/static/js/modules/date_piece_promotion/render_desired_promotion.js` | 読込状態、エラー、再試行、画像差し替え |
| `src/static/js/modules/bootstrap_loader.js` | 宣伝の読込結果を共有状態へ反映 |
| `src/static/js/modules/common_helpers/api_runtime.js` | 宣伝と操作照会のアプリ独自キャッシュ除外、旧キャッシュ削除、構造化HTTP結果の受け渡し |
| `scripts/cleanup_promotion_images.py` | 台帳に基づく画像清掃・再実行 |
| `scripts/reset_promotions.py` | 対象環境・団体を固定した一度限りの全削除。既定はdry-run |
| `scripts/manage_production_maintenance.py` | 本番専用の停止用リビジョンへの切替・トラフィックとタグの確認・排出確認・解除。テスト専用スクリプトとは分離 |
| `src/backend/production_maintenance.py` | 通常アプリやDB初期化を読み込まない本番停止用の最小ASGI入口。health以外は503 |

serviceからrepositoryへの依存方向とする。repositoryはserviceをimportしない。`BaseRepository` 継承だけでは一覧書き戻しが残るため、専用SQLを実装する。

## 4. DB設計

### 4.1 マイグレーション

新規SQLを `db/migrations/<次の未使用番号>_promotion_reliability.sql` に追加する。調査時点の最終番号は017だが、実装時に再確認する。適用済みSQLは変更しない。DDLと一度限りのデータ削除は分離する。

以下は論理スキーマ。型・既存sequenceはマイグレーション実装時に実DBの定義と照合する。起動時にDDLを自動修復して適用済み扱いにはしない。

### 4.2 promotions

既存の `id/title/summary/image_url/member_id/registered_by/created_at/updated_at/organization_id` を維持する。

| 追加列 | 型・制約 | 用途 |
|---|---|---|
| `revision` | BIGINT NOT NULL DEFAULT 1、正数 | 更新・削除時の競合判定 |
| `image_asset_id` | UUID NULL | 現在の画像台帳への参照。画像なしはNULL |

- `id` は既存PK・sequenceを確認し、DB defaultのsequence/identityで採番する。アプリの `MAX(id)+1`、キャッシュ採番は使用しない。
- ID再利用を避けるため初期化時もsequenceをリセットしない。
- `image_url` はserviceが `image_asset_id` から生成した公開URLだけを保存する。クライアントの保存先指定を信用しない。
- 一覧順は `created_at DESC, id DESC`。クエリは常に対象organization_idで絞る。
- `image_asset_id` の所有団体との一致は複合参照等のDB制約で担保する。循環外部キーを作らず、画像台帳のpromotion_idは履歴用の値とする。

### 4.3 promotion_operations（操作台帳）

| 列 | 内容 |
|---|---|
| `organization_id`, `actor_key`, `operation_id` | 複合主キー。operation_idはクライアント生成UUID |
| `method`, `target_id` | POST/PUT/DELETEと対象ID。POSTの初回はtarget_id=NULL |
| `request_hash` | 正規化入力・対象・期待revision・画像バイト列ハッシュから作るSHA-256 |
| `state` | `processing / succeeded / rejected` |
| `attempt_id`, `lease_until` | 処理権を持つ試行UUIDと期限 |
| `result_status`, `result_body`, `error_code` | 確定したHTTP結果。公開項目のみ。ファイルや内部保存先は入れない |
| `created_at`, `updated_at` | UTCのDB時刻 |

- actor_keyは後述の認証主体規則でserver側が決定する。団員IDの再利用を区別し、端末IDだけで識別せず、空値や共通の未設定値にフォールバックしない。
- 同じキー・同じrequest_hashの確定済み要求は、書き込みを繰り返さず同じ結果を返す。同じキーで別内容なら409。
- 確定済みキーは通常運用で削除しない。本文を将来圧縮する場合もキーとハッシュの重複防止情報は残す。
- processingの初期leaseは10分。期限切れ再試行は新attempt_idを発行し、古い試行は公開できない。
- 画像アップロード中にDBトランザクションや行ロックを保持しない。
- 既存宣伝全削除の移行後も、結果不明への対応としてこの台帳を使用する。

列型はorganization_id/actor_key/method/state/error_codeがTEXT、operation_id/attempt_idがUUID、target_idが既存promotions.idと同じ型、request_hashが64桁の16進TEXT、result_statusがSMALLINT、result_bodyがJSONB、各時刻がTIMESTAMPTZとする。stateはCHECK制約、`state/lease_until` は処理期限照会用の索引とする。時刻はDB生成、processing中の結果列はNULL、確定後はresult_status/result_bodyを必須にする。

認証不正・入力形式不正は予約前に返す。対象宣伝の存在・所有者・revisionは、確定済み再送の判定を終えてから確認する。予約後の対象不存在・認可不一致・revision競合等の確定エラーはrejectedへ遷移する。一時的なDB/GCS障害はrejectedとして固定せず、processingのまま同じキーで再試行可能にする。制御可能な失敗で処理権を解放する場合も、attempt_idを照合して自分の試行だけを失効させる。

#### 操作台帳の全更新に適用する試行条件

成功確定だけでなく、事前確認失敗によるrejected化、最終更新の競合確定、処理権解放、lease変更、target_id・result・errorの更新にも同じ条件を適用する。repositoryに条件付き更新の共通入口を設け、主キーだけの無条件UPDATEを公開しない。

```sql
-- 先に同じ複合主キーの操作行を SELECT ... FOR UPDATE でロックする。
UPDATE promotion_operations
SET ...
WHERE organization_id = :organization_id
  AND actor_key = :actor_key
  AND operation_id = :operation_id
  AND state = 'processing'
  AND attempt_id = :attempt_id
  AND lease_until > clock_timestamp()
RETURNING ...;
```

DBの実時刻を用い、行ロック待ち前の時刻やトランザクション開始時刻で有効期限を判定しない。更新件数は必ず1件と確認する。0件なら確定エラーの書込みや処理権解放を行わず、同じトランザクション内の宣伝・画像公開に関する変更もrollbackする。現在の台帳を読み直し、確定済みならその結果、別試行処理中なら202を返す。期限切れでまだ引継ぎ前なら同じ操作IDでの再試行を案内する。照会不能は503とし、推測で台帳を変更しない。失効した試行の画像回収は7節の自分のassetに限定した処理で行い、操作結果を変更しない。

初回予約と期限切れ引継ぎだけは処理権を取得するための別経路とする。初回は一意制約付きINSERT、引継ぎは行ロック下で `state=processing AND lease_until <= clock_timestamp()` および取得時のattempt_idを条件に新attempt_idを設定する。確定済み状態は引継ぎ・解放・エラー処理からも変更不可。新しいattempt_idは引継ぎ成功時にのみ利用する。引継ぎを、古い試行に許可した通常更新の例外として実装しない。

したがって「A停止→lease期限切れ→B引継ぎ・成功→A再開・事前確認失敗」の順でも、Aのrejected化や解放要求は0件となり、Bの成功結果・対象行・画像参照が維持される。

#### 認証主体と登録者の規則

| 認証主体 | actor_key | 新規登録時の所有者・表示 |
|---|---|---|
| 通常団員および団員に紐づく管理者 | `member:{id}:{DBのcreated_atをUTCで正規化した値}` | member_idはDBの団員ID、registered_byは認証済みの表示名 |
| 団員IDを持たない既存の隠しシステム管理者 | `system:hidden-admin:v1` | member_id=NULL、registered_byは既存表示名 `Administrator` |

隠しシステム管理者は、get_device_authが返す `hidden_user=true`、`permission=システム管理者`、member_idなしの組合せをserver側で確認した場合だけ認める。現行の単一共有管理者アカウントを一つの認証主体として扱う意図的な識別子であり、一般利用者のID欠落には使用しない。organization_idと環境ごとのDBにより操作を分離する。ログイン名・パスワード・トークンの値をactor_keyに含めない。複数の隠し管理者アカウントを導入する場合は認証基盤の安定したprincipal_idに分離し、表示名や端末IDで代用しない。

通常団員の識別元はDBの現在の団員行とする。団員行なしは401/403、DB参照不能は503とし、created_at欠落はデータ整合性エラーとして503を返す。別団員への再ログイン・団員ID再利用時は以前の操作へアクセスできない。隠し管理者の登録・更新・削除は既存の管理者権限で許可し、更新時は既存所有者を維持する。member_id=NULLの宣伝の編集可否を、一般団員の空IDとの一致で判断しない。

確定済み操作の照会・再送でも現在の有効な認証と同じorganization_id/actor_keyを必須にする。過去の権限で新しい変更を実行することはなく、確定済みの履歴応答だけを返す。

### 4.4 promotion_image_assets（画像台帳）

| 列 | 内容 |
|---|---|
| `asset_id` | UUID主キー。アップロード試行ごとに発行 |
| `organization_id`, `promotion_id` | 所有団体と関連宣伝。POST準備中のpromotion_idはNULL |
| `operation_id`, `actor_key`, `attempt_id` | 画像作成元の操作と試行 |
| `object_name`, `content_type`, `byte_size`, `sha256` | サーバー生成保存先と検証済みメタデータ |
| `storage_generation` | GCSが返したgeneration。localではNULL |
| `state` | `staged / active / retired / delete_pending / deleted` |
| `created_at`, `retired_at`, `deleted_at`, `last_checked_at`, `next_attempt_at`, `retry_count`, `last_error_code` | 清掃の判定・再実行・削除後照合に使用 |

object_nameは一意、団体・asset_idの組も一意とする。`state/next_attempt_at` に清掃用索引を追加する。実データ・画像・秘密情報をlast_error_codeへ入れない。

asset_id/operation_id/attempt_idはUUID、organization_id/actor_key/object_name/content_type/state/last_error_codeはTEXT、byte_size/storage_generationはBIGINT、retry_countはINTEGER DEFAULT 0、sha256は64桁の16進TEXT、時刻はTIMESTAMPTZ。promotion_idは既存IDと同じ型でNULL可。storage_generationはupload完了前もNULL可。状態CHECK、非負サイズ・再試行回数CHECK、operationへの複合外部キーを設定する。

公開の必須条件は「対象操作のattempt_idが一致しleaseが有効」「画像がstaged」「DBの画像参照と団体が一致」。清掃処理がdelete_pendingへ移した画像を公開してはならない。

### 4.5 初回削除の実行記録

新規に `promotion_reset_runs` と `promotion_reset_items` を作成する。新方式の画像台帳に存在しない旧画像も、宣伝行を消す前に記録できるようにする。

- runs: run_id UUID主キー、environment_id/organization_id TEXT、state TEXT（prepared/db_deleted/cleaning/completed）、manifest_hash TEXT、対象件数、created_at/updated_at/db_deleted_at/completed_at TIMESTAMPTZ。対象環境はproject/service/DB/bucketの機密でない識別情報で固定し、接続文字列は保存しない。
- items: run_idへの外部キー、item_id UUID、promotion_id、kind（promotion/object）、object_name、storage_generation、旧行の識別用fingerprint、state（pending/deleted/missing/needs_review）、retry_count、next_attempt_at、last_error_code、updated_at。画像参照とDB削除対象の集合を記録し、本文や画像バイト列を保存するバックアップとは分ける。
- runとitemの組に一意制約を設け、同一対象の重複を防ぐ。同一環境・団体の未完了runは一つまでとする。記録は宣伝削除に連動して消える外部キーを持たない。
- manifest_hashは環境・団体・固定した対象一覧から生成する。実行開始後は対象集合を変更せず、新しい宣伝や画像を再走査して追加しない。処理状態・再試行情報のみ更新する。
- DBの宣伝削除とrunのdb_deletedへの遷移は同じトランザクションで行う。再接続してrunを読むことで、コミット応答断でも削除の成否を判断できる。
- dry-runではruns/itemsも作成しない。記録は保護された対象DBに保持し、団員APIや共有ZIPへ公開しない。

### 4.6 既存メタデータとの整合

`core/db_schema.py` の列定義・整数列定義・必要テーブル検査を更新する。操作・画像・初回削除の各台帳を汎用extraコレクションとして公開しない。宣伝の汎用DB全件置換にはガードを設け、専用repositoryを経由させる。

## 5. API契約

### 5.1 エンドポイント

| メソッド・URL | 処理 |
|---|---|
| `GET /api/extra/promotions` | 最新一覧。既存の配列応答を維持し、各要素にrevisionを追加 |
| `POST /api/extra/promotions` | 新規登録。認証・operation_id必須 |
| `PUT /api/extra/promotions/{id}` | 更新。認証・operation_id・expected_revision必須 |
| `DELETE /api/extra/promotions/{id}` | 削除。認証・operation_id・expected_revision必須 |
| `GET /api/extra/promotions/{id}/image?asset={uuid}` | 宣伝に現在紐づく画像をDBから確認して配信 |
| `GET /api/promotions/operations/{operation_id}` | 認証済み本人・団体の操作結果を照会 |

読み取りの公開範囲は既存APIと同じとし、認証・団体境界を拡張しない。書き込み・結果照会は既存get_device_authを使用する。

### 5.2 入力

- 操作IDは `Idempotency-Key` ヘッダーで送信。既存CORS設定を確認し、必要時だけ同ヘッダーを追加許可する。
- POST/PUTはmultipartのフラット項目とJSON文字列payloadの両方を解釈する。画像なしのJSON要求も受け付ける。
- 保存項目はtitle、summary。PUTはexpected_revision、画像の扱いは `image_action=keep|replace|remove`。POSTの画像なしはremove、ファイルありはreplace。
- replaceには `image_url_file` を1つ要求する。keep/removeとファイルの同時指定は422。
- `image_url` は読み取り用。新APIでは保存先指定に使用せず、旧クライアントからの書き込みは再読込を促す422とする。
- member_id/registered_byは4.3節の認証主体規則に従いserver側で設定する。更新では既存所有者を保持する。管理者が別人へ所有者を移す機能は追加しない。
- titleはtrim後必須。title最大200文字、summary最大10,000文字、画像最大10MiBを初期設計値とする。既存の運用制限が見つかれば実装前に整合させる。
- revisionは正整数。DELETEはJSON本文でexpected_revisionを送信する。
- 汎用フォーム解析はStarletteのUploadFileを含むファイル項目をpayloadから除外する。FastAPI側クラスだけのisinstance判定にしない。
- 不正なJSON文字列payloadは空オブジェクトに置換せず422。UploadFileをstr変換して保存しない。

### 5.3 応答・エラー

既存のPOST/PUT成功HTTP 200、宣伝オブジェクト、DELETEの `{ "message": "Deleted" }` を維持する。オブジェクトは内部台帳列を除いた既存公開項目とrevisionのみ。

| 状態 | HTTP・code | 画面の扱い |
|---|---|---|
| 正常完了・確定済み要求の再送 | 200 | 保存完了。再送時も二重登録しない |
| 同じ操作が処理中 | 202 `promotion_processing` | Retry-Afterを付け、操作結果を照会 |
| 期待revision不一致 | 409 `promotion_revision_conflict` | 入力を保持し、最新取得と再編集を案内 |
| 操作IDを別内容で再利用 | 409 `promotion_operation_conflict` | 新しい操作IDが必要 |
| 旧クライアントの期待revision欠落 | 428 `promotion_revision_required` | 再読込を案内 |
| 必須項目・形式・組合せの不正 | 422 | 入力を修正 |
| 画像の上限超過 | 413 | 小さい画像を選択 |
| 画像形式不正 | 415 | 対応画像を選択 |
| 他人の更新・削除 | 403 | 処理しない |
| 対象なし | 404 | 最新一覧へ更新 |
| DB/GCSの一時障害・結果不明 | 503 `promotion_retry_same_operation` | 同じ操作IDを保持し照会・再試行 |

codeと画面向けmessageをdetail内の固定構造にし、既存requestヘルパーで表示できるよう対応する。内部例外本文は返さない。202を通常の保存成功と誤認しないよう専用処理で判定する。

操作結果照会はprocessingなら202、確定済みなら200の `{state, result_status, result_body}`、未知キーなら404。保存結果不明時の404は失敗確定ではなく、同じ操作IDで再送する判断に使う。

## 6. 登録・更新・削除の処理順

### 6.1 全操作共通

1. 現在の認証、団体・actor解決、入力形式検証、ファイルの上限付き読込・ハッシュ計算を行う。この段階では対象宣伝の存在・所有者・現在revisionを判定しない。
2. 正規化JSONのキー順を固定し、method、target、expected_revision、画像action、画像ハッシュを含むrequest_hashを生成する。multipart境界・ファイルオブジェクト・表示ファイル名は含めない。
3. 同じorganization_id/actor_key/operation_idの操作台帳を先に照会・ロックする。request_hashが異なれば409。確定済みなら保存済み結果を返し、対象宣伝が削除済み・更新済みでも再検証しない。未確定の有効leaseは202、未知キー・期限切れは短いDBトランザクションで処理権を予約する。
4. 未確定要求だけ対象宣伝をDBから取得して存在・認可・期待revisionを事前確認する。失敗は4.3節の行ロック・state/attempt_id/lease条件を満たす場合だけ確定エラーを台帳へ記録し、新画像を保存しない。条件不一致なら現在の結果を返し、古い試行のエラーで上書きしない。新画像が必要なら台帳をstagedで作成・コミットし、7.1節の試行確認を経てDB外でアップロードする。
5. 最終DBトランザクションで操作行、対象宣伝行、関連画像行の順にロックする。複数画像はasset_id順。画像清掃側も同じロック順を守る。
6. state・attempt_id・lease、対象行、認可、期待revisionを再検証し、宣伝変更・画像状態変更・操作結果確定を同一トランザクションでコミットする。操作確定の条件付きUPDATEが1件でない場合は一連の変更をrollbackする。失敗結果の確定と処理権解放にも4.3節の条件を適用する。
7. 成功後の画像削除・通知等が失敗しても、成功済みのDB変更を失敗扱いに戻さない。

操作結果の公開オブジェクトは最終トランザクション内で組み立て、JSON変換可能と確認して台帳へ保存する。再送も通常応答もその確定結果を使う。遅延した過去操作の結果は保存時点の応答であり、現在一覧の代わりとしてキャッシュへ直接適用しない。

新規要求の受付は衝突する主キーを使ったINSERT/行ロックで直列化する。プロセス内Lockだけでは代用しない。期限切れ旧attemptが遅れて戻っても最終トランザクションで拒否する。

### 6.2 新規登録

画像は宣伝IDを必要としないasset_idで準備する。最終トランザクションで `INSERT ... RETURNING id` により宣伝を作成し、画像をactive、operationをsucceededにする。これにより画像保存の失敗だけで空の宣伝レコードを公開しない。

### 6.3 更新

6.1節で確定済み再送を処理した後、未確定要求について現在行をDBから取得して権限を確認する。最終更新は `WHERE organization_id = ... AND id = ... AND revision = expected_revision` の条件付きUPDATEで行い、revisionを1増やす。updated_atはDBで更新する。

- keep: 現在のimage_asset_id/image_urlを維持する。
- replace: 新画像をactive、旧画像をretiredにする。旧画像の削除はコミット後に行う。
- remove: 画像参照をNULL/空文字にし、旧画像をretiredにする。

競合した場合は宣伝を変更せず、4.3節の処理権条件を満たす試行だけが操作結果をrejected/409として確定する。条件を満たさない古い試行は現在の台帳結果を返す。その試行の新画像だけ清掃対象にする。最新revisionを取得し直して内容を確定した場合は新operation_idを使う。

### 6.4 削除

確定済み再送の判定を最初に行い、同じ削除操作なら台帳から成功応答を返す。未確定要求だけDBの現在行で存在・認可・revisionを検証し、宣伝削除、旧画像のretired化、操作成功を同一トランザクションで確定する。画像はその後に削除する。既に対象がなく台帳にも同じ成功記録がない別操作のDELETEは404とする。

### 6.5 コミット結果不明・プロセス停止

コミット応答の通信断をrollback確定と見なさない。新しい接続でoperationを照会し、succeededなら成功応答を復元する。照会不能なら503を返し、新旧画像は即時削除しない。

コミットされていなければprocessing台帳から同じキーで再試行可能。lease中は二重処理せず202、期限切れ後は新attemptで引き継ぐ。古いstaged画像は台帳に残り清掃される。

## 7. 画像の保存・配信・清掃

### 7.1 保存方式

保存先は `promotion-images/v2/{団体IDのSHA-256}/{asset_id}.{ext}`。団体IDそのものやユーザー指定パスは使わない。asset_idはserver生成UUID、拡張子は許可形式からserver側で決める。

初期対応はJPEG/PNG/GIF/WebP。MIME申告とバイト列の形式を照合し、SVG/HTML・不一致は415。JPEG/PNG等の拡張子は正規化する。画像読込はチャンク単位で上限を検査し、不要なbase64化をしない。

GCSは一意のobject_nameへ `if_generation_match=0` 付きで作成し、generationを台帳に保存する。削除も対象generationを指定する。存在確認と無条件削除の組合せで別世代を消さない。

アップロード直前に操作行・画像行を同じロック順で確認し、自分のattempt_id・有効lease・stagedを満たさなければ外部保存を開始しない。アップロード完了後もDBで同じ条件を再検証し、満たす場合だけgenerationを確定して公開処理へ進む。

確認直後のプロセス停止や実行中のGCS要求によって、失効後にアップロードが完了する競合は事前確認だけでは防げない。完了後に失効を検知した場合は、公開せず自分のasset行だけをdelete_pendingへ移し、返されたgenerationを清掃対象にする。既にdeletedの場合もdelete_pendingへ戻す。この後処理でDB障害が起きた場合は、7.3節の削除後照合で回収する。新attemptの画像や成功済みのactive画像を旧attemptが変更してはならない。

GCS呼び出しのtimeoutは60秒、再試行の総期限は120秒を初期値とし、処理権の10分を超える暗黙リトライを禁止する。local保存は明示的な開発設定のみ。workspace外の任意パスを構成しない。

### 7.2 公開URL

公開URLは `/api/extra/promotions/{id}/image?asset={asset_id}`。URLにGCSバケット・object_nameを出さない。

取得時はDBから現在の宣伝・画像台帳を照会し、assetが現在参照と一致し、同じ団体・activeである場合だけ配信する。queryのassetだけで任意画像を取得しない。更新前URL、削除済みURLは404。DB障害を404へ変換せず503にする。

一覧・画像・操作結果照会・宣伝を含むfull bootstrap応答は、HTTP層も含め `Cache-Control: no-store` とする。宣伝を含まないbootstrap-liteの既存キャッシュ方針は維持する。アプリ独自のIndexedDBキャッシュとフォールバックは8.1節で別途禁止する。公開URLが変わるのでブラウザが古い画像を使い続けない。

画像取得と差し替えが交差する場合の404は許容し、画面は画像欄の再読込を案内する。新URLへの再取得で回復し、宣伝一覧全体をエラーにしない。

### 7.3 清掃

台帳を清掃の正とする。retired画像は最終DB参照なしを再確認してdelete_pendingへ移す。期限切れ試行のstaged画像は作成から24時間後を初期清掃時刻とする。active/有効lease/DB参照ありの画像は削除しない。

清掃の候補確定は操作行・画像行のロック下で行い、DB参照なしを検証する。delete_pendingになった画像は、その後の公開トランザクションで拒否されるため、DB外の削除と公開が競合しない。

GCS削除はDB外で行い、成功またはNotFoundならdeletedとする。失敗はretry_countと安全なerror_code、next_attempt_atを保存する。指数バックオフ、上限24時間で再試行し、1回の実行件数・実行時間を制限する。アップロード後にgeneration記録前で停止した画像は、一意の保存先を取得してgenerationを確定してから処理する。

deletedは「最後に確認した時点で不在」であり、今後の外部書込が絶対にないことを意味しない。台帳行とobject_nameは通常運用で削除・再利用しない。清掃ジョブにはdeletedの再照合フェーズを設け、last_checked_atが古い順に件数上限付きで巡回する。対象件数で一部が永久に後回しにならないようカーソルを進め、全対象が一巡したかを監視する。

再照合でオブジェクトを検出した場合は、操作・画像行をロックし、当該assetがactiveでなくDB参照もないことを再確認する。その上で実オブジェクトのgenerationを取得してdelete_pendingへ戻し、そのgenerationだけを条件付き削除する。generation不一致は無条件削除へ切り替えず、状態と参照を再照会する。NotFoundの後に遅延アップロードが完了しても、完了後の後処理またはこの巡回で回収する。巡回の周期は1日1回以上を初期値とし、台帳数・全件巡回所要時間・未回収数を運用確認項目にする。

`cleanup_promotion_images.py` は既定dry-run、環境とorganization指定を必須とする。運用は1日1回の既存運用ジョブ等へ組み込み、失敗を監視する。実行基盤への登録は実装・リリース作業で行う。Cloud Runの応答後バックグラウンド処理だけには依存しない。

## 8. キャッシュ・汎用処理・互換性

- 宣伝の一覧・単件・画像・bootstrap・ETagに、既存MemoryCacheのpromotionsを使わない。単に呼び出し元1箇所を変更して完了にしない。
- `storage_gateway` 経由の宣伝読込も専用DB読込へ接続し、汎用保存は明示的に禁止する。同期・エクスポート等の保守処理は用途別に許可した専用経路へ移す。
- 本番からテストへの同期で新画像台帳・operationと宣伝の参照関係を崩さない。同期処理も更新する。対応前は宣伝を同期対象から明示的に除外し、テスト側宣伝を初期化する手順に限定する。片方だけコピーしない。
- 宣伝以外のMemoryCache.setはJSON変換・ETag計算後に代入する。変換失敗時に従前のdata/ETag/indexを維持するテストを追加する。
- 共通パーサーのファイル除外は希望曲・団体アイコンのpayload形式を維持する。他機能の画像保存方式は変更しない。
- 旧クライアントの書込はoperation_id/revision欠落で拒否し、更新を案内する。新旧書込処理の混在を許可しない。
- 既存宣伝全削除後に新方式で開始するので、宣伝の旧固定画像・旧base64画像を読むための新たな互換層は作らない。既存共通関数にある他機能向け互換処理は残す。
- 明示的local開発では専用repositoryの代替実装を使い、JSONまたは一時領域でAPIの基本契約を確認可能にする。ただしDB採番・トランザクション・多接続試験の代替にはせず、本番DB接続失敗時の自動フォールバックは禁止する。

### 8.1 ブラウザ独自キャッシュの除外

HTTPのno-storeだけでは `common_helpers/api_runtime.js:request()` がIndexedDBから返すデータや通信失敗時のフォールバックは止まらない。APIのpathnameを正規化して、次の要求をアプリ独自のキャッシュ対象から除外する。query違いでも同じ規則を適用する。

- `/api/extra/promotions` とその配下。
- `/api/promotions/operations` とその配下。
- 宣伝を含むfull bootstrap要求。bootstrap-liteは対象外。

対象要求はdbCache.getEntry/setとETag再検証を通さず、毎回ネットワークへ送る。通信失敗・timeout・503を古い値で成功扱いにせず、呼び出し元へ失敗として伝える。GETの処理中要求の共有は同一環境・団体・認証主体に限り、再ログイン・切替前の要求結果を新しい状態へ適用しない。

新フロントエンド起動時に、対象URLの旧IndexedDBエントリーと宣伝を含む保存済みbootstrapを破棄する。対象キーを列挙して削除し、他機能のキャッシュやsessionStorageの未解決operationは消さない。削除に失敗しても対象要求はキャッシュへアクセスしないため利用を再開しない。旧読込の遅延応答は読込世代番号で破棄する。Cache-Controlを解釈して保存を止めるだけの実装では、この起動前キャッシュ除外の代わりにならない。

前回成功した一覧を画面上に残すことは許可するが、再取得失敗をloadedに戻さずerrorとして「最新情報を取得できていません」を表示する。操作照会の202・Retry-After・503のcodeは、キャッシュを経由しない専用の構造化結果として呼び出し元へ渡す。他機能のrequest()の既存戻り値契約は維持する。

## 9. フロントエンド設計

共有状態はportalAppStateに配置し、`getAppState()` またはruntime contextで参照する。入口main.jsと既存分割ファイル順は維持する。

### 9.1 一覧状態

宣伝用の状態を `idle/loading/loaded/error` とし、最後に成功した一覧・最終エラーを別に保持する。

- loadedかつ0件のときだけ「宣伝はまだ登録されていません」を表示。
- 初回失敗は「宣伝を読み込めませんでした」と再試行ボタンを表示。
- 再取得失敗は既存一覧を残し、「最新情報を取得できていません」を添える。
- 画像だけ失敗した場合はその画像欄に案内し、カード全体を消さない。
- 競合・再取得・202処理中に入力フォームと選択済み画像を不用意に再描画して失わない。

### 9.2 操作IDと再送

確定した保存操作ごとにUUIDを発行し、内容を変えない再試行は同じIDを使う。保存中は連打を防止する。本文・画像・期待revisionを変えた場合は新IDとする。

処理中・結果不明の操作ID、対象、入力のハッシュと安全なフォーム項目をsessionStorageへ一時保存する。画像バイト列やbase64は保存しない。画面内ではFileを保持し、結果照会は2秒から最大10秒間隔、前景で最大60秒自動実行して以後は手動確認を用意する。

再読込後は同じ操作IDの結果を先に照会する。ファイルの再送が必要なら再選択を案内し、ハッシュが同じ場合だけ元操作の再送とする。結果不明のまま新しい登録として自動送信しない。未解決操作の破棄は利用者の明示操作とし、重複の可能性を説明する。

保存API成功と一覧再読込失敗を区別し、「保存しましたが一覧を更新できませんでした」と表示する。後者を「登録失敗」に変換して再登録を促さない。

### 9.3 iPhone対応

保存・再試行・状態確認ボタンは既存の押しやすいサイズを維持する。ファイル選択とプレビューを維持し、未対応形式の場合は対応形式を具体的に表示する。団員画面にバケット・保存先・例外トレース・operation内部情報を出さない。

## 10. 既存データ全削除とリリース

### 10.1 一度限りのリセット

ユーザーの全削除許可は宣伝とその画像に適用する。対象環境・団体は実行引数と接続情報で一致を検証し、本番・テストを別々に実行する。他の作業のデータを巻き込む無条件TRUNCATE CASCADEやバケット全削除は禁止する。

1. 10.2節の環境別手順で書込みを停止する。テストは既存のテスト専用メンテナンス、本番は新設する停止用リビジョンを使用する。新旧リビジョン・保守同期・処理中リクエストの書込み停止を確認できるまでは、削除対象の確定・DB削除を開始しない。
2. dry-runで宣伝件数、ID、関連画像の候補と環境を確認する。必要な退避は既存の保護されたバックアップ領域へ置き、共有ZIPやリポジトリへ実データを保存しない。dry-runでは削除実行記録も書き込まない。
3. 実行時はDB削除より先に、4.5節のruns/itemsへ対象宣伝のID・fingerprint、画像保存先・取得できたgeneration、対象環境・団体・manifest_hashを記録し、preparedとしてコミットする。旧prefixに団体情報がない場合は所有を確定できた画像だけを採用し、未帰属候補はneeds_reviewで残す。ログ出力やメモリ上の配列だけを削除対象記録にしない。
4. 同じrun_idをロックし、対象環境・団体・manifestと現在行の一致およびメンテナンス継続を確認する。記録済みの対象IDだけをorganization_id条件付きでDB削除し、runをdb_deletedへ更新して同時コミットする。sequenceは維持する。汎用JSONコレクションの残存宣伝も事前に対象と帰属を確定・記録したものだけを処理する。
5. runをcleaningとし、DBから消えた行を再取得するのではなくitemsから画像を条件付き削除する。対象prefix全体を推測で消さず、現在のDB参照が見つかった対象は削除せずneeds_reviewにする。各itemの成功・不在・失敗を永続記録する。
6. 再実行は明示したrun_idで再開する。preparedならDB削除前確認へ、db_deleted/cleaningなら画像清掃へ進み、completedなら無変更で終了する。コミット応答断は再接続してrun状態を照会し、不明なら停止する。画像削除後・状態記録前の停止は再実行時のNotFoundを成功として回復する。新規runを自動作成して対象を取り直さない。
7. 全対象のDB削除と画像のdeleted/missingを確認してcompletedとする。needs_reviewや削除失敗が残る場合は未完了として運用者へ報告し、空の宣伝一覧だけをもって全削除完了としない。アプリ起動・通常マイグレーションにこの削除処理を含めない。

### 10.2 適用順

#### 環境別の停止方法

現行の `core/maintenance_mode.py` と `scripts/manage_test_maintenance.py` は `APP_ENV=test` かつ `K_SERVICE=kanade-orchestra-test` 専用である。本番でMAINTENANCE_MODEを有効にすると起動失敗となるため、既存ガードは緩和せず、本番では使用しない。

本番は新設する `production_maintenance.py` を入口とする停止用リビジョンへ切り替える。この入口は通常のapp_core・router・DB接続・起動seed・バックグラウンド処理をimport/起動しない。`GET /api/health` だけ200で `mode=production-maintenance` を返し、それ以外のメソッド・パスは503、Retry-After、Cache-Control:no-storeと固定の利用者向けメッセージを返す。通常アプリのMAINTENANCE_MODEはfalseのままとし、本番専用スクリプトはproject・region・本番serviceの一致を検証する。

停止・解除の制御は新設する `manage_production_maintenance.py` に分離する。事前に確認したイメージdigestと起動コマンドで停止用リビジョンをトラフィックなしで作成し、health識別子とDB非接続を確認した後に100%のトラフィックを移す。旧リビジョンへのタグ付きURLも閉じ、割合0%だけで停止済みと判定しない。切替前の設定・トラフィック・タグ・稼働ジョブは、秘密値を除いて移行記録へ残す。

#### 書込み停止の確認

本番・テストとも、同期・デプロイ・管理操作・清掃など当該DB/GCSへ書くジョブの新規起動を止め、実行中ジョブの完了または中止を確認する。自動デプロイ等が停止中のトラフィックを戻さないようにする。旧リビジョンに残るリクエストは、実サービス設定の最大request timeoutを確認してその期間以上排出待ちし、DBの実行中トランザクション・対象APIログ・実行中ジョブと合わせて確認する。固定310秒だけで本番の停止を保証しない。

タグや別経路から旧writerを呼び出せる場合、処理中の書込みが残る場合、停止状態を確認できない場合は削除前に停止する。必要な経路閉鎖・旧writerの隔離を完了して再確認し、メンテナンス表示だけを根拠に削除を強行しない。停止確認の時刻・対象リビジョン・ジョブ状態はrunの運用記録に残し、再開時も再確認する。

#### テスト環境の適用

1. 既存のテスト専用メンテナンスを有効にし、旧書込経路を閉じて排出を確認する。
2. DBマイグレーションと10.1節のrun単位の既存宣伝リセットを行う。
3. 新アプリを本流トラフィックなしで反映し、旧リビジョンを再公開せずにschema・API・画像の確認を行う。
4. リセット完了、旧cacheの不使用、同期が旧データを戻さないことを確認する。
5. 新アプリへのトラフィック切替とメンテナンス解除を行い、通常URLで再確認する。

#### 本番環境の適用

1. テスト環境の受入試験と、本番停止用入口・切替スクリプトの事前試験を完了する。
2. ジョブ起動を止め、本番停止用リビジョンへ100%切り替える。旧タグ経路を閉じ、上記の排出・書込み停止確認を完了する。
3. DBマイグレーションと10.1節のrun単位のリセットを実行する。失敗時は停止用リビジョンを維持し、同じrun_idから再開する。
4. 新しい通常アプリをMAINTENANCE_MODE=false・本流トラフィックなしで反映する。確認経路は運用者に限定し、一般利用者の書込みを再開する前にschema・一覧・画像・操作照会・競合処理を確認する。
5. リセット完了と解除条件を確認し、検証済みの新リビジョンへ100%切り替える。停止用入口へではなく新通常アプリへ切り替えることで解除する。旧リビジョンへは戻さない。
6. 通常URLでhealth・宣伝API・他機能を確認し、対応済みの同期・清掃・デプロイジョブだけを再開する。

解除条件は、run完了、DBスキーマ適合、旧リビジョン/タグからの書込み不能、新アプリの確認成功、未解決の移行障害なしとする。解除後の異常時は本番停止用リビジョンへ戻してデータを保持し、10.3節に従って前進修正する。既存のテスト専用ガードを外すことを本番停止の代替にしない。

### 10.3 ロールバック

新方式のデータ・画像が作成された後は、旧版が正しく読み書きできるとは限らない。旧イメージへ戻すだけの復旧は行わない。メンテナンス下でDB・画像を保持し、原則として修正版を前進適用する。

旧版へ戻す必要がある場合は、新規データを保護したうえで旧版との互換性・宣伝機能停止を確認する。全削除を自動で再実行しない。DDLの削除やバックアップ復元は通常のイメージ切替と分離する。

## 11. 試験設計と受入条件

| 分類 | 必須試験・期待結果 |
|---|---|
| 入力 | 実multipartのフラット/payload形式、画像あり/なし、JSONでファイルオブジェクトが保存・応答に混入しない |
| 制限 | 不正JSON、未対応形式、MIME不一致、0byte、10MiB境界、title/summary境界、ファイルとactionの矛盾 |
| 登録 | 画像なし/ありで200、一覧取得200、画像取得200。IDはDB採番 |
| 更新 | keep/replace/remove、JPEG→JPEG/PNG、revision増加、created_atと所有者維持 |
| 削除 | DB失敗では旧画像を維持、DB成功後の削除失敗では削除成功・清掃台帳あり |
| 認可 | 団員は自分だけ更新・削除、管理者は既存権限内、所有者偽装不可、他団体・他actorの操作照会不可。member_idなしの隠し管理者による登録・更新・削除・結果照会、member_id=NULLと一般団員の空IDが所有者一致にならないこと |
| 認証主体 | 通常団員と隠し管理者のactorが衝突しない。同一の認証主体は別端末でも同じactor、別団員への再ログイン・団員ID再利用では旧操作にアクセス不可。団員情報欠落・DB障害で空actorを発行しない |
| 競合 | 独立したDB接続で同時登録は別ID、同一revision更新は1件だけ成功、更新対削除でも復活なし |
| 再送 | 同一キー同一内容は同じ結果、別内容は409、異端末でも同じactorの再送が重複しない。成功DELETEの応答断後、対象行がなくても同じキーで200。更新後さらに対象が変更・削除されても確定済み同一要求は元結果。別キーの不存在DELETEは404 |
| 処理権 | 有効leaseは202、期限切れ引継ぎ、遅延旧attemptが公開不可、清掃対公開の競合で使用中画像を消さない。A停止→期限切れ→B成功→Aの事前確認エラー/rejected化/解放/lease変更を別接続で再現し、Aの更新0件とBの成功結果・対象行・画像維持を確認。B処理中ならAは202、台帳照会不能なら503。行ロック待ち中の期限切れと最終操作確定0件で関連DB変更がrollbackされることも確認 |
| 障害 | upload失敗、upload後停止、DB rollback、commit成功後の応答断、commit結果照会失敗、応答生成失敗を注入 |
| 複数サーバー | 2プロセス相当で片方更新後にもう片方の一覧/画像/bootstrapがDBの最新参照を返す |
| 清掃 | generation条件、NotFound、削除失敗再試行、staged24時間条件、参照あり/有効leaseの除外。清掃NotFound→deletedの後に旧uploadが完了する順序を再現し、完了後処理またはdeleted巡回で回収。完了後DB障害、generation不一致、新attemptとactive画像の保護も確認 |
| キャッシュ | JSON変換失敗時に旧データ・ETag・索引が不変、宣伝の読み取りが旧cacheに影響されない。IndexedDBに旧一覧・旧操作結果・旧full bootstrapを事前投入し、通常/timeout/503の全ケースで再利用なし。旧キー削除失敗でも再利用なし、liteと他機能cacheは維持 |
| フロント | loaded0件とerrorの区別、入力保持、202/Retry-Afterを構造化結果で受領して成功扱いしない、結果不明後の照会、保存成功後の一覧失敗。再ログイン・団体切替・起動時の旧in-flight応答を新状態へ適用しない |
| 互換 | 他コレクションCRUD、団体アイコン、希望曲添付、団員写真、チラシ、bootstrap、同期・エクスポート |
| 移行 | dry-runは実行記録を含め無変更、対象宣伝だけ削除、他団体/他画像維持、旧書込リビジョン遮断。prepared直後、DB削除コミット応答断、画像削除前、画像削除後の記録前で停止し、同一run_idの対象だけ再開・完了。completed再実行は無変更、記録後に増えた対象は追加せず、環境/団体/fingerprint不一致は停止 |
| 停止・解除 | 既存MAINTENANCE_MODEは引き続き本番で拒否。新しい本番停止用入口はhealth以外503でDB/seed/通常アプリ非起動。切替スクリプトの環境・service不一致拒否、100%トラフィックとタグ閉鎖、設定に応じた排出待ち、実行中writer/ジョブ残存時の削除拒否、未完了runでの解除拒否を確認。新アプリへの解除と異常時の停止用リビジョンへの復帰も事前試験 |
| 実機 | iPhoneで画像選択→登録→表示→差し替え→削除、通信中断後の状態確認、ボタンとエラーの視認性 |

DB競合・コミット・制約の試験は分離したPostgreSQLで実施し、モックだけで完了扱いにしない。画像の単体試験はfake storageを使い、テスト環境GCSで作成・取得・generation付き削除を別途確認する。

通常の `compileall / ruff / pytest / frontend syntax / Vitest / Playwright` を実施し、フロントのload-order・state-accessとDBスキーマ整合性チェックも行う。実行結果・未実施理由を記録する。

受入条件は、上表の必須試験が成功し、宣伝のDB保存成功が後処理失敗で取り消されたように表示されず、同時要求・再送で重複や他データの上書きが起こらず、既存の団員権限と他機能が維持されること。

## 12. 実装単位・運用ドキュメント

1. migration・専用repository・PostgreSQL試験。
2. 操作台帳・画像台帳・serviceと障害試験。
3. API分岐・bootstrap/汎用readのDB統一・汎用write禁止。
4. フロントの操作ID・revision・状態表示、共通parser/cacheの最小修正。
5. 清掃・削除後照合・永続実行記録付きリセットスクリプト、本番停止用入口と切替スクリプト、同期/エクスポート整合、結合試験。
6. テスト環境の移行とGCS・iPhone確認後、本番移行。

実装単位は分けても、旧書込と新読込が混在する中間状態ではリリースしない。

実装時に `docs/PRODUCTION_RELEASE_CHECKLIST.md`、`docs/CLOUD_RUN_GCS_DB_CHECK.md`、`docs/MANUAL_DEVICE_QA_CHECKLIST.md` と、本番→テスト同期の関連手順を更新する。DBマイグレーション番号・実環境のsequence定義・清掃ジョブへの登録方法は実装時に確定し、本書と照合して記録する。

## 13. 第1回レビュー指摘への対応

| 指摘 | 設計上の対応 | 必須検証 |
|---|---|---|
| 1. HTTP no-storeだけでは独自cacheが残る | 3節にapi_runtime.js追加、7.2節と8.1節でIndexedDB参照/保存/フォールバック禁止、旧キー削除、読込世代と認証主体による遅延応答排除 | 11節「キャッシュ」「フロント」 |
| 2. 団員IDなしの管理者を扱えない | 4.3節で通常団員と隠し管理者のactor・所有者・登録名・欠落時動作を定義、5.2節へ適用 | 11節「認可」「認証主体」 |
| 3. 削除成功の再送前に対象確認してしまう | 4.3節、6.1/6.3/6.4節で認証→確定済み再送→未確定要求の対象確認の順に統一 | 11節「再送」 |
| 4. 清掃後の遅延uploadが残る | 4.4節に削除後照合時刻追加、7.1節でupload前後の処理権確認、7.3節でdeletedから再清掃への遷移と永続巡回を定義 | 11節「清掃」「処理権」 |
| 5. 初回全削除の途中停止から再開できない | 4.5節にruns/items追加、10.1節で対象記録先行・DB削除と状態の同時commit・run_id再開・完了条件を定義 | 11節「移行」 |

本改訂は設計書のみの修正。上記の必須検証は実装時に行うもので、本改訂で成功済みとするものではない。

## 14. 第2回レビュー指摘への対応

| 指摘 | 設計上の対応 | 必須検証 |
|---|---|---|
| 1. 既存メンテナンスを本番で使用できない | 3節に本番停止用入口・専用スクリプトを追加。10.1/10.2節でテストと本番を分離し、停止用リビジョン・旧タグ閉鎖・ジョブ停止・排出確認・解除条件・失敗時復帰を定義。既存のテスト専用制限は維持 | 11節「停止・解除」「移行」 |
| 2. 古い試行のエラー記録が新試行の成功を上書きする | 4.3節に全操作台帳更新の条件付きSQLと0件時のrollback/現在結果照会を追加。6.1/6.3節で事前エラー・競合確定も同じ条件へ統一。初回予約・期限切れ引継ぎは別経路として条件を限定 | 11節「処理権」「障害」 |

本改訂でも設計書のみを変更し、停止用リビジョンの作成、設定変更、台帳更新、削除、実装試験は実施していない。

## 15. 2026-10-18 退行修正と検証境界

- 018以前の宣伝画像はasset IDを持たない。旧画像GETと概要編集時の画像保持を互換対応し、新assetの参照検証は維持する。互換読込ではDB・画像の移行や削除を行わない。
- 遅延ロードする画面JSにも入口の配信revisionを引き継ぐ。revisionなしの静的JSは再検証し、固定v値の旧フォームと新APIの混在を防ぐ。既に開いた旧画面には再読み込みが必要。
- CIでは画像あり・なしの宣伝登録／編集のブラウザ操作、および隔離PostgreSQLで一般団員の画像登録・再送を確認する。ブラウザ試験はAPI応答を模擬し、PostgreSQL試験は画像ストレージを模擬するため、本番DB・GCSを組み合わせた実機確認は別途必要。
- 本番ログでは旧revisionのUploadFile直列化失敗、現行revisionの画像404と編集422を確認した。利用者からは「Idempotency-Key is required」の表示報告を得た。本番配信中のJSはキーを送る新版だが、固定URLは最大1時間キャッシュ可能だった。旧画面からキーなし要求が届いていると判断し、キャッシュ対策と再読み込み案内を追加した。利用端末のキャッシュ自体は未採取。
