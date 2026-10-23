# 第2段階A 取得状態の対応表 v1.0

2026-10-21 / 詳細設計v1.3 / 読取対象: `9c76fd920fab12a1e3c5286c0c6adbc2e9099309`（origin/main）

既存状態を棚卸しし、追加機構を重ねないための資料。実装・試験・計測は未実施。共有ストアは `src/static/js/store/app_state.js`、各モジュールのappStateはportalRuntimeContextから参照する。

## 1. 取得・描画・鮮度を分ける

| 既存状態 | 初期値・設定元・利用先 | 成功/失敗・空データ | 第2段階での対応 |
|---|---|---|---|
| essentialDataLoaded | 初期false。navigation/events.jsのenterPortal、bootstrap_init.jsの復帰、bootstrap_loader.jsの明示更新がloadEssentialData完了後にtrue | loadEssentialData自身が必ず設定するフラグではない。キャッシュpreviewを維持してreturnする分岐もあり、trueだけで最新確認成功とは言えない | 初期表示済み判定として再利用。最新確認成功と混同しない。別の全体loadedを作らない |
| lastEssentialDataLoadedAt | 初期0。loadEssentialDataで最新データの適用/描画成功時に更新。復帰の60秒判定が参照 | キャッシュpreviewだけを残した失敗では更新しない。初期0と取得済み空は別 | 鮮度判定として維持。304/代替データ/描画失敗を分けて試験 |
| dataLoaded | 初期false。loadFullDataInBackgroundでloadAll完了後true、手動更新でfalseへ戻す | 背景のcore完了を表す場合がある。全extra・録音・楽譜が取得済みという意味ではない | 名前だけを理由に全コレクションloadedへ展開しない |
| fullDataLoading / backgroundLoadScheduled | 初期false。背景予約時に両方true、開始時に予約false、finallyでloading=false | 背景処理の重複防止。失敗でもloading解除。非表示中は開始を待つ | 既存ガードを維持し、新しい背景Promise管理を重ねない |
| portalRefreshInProgress / portalRevisionRefreshInProgress | 必要時にPromise設定、finallyでnull | 明示更新とrevision確認の実行中集約。データ取得済みの印ではない | GET集約とは別の操作単位。消さず、責務を維持 |
| bootstrapDataVersion | 初期0。applyBootstrapDataのたび増加 | 同じ本文を適用しても増える。サーバーの変更番号ではない | 本文の変更検出や認証世代に流用しない |
| lastInitialRenderVersionKey / lastBackgroundRenderVersionKey | 初期空。bootstrapDataVersion＋heavy有無を記録 | 背景描画の重複を避ける。取得状態ではない | 304の時刻更新だけでバージョンを進めない変更は依存試験後に実施 |
| suppressDerivedRender | 初期false。まとめ描画中true、終わりにfalse | 子描画からの派生描画を抑制。現状は単純な代入で、途中例外のfinally保護はない | 既存不具合候補[#146](https://github.com/clryo26/kanade-orchestra/issues/146)として別追跡。性能改善の部分再描画に混ぜて修正しない |
| portalAuthVerified / lastPortalSessionVerifiedAt | 初期false/0。applyで設定、clearで解除。復帰の認証鮮度判定 | データの取得成否とは別 | 認証副作用比較表を優先。データloadedと統合しない |
| portalAuthGeneration / portalResponseEpoch | 認証世代はapply、応答epochは保存後無効化とclearで変更 | epoch変化は認証切替に限定されない | deviceId・認証世代・認証遷移カウンターによる設計は別資料参照。現在カウンター未実装 |

根拠: bootstrap_loader.js:72–244, 394–490, 508–565, 595–655、bootstrap_init.js:71–112、navigation/events.js:68付近、api_runtime.js:123–165, 253–258。

## 2. 遅延データの取得済みフラグ

`deferredPortalDataFlags` はbootstrap_loader.js:259–279のモジュール内オブジェクト。19キーすべて初期falseで、markDeferredPortalDataLoadedが存在するキーだけtrueにする。appStateへ同じマップを新設しない。

| キー | 読取を必要とするタブ | 成功の設定元 |
|---|---|---|
| events | event / member-event | loadEvents |
| absences | member-schedule / member-absence | loadExtraData |
| eventResponses | member-event | 同上 |
| dateAdjustments / dateAdjustmentResponses | member-date-adjustment | 同上 |
| pieceInfos | member-piece-info / member-practice-instruction | 同上 |
| practiceInstructions | member-practice-instruction | 同上 |
| performanceDayInfos | member-performance-day / performance-day-admin | 同上 |
| castings | member-casting / casting-admin | 同上 |
| albums | member-album | 同上 |
| flyerDistributions / flyerDistributionAssignments | member-flyer-distribution。管理側はflyerDistributions | 同上 |
| concertRecordVideos | member-concert-record / concert-record-admin | 同上 |
| payments | payment-admin / payment-setting | 同上 |
| desiredPieces | member-desired-piece | 同上 |
| promotions | member-promotion | 同上。別にpromotionLoadStateも持つ |
| venueSettings | venue-admin | 同上。navigation側にも個別取得分岐 |
| connectionSettings | system-connection | 同上 |
| authDevices | system-auth | loadAuthManagement |

根拠: ensureDeferredTabDataLoaded:293–332、loadEvents:583、loadAuthManagement:670、loadExtraData:677–823。

現状、成功したvalueが空配列でもloadExtraDataは適用してmarkする。Promise.allSettledの失敗項目は以前のデータを維持してmarkしない。ただし以前trueだったキーを失敗でfalseへ戻す処理ではない。

applyBootstrapDataはこれら19フラグを一括でmarkしない。liteでpaymentsを取得しても、管理会計の全件取得済みにしてはいけない。引数なしのfullが含めるデータと、coreの空extrasも区別する。

clearPortalAuthStateはこのモジュール内19フラグをリセットしていない。またauth_feature.js:252–275のlogoutPortalはページを再読込みせず、利用者情報を解除するが、19フラグと既存extrasを消していない。別利用者の同一タブログインで前利用者のデータが表示される可能性を、既存不具合候補[#145](https://github.com/clryo26/kanade-orchestra/issues/145)として別に起票した。**表示の再現は未確認**であり、権限を越えた表示が確定したという記録ではない。bootstrapで上書きされる集合、管理者向けデータ、遅い応答の扱いは再現試験で確認する。

この修正は性能改善の取得状態管理と分離する。ログアウト時のデータ/フラグ破棄と再読込みのどちらを選ぶかも、独立した修正レビューで決定する。再現条件はIssueに記載し、今回の資料更新では試験・修正を行わない。

現在はin-flightを表す遅延フラグもなく、重複GETは下位のrequestで合流するが、呼出元の適用・描画までは一度になる保証がない。この性能上の棚卸しと、認証切替時の不具合候補を区別する。

## 3. 機能固有の既存管理

| 対象 | 既存状態と挙動 | 第2段階の方針 |
|---|---|---|
| promotion | loadExtraDataがpromotionLoadStateをloading→loaded/error。初期ストアに同名の定義はなく、実行時に設定 | 取得済みフラグと表示用状態を区別。新しいpromotion用ローダーを重ねない |
| 団員詳細 | memberDetailRecords / LoadStates / LoadPromises。id単位loaded/loading/error、Promise合流、失敗時record削除 | helpers.js:183–213。既存を維持。紹介の成功で詳細loadedにしない |
| 団員紹介 | memberIntroRecords / LoadPromise / Identity / Generation。開くたびforceRevalidate＋代替禁止。identity/generation不一致の適用を拒否 | helpers.js:215–246。完了結果の永続的な取得済み判定を足さない |
| 録音 | recordingsLoadedは初期false。loadRecordingsがfilesを適用しtrue。ensureはtrueなら描画だけ。recordingsFeatureLoadPromiseはJS読込の管理 | recordings.js:6–61。JS読込済みとデータ取得済みは別。空filesでも取得済み |
| 楽譜 | sheetsLoaded、sheetListVersion、scores/sync.jsのchecking/account/requestSeq/appliedSeq/lastOkAt等。タブ表示では既知データを描画しversion確認 | ensureSheetsLoadedを一般の「一度取得したら省略」へ変えない。空filesも成功。force時と通常checkingの合流条件を維持 |
| bootstrap経由の重い一覧 | data.recordings/data.sheetsの存在でrecordingsLoaded/sheetsLoadedをtrue | extras.sheet_libraryだけとdata.sheetsの有無を区別。applyBootstrapDataの既存条件を試験 |
| notices | portalNoticesLoadPromiseなど機能側の集約 | 共通GET集約と役割が異なるため、削除や二重の再実装をしない |

## 4. 変更前に固定する試験

1. 初期空配列は未取得、正常な空応答は取得済み、失敗は未取得のままを区別する。
2. previewのみを維持した失敗で最新確認時刻が更新されないこと。loaded=trueを最新確認成功と扱わないこと。
3. lite本人会計と管理全件会計、core空extrasとfull各集合を混同しないこと。
4. 同時タブ表示、部分成功、前回成功後の失敗、古い応答の適用を試験する。ログアウト/別利用者の既存不具合の再現・修正は#145で独立して扱い、性能変更との競合は両変更を合わせる際に回帰確認する。
5. 楽譜のversion同期と団員紹介の都度確認を、一般の取得済み省略へ置き換えないこと。

新しい状態プロパティを採用する場合は、この表の既存状態で不足する理由、設定/解除箇所、認証切替時の処理を示す。動作変更への着手にはS2-10/12/15/17と修正前計測が必要。
