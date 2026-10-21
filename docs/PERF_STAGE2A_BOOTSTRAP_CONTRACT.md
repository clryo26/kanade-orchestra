# 第2段階A bootstrap v2の項目契約・現状対照 v1.0

2026-10-21 / 詳細設計v1.3 / 読取対象: `9c76fd920fab12a1e3c5286c0c6adbc2e9099309`

この資料は現行v1の項目・利用先・互換制約を確定するためのレビュー版。v2の削除項目を承認済みと扱わない。現行コードにはbootstrap v2のルーター・表現バージョン・タイムアウト分岐はない。

## 1. 現状の経路

| 経路 | 構築・現在の内容 | 認証・キャッシュの現状 |
|---|---|---|
| /api/bootstrap-lite | bootstrap_service.bootstrap_lite_payload:104–127。基本3一覧＋団員summary＋4extra＋revision、ルーターでmenu_visibility追加 | routers/bootstrap.py:63–104。X-Device-Idの任意認証。401/403は未認証相当で本人会計[]、その他の例外は再送出。ETagは各collectionとmenuから作成 |
| /api/bootstrap-core | 同:130–137。extras={}、revision、ルーターでmenu_visibility | routers/bootstrap.py:107–119。認証依存宣言なし。revision＋menuのETag |
| /api/bootstrap（full） | 同:140–191。基本4一覧・団員詳細・録音/楽譜・20extra・auth_devices・revision、menu追加 | routers/bootstrap.py:122–171。認証依存宣言なし。実際の項目処理は各サービス参照。no-store、304を返さない。フロントもP経路でIDB/GET集約を使わない |

上記は既存ルーターの記述を示す。v2の公開範囲をfullの項目や「bootstrap」という名前から推測してはいけない。既存APIの権限変更はこの性能棚卸しで実施しない。

重要: liteは既にpublic_member_listによるsummary、coreは既に空extrasである。「現在はcoreが大量の全件データを返す」「liteが団員詳細をすべて返す」という前提では設計しない。

## 2. トップレベルの項目契約

型は通常の応答形。コレクションの各行は既存変換・スキーマを維持し、未列挙キーがないことを保証する表ではない。

| 項目・型 | lite | core | full | 利用先・空値・v2初期判断 |
|---|---|---|---|---|
| performances: object[] | あり | なし | あり | 演奏会/home/料金/各選択肢。_public_performancesがflyer_imageを公開URL化、created_at/updated_at除外。[]は空、欠落は既存値維持。新たな列削除は未承認 |
| schedules: object[] | あり | なし | あり | 予定/出欠。[]と未取得を区別。JSTの日付・表示順を維持 |
| announcements: object[] | あり | なし | あり | お知らせ/home。noticesによるhomeラップも対象 |
| events: object[] | なし | なし | あり | イベント・回答。遅延loadEventsも存在。liteへ新規追加しない |
| members: object[] | summary | なし | detail | normalizeMemberSummaryCollectionが既存summary項目を保持。詳細/紹介は別API。後述のフィールド表を優先 |
| recordings: object（files等） | なし | なし | あり | recording_payloadの契約を参照。applyはfilesを録音一覧に適用しrecordingsLoaded=true。v2へ転送する必要性は未計測 |
| sheets: object（files等） | なし | なし | あり | sheet_payload/list_payloadを使用。配列ならfilesに包む。applyはsheetsLoadedを設定。専用list_version同期を壊さない |
| extras: object | 4集合 | {} | 20集合 | 次表。欠落したextraは現状値を維持、明示[]は空にする |
| auth_devices: object[] | なし | なし | あり | 端末管理。専用loadAuthManagementあり。lite/coreへ追加しない |
| cloudRunRevision: string | あり | あり | あり | revision表示。現在のapplyは既存のcloudRunRevisionがtruthyならそちらを維持。更新判定は別のrevision APIも使う |
| menu_visibility: object | あり | あり | あり | ルーターが付与。applyPortalMenuVisibilityが適用。欠落時は現在値を維持 |

根拠: bootstrap_service.py、routers/bootstrap.py、bootstrap_loader.js:508–565、595–668、members/helpers.js。

## 3. extrasの集合・取得先

| v1のextra名 | lite | full | appState側・主な利用先 / 後続の既存API |
|---|---|---|---|
| payments | 本人分 | あり | payments、本人/管理会計。/api/extra/payments。lite本人分を管理全件取得済みにしない |
| part_settings | あり | あり | partSettings、選択肢/整列。/api/extra/part_settings |
| org_settings | あり | あり | orgSettings、タイトル/アイコン/団体設定。_public_org_settingsでicon_url変換。/api/extra/org_settings |
| sns_settings | あり | あり | snsSettings、SNS。/api/extra/sns_settings |
| absences | なし | あり | absences、出欠。/api/extra/absences |
| event_responses | なし | あり | eventResponses、イベント回答。/api/extra/event_responses |
| date_adjustments | なし | あり | dateAdjustments、日程調整。/api/extra/date_adjustments |
| date_adjustment_responses | なし | あり | dateAdjustmentResponses、回答。/api/extra/date_adjustment_responses |
| sheet_library | なし | あり | sheetLibrary。fullではsheets.filesと同じ構築結果を使う。専用/api/sheetsを優先し、新たな二重取得を作らない |
| castings | なし | あり | castings、乗り番。/api/extra/castings |
| piece_infos | なし | あり | pieceInfos、曲情報。/api/extra/piece_infos |
| practice_instructions | なし | あり | practiceInstructions、練習指示。/api/extra/practice_instructions |
| performance_day_infos | なし | あり | performanceDayInfos、当日情報。/api/extra/performance_day_infos |
| albums | なし | あり | albums、アルバム。/api/extra/albums |
| venue_settings | なし | あり | venueSettings、会場。/api/extra/venue_settings |
| flyer_distributions | なし | あり | flyerDistributions、配布。/api/extra/flyer_distributions |
| flyer_distribution_assignments | なし | あり | flyerDistributionAssignments、配布割当。/api/extra/flyer_distribution_assignments |
| connection_settings | なし | あり | connectionSettings、管理設定。/api/extra/connection_settings。団員画面へ内部項目を追加しない |
| desired_pieces | なし | あり | desiredPieces、希望曲。/api/extra/desired_pieces |
| promotions | なし | あり | promotions、宣伝。公開画像参照へ変換。/api/extra/promotionsはno-store |

concert_record_videosはloadExtraData/applyBootstrapDataに対応があるが、現在のfull構築の20extraには含まれない。取得先は/api/extra/concert_record_videos。coreの空extrasを「上記を取得した」と扱わない。

## 4. 団員の列と後続取得

| フィールド群 | 現状の返却/フロント利用 | v2での扱い |
|---|---|---|
| id、name、last_name、first_name、maiden_name、last_name_kana、first_name_kana、part | normalizeMemberSummaryCollectionが保持。団員表示・名前/パート整列・選択肢 | summaryとして維持。画面の項目/順序は変更しない |
| photo_url、joined_at | summaryにも含まれ、正規化で保持。photoは公開画像URLへ変換 | 未使用と推測して削除しない |
| permission、system_access_until、password_set | 団員管理一覧のバッジ・期限・パスワード設定済み表示（members/render.js:12–34） | summaryからの削除は表示変更になるため行わない。本人の認証判定の代用品にしない |
| maiden_name_kana、is_founder、is_recording_manager、is_sheet_manager、introducer、role、instrument_history、past_orchestras、comment | public_member_summary_payloadが除外する10項目。full/detail側のpublic_member_payloadには残る | liteの新たな削減として数えない。詳細は/api/members/{id}、紹介は/api/member-introductionsの既存権限/列に従う |
| password、created_at、updated_at | public_member_payloadの基底変換で除外 | 復活させない。password_setとpasswordを混同しない |
| その他の既存キー | 基底変換は元dictのコピーであり、完全な許可リストではない | 今回の表から全キー削除を生成しない。新たな列制限は実データの非機密スキーマと利用箇所を照合してから判断 |

根拠: auth_service.py:45–126、bootstrap_loader.js:655付近、members/helpers.js:183–246。団員紹介はMemberIntroductionの列で作成し、private,no-cache・ETag・Varyを持つ別表現。管理詳細のloadedへ転用しない。

本人会計の照合はpersonal_payment_list（auth_service.py:209付近）を維持する。deviceなしは[]、member_idがあればID一致、IDがなければmember_nameによる照合。画面に同名の利用者がいる等の既存問題を、この段階で別方式へ変更しない。

## 5. v2の判断とリリース条件

現時点で新たに削除・移動してよい項目は確定していない。特にliteの団員詳細削減とcoreの全件削減は既に行われているため、それを新規効果としてv2を実装しない。

v2は次の条件を満たした場合だけ第2段階Dで実装する。これはv2要件の削除ではなく、未確定の削除項目を推測しない着手条件である。

1. 項目ごとの転送量・構築時間と、実際の初回画面利用を測り、残す/後続取得へ移す列・集合を明記する。
2. 権限ごとの後続API、取得中の既存表示、失敗時の表示、空配列の意味を試験する。
3. 既存の団員詳細/紹介・楽譜同期・各タブ取得で足りる場合はそれを再利用し、同等の機構を追加しない。
4. v2のURL/表現バージョン/キャッシュをv1と分離。lite12秒/core20秒、パス依存判定とmutation無効化を更新する。
5. v2の404だけでv1へ切替え、v1応答をv2キャッシュへ保存しない。fullはno-storeを維持する。
6. v1は少なくとも90日維持し、利用状況を確認してから廃止判断。古いiPhoneのJSで空表示にならないことを確認する。
7. ポータル表現更新で音声関連の対象外IndexedDBを消さない。

レビューで項目移動を決定した場合は本表の各行を更新し、確定していないまま「v2項目契約完了」としてリリースしない。測定上の効果がない場合はv2動作変更を保留した理由を記録する。
