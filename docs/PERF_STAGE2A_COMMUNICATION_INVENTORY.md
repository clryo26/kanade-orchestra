# 第2段階A 通信経路の棚卸し v1.0

作成日: 2026-10-21 / 資料 v1.1 / 基準: 第2段階詳細設計 v1.3

調査対象コミット: `a50e0923dffd8ba9da243e841d699531e9ebc8fc`

資料は `origin/main`（`9c76fd920fab12a1e3c5286c0c6adbc2e9099309`）起点の `perf/portal-stage2a-20261021` に分離した。上記の初回調査SHAは第1段階Bを含む読取対象であり、この資料ブランチへ第1段階Bの実装を取り込んだ意味ではない。Fのactor集約等は承認済みB側の記述を維持する。後続4資料はmain起点のコードを別途明記して調査する。

これは第2段階Aの最初のレビュー資料である。記述する「現状」と「設計上の変更予定」は区別する。動作変更、API実行、DB/GCSへの接続、性能計測は実施していない。第2段階A全体の完了報告ではない。

## 1. 範囲・根拠

- 入口は `src/index.html` → `main.js` と、同HTMLで読み込む分割ファイル。`api_runtime.js` の直後に `transport_retry.js` が読み込まれる（index:1344–1345）。動的ロードされる楽譜・管理・改善要望の呼出元も含めた。
- `src/static/js` の実行コードを構文解析し、通信ヘルパーの呼出位置・引数式・囲む関数を添付CSVに採取した。`testable/` と `frontend_testable_logic.js` は除外した。
- bare `request` はポータルのものを対象とし、音声モジュールのWorker要求・Web Locks・IndexedDBの同名関数を除外した。
- 音楽機能の `storage_remote.js` の `send` はfetchの別名として別記した。静的JS/CSSの動的ロード、img/audio/video、PDF.js内部の取得、Service Workerのpush処理は、このAPI呼出位置の件数に含めない。
- CSVは [PERF_STAGE2A_COMMUNICATION_CALLS.csv](PERF_STAGE2A_COMMUNICATION_CALLS.csv)。1行はソース上の呼出位置であり、実行時の要求数・独立したURL数ではない。ヘルパーとその呼出元の両方を含むため、合算して通信数にしてはいけない。
- CSVのURLは実データではなくソース式。optionsが変数・spreadの場合はメソッドを推測せず `dynamic` としている。関数列は囲む名前付き関数等の目印であり、無名コールバックの厳密なスタックではない。

| CSV分類 | 呼出位置数 | 意味 |
|---|---:|---|
| request | 105 | 通常共通入口の呼出元。ファイル操作への分岐も含む |
| transport | 20 | fetchWithTimeout直接18か所＋再試行層のoriginal呼出2か所 |
| native-fetch | 5 | 通信基底、互換、revision、GCS |
| bootstrap-or-compat | 5 | bootstrap/revision用ヘルパーの呼出元 |
| feature-call | 7 | 改善要望・PDF編集の機能内ヘルパー呼出元 |
| sheet-call | 11 | 楽譜専用APIの呼出元 |
| file-operation-call | 3 | actor・結果照会・本体送信の呼出元 |
| extra-create | 19 | saveExtraへの登録呼出元。URL列はcollection名の式 |
| music-native-alias | 2 | チューナー・メトロノームのfetch別名 |
| 合計 | 177 | 重複する階層を含む静的呼出位置 |

## 2. 現在の共通契約

以下の記号を後続の表で用いる。

| 記号 | 現在の処理と根拠 |
|---|---|
| T | `transport_retry.js:10–44`。GETは408/429/502/503/504または一部の通信例外で追加最大2回、250ms/750ms。timeout/abortは再試行しない。Retry-After未解釈。呼出ごとに予算を作り直す。GET以外の自動再試行なし |
| G | `api_runtime.js:357–417`。同一identity＋応答epoch＋URLの実行中GETを集約。IndexedDB読取、ETag付与、ETag付き応答を保存。4一覧のみ10秒再利用。初回送信の通信例外時は許可されていればキャッシュ代替。401後再送の例外はそのcatchの外。HTTP503をキャッシュ代替する経路ではない。304では再検証時刻を更新しない。キャッシュなし304と不正JSONの扱いは下記参照 |
| A | `request()` の401回復。`tryRecoverPortalSession()` 後に本体を1回再送。ただし現在はその再送にもTの予算が新たに付く。元のGETと再送で最大6回、認証確認の送信はさらに別（異なる状態の連鎖を仮定した上限） |
| P | `isLivePromotionRequest()`。`/api/bootstrap`、`/api/extra/promotions`と子パス、`/api/promotions/operations/*`。no-store、応答キャッシュとGET集約を通らない。401回復あり。JSON解釈が状態判定より先で、非JSON応答は例外になる |
| F | `portal_file_operations.js`。操作ID・指紋・所有者scopeを維持する専用経路。120秒、no-store、identityを前後で確認。actorは実行中だけ集約。401自動回復はこのsendにはない。GETにはTが適用される |
| S | `scores/sheet_api.js`。no-store、IndexedDB代替・GET集約なし。401回復と1回再送あり。HTTP状態を返す。本文解釈失敗はdata=null。アカウント変更・通信・中止などは例外。再送ごとにTが新規予算になる |

Tのtimeoutは基本的にfetchがResponseを返すまでであり、後続の本文読取や操作全体の所要時間を保証するものではない。PDF・保存ダイアログは別の中止処理も持つ。変更予定と現在の保証を混同しない。

通常のタイムアウトは認証10秒、bootstrap-lite12秒、core20秒、その他GET15秒、更新20秒。完全一致のパス判定なので、v2追加時は別途修正が必要（`api_runtime.js:26–32`）。

## 3. fetchWithTimeout直接18か所

行番号は対象コミットのもの。1件の操作の中の再送位置も、別の行として列挙している。

| ID | ファイル:行 / 関数 | URL・メソッド / 起点 | 論理要求・認証・結果 | 現状の再試行・キャッシュ / 実装前の扱い |
|---|---|---|---|---|
| D01 | auth_feature.js:59 / isPortalAuthenticated | GET /api/auth/devices/{deviceId} / 起動・復帰 | 1回の認証確認、3状態。送信前条件あり | T、Gなし。D04と送信・応答分類だけを共有する予定 |
| D02 | auth_feature.js:178 / handlePortalLogin | POST /api/auth/portal-login / ログイン操作 | 1回のログイン。更新20秒、JSON解釈失敗は{} | Tによる追加送信なし。認証確認GETと合流させない |
| D03 | modules/admin_system/environment_management.js:53 / refreshSystemEnvironmentMenuVisibility | GET /api/system/environment/status / メニュー可否確認 | ローカルの権限・device検査後に取得。不成功ではボタンを隠す | T、G/Aなし。request()経由の同URLもあるが、結果処理が違うので一律統合しない |
| D04 | modules/common_helpers/api_runtime.js:195 / tryRecoverPortalSession | GET /api/auth/devices/{deviceId} / 401回復 | 1回の認証回復、真偽値 | T、実行中集約なし。D01との相違は認証比較表に記載 |
| D05 | 同:341 / request | GET/更新 / Pの初回 | プロモーション・操作結果・full bootstrap | T＋P。構造化結果はstatus/data/retryAfter |
| D06 | 同:343 / request | D05と同じ / 401後 | D05と同じ論理要求の再送 | Tの再初期化を修正対象とする。更新系の自動再試行を増やさない |
| D07 | 同:370 / request | GET url / 通常初回 | 一覧・詳細・管理GET | T＋G＋A。強制更新の集約キーと予算を補正する対象 |
| D08 | 同:393 / request | D07と同じ / 401後 | D07と同じ論理要求 | 予算をD07から引継ぐ対象。初回D07のtry/catch外にあるため、再送の通信例外・timeoutではGのキャッシュ代替もshowAlertも実行されず、その例外が呼出元へ伝わる。予算引継ぎだけを理由に初回のcatch内へ移さない |
| D09 | 同:421 / request | POST/PUT/PATCH/DELETE url / 保存操作 | 通常更新。成功後にキャッシュ無効化 | T追加なし、401回復あり。保存結果の個別契約を維持 |
| D10 | 同:435 / request | D09と同じ / 401後 | D09と同じ論理要求 | 更新の自動再試行を追加しない |
| D11 | modules/improvement_suggestions.js:30 / api | GET/POST/PUT/DELETE path / 一覧・登録・編集・削除 | 機能内ヘルパー。失敗はdetailまたは既存文言の例外、204=null | T、G/Aなし。機能の既存表示を固定してから対象判断 |
| D12 | 同:362 / pdfEditorApi | GET/POST path / 管理PDF一覧・登録 | 機能内ヘルパー。失敗は例外、成功JSON | T、G/Aなし。改善要望apiと似ていても一律統合しない |
| D13 | modules/navigation/helpers.js:154 / recordAccessLog | POST /api/system/access-logs / 画面遷移から派生 | fire-and-forget。認証フラグ・device確認。不成功はconsole警告 | 更新20秒、追加再試行なし。利用者の手動取得として分類しない |
| D14 | modules/performance_day/events.js:104 / exportPerformanceDayInfoExcel | GET /api/reports/performance-timetable/{id}/xlsx / 出力操作 | 1回のExcel出力。blob化・Object URL・download | T、G/Aなし、15秒。JSON専用処理へ統合しない |
| D15 | modules/scores/pdf_viewer.js:156 / fetchPdf | GET url / PDF選択 | 1回のPDF取得。切替時AbortController、本文arrayBuffer | T、no-store、G/Aなし。中止・旧PDF排除を維持 |
| D16 | modules/scores/sheet_api.js:71 / call | GET/更新 url / 楽譜操作・取得・ポーリング | Sの初回 | T＋S。通常GET15秒、更新20秒、呼出元指定timeout優先 |
| D17 | 同:74 / call | D16と同じ / 401後 | D16と同じ論理要求 | D16から予算を引継ぐ対象。request()だけ修正して完了としない |
| D18 | utils/portal_file_operations.js:41 / send | GET/更新 url / actor・結果確認・本体 | F。保存前actorは維持し、保留0件の復帰ではactorを呼ばない | T＋F。結果確認不能を確定失敗にしない |

D05/D07/D09は独立した分岐、D06/D08/D10はその再送。D16/D17も同様である。これを18個の独立した操作と数えない。

### 変更前に固定する例外と304

| 現状 | 設計との差と試験 |
|---|---|
| 初回D07と再送D08で通信例外の扱いが異なる | 上記の差を修正前の試験で固定する。第2段階の予算引継ぎでは差を維持する。代替表示・警告を揃える場合は、別の挙動変更としてレビュー・計測してから行う |
| cachedがない304 | 304でもcachedがtruthyの場合だけ返す。本文がない場合は!response.okに入り、通常は失敗警告と例外になる。設計6.3の条件ヘッダーなし再取得は意図した変更であり、現状の成功経路ではない。S2-11で修正前/後を区別する |
| エラー応答のContent-TypeがJSON、本文が不正 | await response.json()の構文エラーがそのまま伝わり、その後のshowAlertには到達しない。S2-09で固定する。分類層のclone利用だけではこの後段の構文エラーは直らないため、本文保護と後段の安全な解析を混同しない |

P、S、Fの本文解析・警告・構造化結果はそれぞれの契約を維持する。全経路を同じcatchへまとめる修正は行わない。

## 4. 通常requestの呼出元と動的URL

105か所のファイル・関数・URL式・options式はCSVの `kind=request` に全件記載する。以下はその通信ポリシーと操作単位の分類であり、固定URLだけを抽出した完全なAPI仕様ではない。

| 呼出元・用途 | URL群 | 起点 / 操作単位 | 現在の経路・注意 |
|---|---|---|---|
| bootstrap_loader / loadEssentialData・loadAllData等 | /api/bootstrap-lite・core・full | 起動・復帰・手動更新ごと | lite/coreはG、fullはP。requestBootstrapDataの分岐を維持 |
| bootstrap_loader / loadPerformances等 | /api/performances・schedules・announcements・events・members | 個別一覧ロード | GETはG＋T＋A。10秒再利用は最初の4一覧だけ |
| bootstrap_loader / loadExtraData | 後述21エントリー | 指定集合の再読込。Promise.allSettled | promotionsだけP、他はG。21呼出位置ではなくmapの1位置から展開される |
| bootstrap_loader / saveExtra | /api/extra/{name} POST | 呼出元の登録操作 | name/payloadは呼出元依存。CSVのextra-createの19行に呼出元を展開。URL列はcollection名でありURLそのものではない |
| members/helpers | /api/members/{id}・member-introductions | 団員詳細・紹介を開く | G。上位にも詳細Promise/紹介キャッシュがあるため二重化を避ける |
| notices / loadNotices等 | /api/notices と子パス、/api/announcements と子パス | 一覧・投稿・編集・削除 | GETの実行中Promiseは上位にもある。更新はrequest経由 |
| recordings | /api/recordings GET/DELETE | 録音画面・削除 | 一覧はG。メディア再生そのものの取得とは区別 |
| performances・members/api・desired_pieces・portal_views | 各資産付きAPIと子パス | 保存・削除・プロフィール変更 | `_portalFileOperation`指定はrequest冒頭でFへ分岐。通常更新と区別 |
| date_piece_promotion/api | /api/extra/promotions、/api/promotions/operations/{id} | 保存・結果照会 | P。構造化結果の非JSON503対策と操作ID維持が必要 |
| absences・events・members/events・payments | /api/extra/absences・event_responses・payments、/api/events | 出欠・回答・会計操作 | 更新メソッドとjsonOptionsをCSVに記載。権限で応答が変わるため一覧の扱いを一律化しない |
| practice_casting・render_piece_practice | /api/extra/castings・practice_instructions・piece_infos | 入力保存・削除 | saveExtra経由の登録もある。保存後の描画依存は後続成果物 |
| date_piece_promotion/events | /api/extra/date_adjustments・date_adjustment_responses | 回答保存・重複回答整理・削除 | Promise.allの複数DELETEは別行の更新。再試行による重複と混同しない |
| albums・concert_record・performance_day | /api/extra/albums・photos・concert_record_videos・performance_day_infos | 写真・動画・当日情報操作 | 一部はFormData。アルバム回収は第4段階で扱う |
| admin_system/api・members・sns・portal_views | part_settings・venue_settings・org_settings・connection_settings・sns_settings・flyer関連 | 管理設定・順序入替・割当 | 順序入替等の複数更新を1HTTPへ統合する変更は今回行わない |
| admin_system/access_logs・diagnostics・database_viewer | /api/system/access-logs・readiness-summary、動的tableUrl/recordUrl | 管理画面表示・検索・診断 | GETはG。クエリ条件込みのURLで区別。診断対象と権限を維持 |
| admin_system/environment_management | /api/system/environment/status・release/history・sync/history、release/promote・sync/prod-to-test | 管理画面・明示した運用操作 | 前者GET、後者POST。D03と異なる呼出元を持つ |
| admin_system/menu_management・permission_management | /api/system/menu-settings・members・members/{id}/permission | 表示設定・権限管理 | メニューGETはforceRevalidate等を指定。内部options維持を試験 |
| notifications/settings | /api/notifications/settings・subscriptions | 設定表示・保存・購読登録/解除 | 設定GETはforceRevalidate=true、allowCacheFallback=false |
| auth_feature | /api/auth/member-password POST | パスワード設定 | request更新経路。認証確認GETと共有しない |
| upload_forms | /api/drive/upload/session・upload・upload/complete POST | 録音アップロード | セッション→GCS転送→完了登録の複数工程。後述の専用再試行を維持 |

### loadExtraDataの21エントリー

根拠: `modules/bootstrap_loader.js:677–738`。すべてGET。起点は引数collectionNames（nullなら全件）、1エントリーの取得ごとにGまたはPの論理要求を作る。

| appState側の名前 | URL |
|---|---|
| absences | /api/extra/absences |
| eventResponses | /api/extra/event_responses |
| dateAdjustments | /api/extra/date_adjustments |
| dateAdjustmentResponses | /api/extra/date_adjustment_responses |
| sheets | /api/sheets |
| payments | /api/extra/payments |
| castings | /api/extra/castings |
| pieceInfos | /api/extra/piece_infos |
| practiceInstructions | /api/extra/practice_instructions |
| performanceDayInfos | /api/extra/performance_day_infos |
| desiredPieces | /api/extra/desired_pieces |
| promotions | /api/extra/promotions（P） |
| albums | /api/extra/albums |
| partSettings | /api/extra/part_settings |
| venueSettings | /api/extra/venue_settings |
| flyerDistributions | /api/extra/flyer_distributions |
| flyerDistributionAssignments | /api/extra/flyer_distribution_assignments |
| concertRecordVideos | /api/extra/concert_record_videos |
| orgSettings | /api/extra/org_settings |
| snsSettings | /api/extra/sns_settings |
| connectionSettings | /api/extra/connection_settings |

## 5. 共通requestを通らない操作

| 経路 | 現在のURL・操作 | 結果・認証・キャッシュ / 変更判断 |
|---|---|---|
| requestJson | GET /api/revision、revision?_=時刻。request不在時のbootstrap代替も定義 | 生fetch。revisionはcache=no-store。T/A・明示timeoutなし。代替分岐は通常の読込順ではrequestあり。削除・置換はせず、外部通信timeoutの既存不足として追跡 |
| portalFetchJson | 任意url/options（api.js:2） | 生fetch、204=null。定義とindexからの読込は存在するが、今回の検索で本番呼出元を確認できない。未使用候補として記録するだけで削除しない |
| improvement_suggestions/api | GET/POST /api/improvement-suggestions、POST /api/system/improvement-suggestions、PUT/DELETEその子パス | D11。会員一覧と管理更新は呼出元で扱う。G/Aなし |
| improvement_suggestions/pdfEditorApi | GET/POST /api/system/pdf-editor/files | D12。FormData登録を含む。PDF生成・downloadリンク等のブラウザ取得は別追跡 |
| portalSheetApi.call | /api/sheets、/version、/upload、/tickets、/zip-jobs/*、呼出元のurl/t.infoUrl | S。CSVに11呼出位置。GETと更新の予算・401を区別。zipポーリングは自動であり、手動10秒制御の回避経路にしない |
| portal_file_operations/send | actor GET、operations/{id} GET、資産付き本体の更新 | F。actor取得、結果照会、本体再送を区別し、操作IDを引継ぐ。復帰時の結果照会はユーザーの新規保存ではない |
| uploadResumableChunks | GCSセッションURLへPUT、8MiB単位 | 生fetch。1チャンクについて最大3試行、失敗後offset照会、1秒/2秒待ち。T/A/Gなし。一般GET予算へ統合しない |
| queryResumableOffset | 同URLへContent-Range: bytes */sizeのPUT | 生fetch。308とRangeを確認。上記と同じアップロード内の復旧処理。明示timeoutなし。今回は不足を記録するのみ |
| tuner/storage_remote | /api/tuner＋path、methodはcall引数 | fetch別名、15秒、ownerEpoch/abort、no-store。第2段階の共通処理に統合しない |
| metronome/storage_remote | /api/metronome＋path、methodはcall引数 | fetch別名、10秒、ownerEpoch/abort、no-store。同上 |

音声機能の実際の全endpoint展開、img/audio/download URLのブラウザキャッシュ、静的アセット再検証、PDF.js Workerの取得は、上記177行だけでは網羅を主張しない。第2段階のAPI集約と関係する境界を把握したものである。

## 6. 論理要求の境界と予算引継ぎ候補

| 経路 | 同じ予算を引き継ぐ範囲 / 第2段階の設計 |
|---|---|
| 通常request GET | D07→D08。一時的追加最大2回、401後は別枠1回。unknown503は一時的予算内1回 |
| PのGET | D05→D06。同じルール。構造化結果と本文保護を維持 |
| 楽譜call GET | D16→D17。同じルール。S独自のエラーとno-storeを保持 |
| D01/D04 | 同コンテキストの送信・応答分類だけを共有。認証要求自身の予算を持つ。各関数の副作用は認証比較表に従う |
| その他の単発GET | 各呼出単位で予算を持つ。自動ポーリングの周回を「401後の再送」と誤認しない。周回間隔・終了条件は別途確認 |
| ファイル操作・promotion・楽譜保存 | 操作結果確認のGETと、更新本体のHTTP要求を区別。結果不明の操作IDを作り直さない |
| GCSチャンク・音声専用クライアント | 今回の共通GET再試行に組み入れない |

## 7. 修正前の計測計画

棚卸し時点は未実行。その後、先行2シナリオと対照をNode VM/モックHTTPの5試験で固定した。[修正前計測](PERF_STAGE2B_BASELINE.md)を参照。実ブラウザ・実DB計測は未実施。

| シナリオ | 記録対象 | 対応試験・着手条件 |
|---|---|---|
| 起動＋復帰＋複数401の同時発生 | D01/D04、初回送信数、再試行数、apply/clear回数、AUTH_END回数、last_seen更新数 | S2-05。副作用表に基づく既存挙動を先に固定 |
| 同一一覧の同時GETとforce混在 | 呼出数/実送信数、identity/epoch、IDB読書、表示更新 | S2-02/03/12。団体ヘッダー指定時の回避も含む |
| 503→401→502 | データ送信4回上限と認証通信の別計数 | S2-04/06。修正前は予算再初期化の挙動を記録 |
| 既知503/HTML503/不正JSON | retry、Retry-After、本文を後段で読めること、既存警告 | S2-06/07/09。楽譜・ファイル操作・promotionを別々に確認 |
| 同じタブの再選択・自動poll | 起点、要求キー、最小間隔、残存表示 | S2-08。成功/認証切替時の解除、pollをmanualにしない |
| 4一覧の200→304→再表示 | 転送量、本文構築、SQL、IDB更新、再描画 | S2-11。本文ハッシュはDB削減と報告しない |
| 空データと限定extra再取得 | 実GET数、取得フラグ、関係画面だけの描画 | S2-10/16/17。状態・依存関係表完成後 |

ローカルモックでは呼出数・Response契約・競合を検証する。SQL、last_seenの実更新、DB/GCS、プール待ちなどはモックで確認済みとせず、専用環境の計測を別成果物にする。第1段階Aの未計測項目は継続する。

## 8. 今回の確認と残件

実施: コード読取、構文解析による177位置の採取、fetchWithTimeout直接18位置の確認、動的extra21件とsaveExtra呼出元19件の展開、認証副作用の対照、CSVの位置/重複/対象範囲の検査。

棚卸し作成時はテスト未実行。その後の先行2シナリオの試験結果は上記計測資料へ分離して記録した。ブラウザでの通信/HAR/画面比較、実DB・GCS接続、実性能計測は未実施で、ブラウザ・実機の成功は主張しない。

第2段階Aの後続成果物: 取得状態対応表、データと描画の依存関係表、bootstrap v2項目契約、監査再利用可否と取得元の一覧、対象別の修正前計測。監査は現時点で再利用有効と判定しない。

第3段階の追跡: 監査の主体取得・接続待ち・INSERT・全体時間・イベントループへの影響を分離する。Server-Timingだけでは監査時間を含まない。監査の同期処理を今回非同期化しない。
