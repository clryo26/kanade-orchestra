# 第2段階A 描画の依存関係表 v1.0

2026-10-21 / 詳細設計v1.3 / 読取対象: `9c76fd920fab12a1e3c5286c0c6adbc2e9099309`

部分再描画の範囲を決めるためのレビュー資料。現在の呼出連鎖を記録したもので、以下をそのまま新しい描画ディスパッチ表として実装しない。表の「影響」は直接参照と既存ヘルパー経由を含む主要な依存で、全DOMの網羅保証は試験前には行わない。

## 1. 現在の広範な描画

| 起点 | 現在の呼出連鎖 | 注意 |
|---|---|---|
| renderEssentialViews | performances、upload選択、schedules、announcements、events、members、payment管理、venue/org/sns。派生抑制を解除後に団員演奏会/予定/extra、part、schedule選択、home | bootstrap_loader.js:422–444。liteにないデータの画面も描画する |
| renderInitialViews | 上記にheavy一覧、casting/practice/performanceDay/connection、authなどを追加。最後にversionKey記録 | 同:595–627。heavy=falseでも多くの管理描画が残る |
| renderBackgroundViews | schedules/events/members/extra、sheet/casting/practice/performanceDay/auth、選択肢/home | 同:629–651。versionKey一致時は省略 |
| loadExtraData完了 | 全項目のsettled後、part/venue選択肢、org適用、memberExtra、sheet/payment/part/venue/flyer/casting/practice/performanceDay/org/sns/connection管理 | 同:802–823。要求集合が1つでも同じ広範描画を行う |
| renderMemberExtraViews | absence、sheet（heavy時）、practice、flyer、payment、casting、event、performanceDay、dateAdjustment、piece、desired、manual、promotion、album、concertRecord、sns | members/render.js:135–155。これ自体を「部分描画」とみなさない |
| 個別描画の派生 | announcements→home、members→memberExtra、events→memberEvent、schedules→memberSchedules、performances→派生画面 | suppressDerivedRenderがfalseの場合。二重呼出しは最上位だけ数えて判定しない |
| home差替え | notices.js:516付近がrenderPortalHomeをラップ | 元のportal_views.jsだけを試験して完了にしない |

## 2. データ集合と影響先

| データ | 直接/派生の主な影響先 | 保護する編集状態・試験 |
|---|---|---|
| performances | 演奏会管理/団員演奏会/home、upload演奏会/曲、schedule演奏会/曲、payment料金、casting/practice/piece/performanceDay、flyer/concert/recording/sheetの演奏会表示・絞込 | 演奏会/曲の選択、料金チェック、編集中の曲一覧を維持。演奏会削除・空配列も反映 |
| schedules | 管理予定、団員予定、出欠表示、JST日付依存の一覧 | 期間/選択日、フォーム。absencesとの結合を試験 |
| announcements / notices | お知らせ一覧/詳細、homeの新旧お知らせ統合 | 開いている詳細と編集を維持。ラップされたhomeで確認 |
| events / eventResponses | 管理イベント、団員イベント、回答集計 | 回答入力・編集中イベント。片方だけ更新したケース |
| members / memberDetailRecords | 団員一覧・編集、名前/パート整列、会計対象、castingメンバー、flyer担当候補 | 未読詳細を空値で上書きしない。権限表示と本人フォームを保護 |
| memberIntroRecords | 団員紹介 | 管理詳細と混用しない。紹介だけの更新で他フォームを再構築しない |
| absences | 出欠、団員予定 | schedulesと団員識別との結合 |
| payments | 本人会計、会計管理・設定 | renderPaymentAdminのpreserveFormを活用する候補。本人分を全件と誤認しない |
| castings | 団員乗り番、管理乗り番 | castingEditingMembers/Extras、演奏会/曲選択を維持 |
| pieceInfos / practiceInstructions | 曲情報、練習指示の団員画面・管理画面 | 選択中の演奏会/曲、編集中の本文を維持 |
| performanceDayInfos | 当日情報の団員/管理、演奏会選択 | フォームとExcel出力対象を維持 |
| dateAdjustments / dateAdjustmentResponses | 日程調整、回答一覧 | 回答途中の入力。両集合の片側更新を試験 |
| desiredPieces | 希望曲、投票・編集 | 絞込、参考音源、編集中File/入力。保存後の操作IDを維持 |
| promotions | 宣伝一覧・編集・結果確認 | no-storeの再確認とpendingを維持。画像Fileを無関係な取得で消さない |
| albums | アルバム一覧/選択/写真表示 | 選択アルバム、スクロール。画像本体取得の改善は別段階 |
| partSettings | パート順・選択肢、団員並び、casting/flyer/楽譜パート選択 | 選択値を保つ。設定の順序変更も反映 |
| venueSettings | 会場管理、予定等の会場選択 | 入力と選択。会場取得だけでorgフォームを描き直さない |
| flyerDistributions / flyerDistributionAssignments | チラシ配布管理/団員、担当名・演奏会選択 | 担当選択・配布入力。割当のみ更新も試験 |
| concertRecordVideos | 本番記録の団員/管理 | performancesと結合。選択中動画/編集を維持 |
| orgSettings | タイトル、アイコン、manifest、団体管理 | applyOrgSettingsとrenderOrgManagementを分離して検討。ロゴFileを消さない |
| snsSettings | SNS管理と団員SNS | 入力、リンク表示。無関係な管理フォームを描かない |
| connectionSettings | 接続設定管理 | 管理者限定の既存表示を維持。他データ取得で入力を保存値に戻さない |
| authDevices | 端末認証管理 | 一覧の更新で団員入力を再初期化しない |
| sheetLibrary / recordings | 専用一覧・選択/絞込/ビューア | 既存sync/新旧応答排除、再生/PDF、upload/saveと独立。一般の再描画へ巻き込まない |

主な根拠: members/render.js、portal_views.js、payments.js、schedules.js、performances.js、practice_casting/render.js、date_piece_promotion/render_piece_practice.js、admin_system/render.js、各機能モジュール。新しい依存は、対象関数の直接参照だけでなく日付・権限・名前変換などのヘルパーと実行時に読み込む関数も確認してから加える。

## 3. 副作用の強い描画

- `admin_system/render.js:194` のrenderOrgManagementは保存済みの団体情報を入力欄へ入れ、orgIconFileを空にする。無関係な再取得では呼ばない設計にする。第1段階BのObject URL解放を取り込んだ場合も、フォーム保護は別条件である。
- 同ファイルのrenderConnectionSettingsManagementは保存値を入力欄へ書く。未保存の入力を失うため、一覧表示とフォーム初期化を無条件に一緒にしない。
- `payments.js:547` のrenderPaymentAdminはpreserveForm=falseが既定。preserveForm=trueで料金入力等の再構築を避ける経路が既にある。日付更新は既存のpreserveForm利用を維持する。
- selectのinnerHTML再構築、file.valueの初期化、画像プレビュー差替え、details/scrollの再生成を検査対象にする。入力を退避・復元する新しい汎用基盤は作らず、まず不要な描画呼出しを減らす。

suppressDerivedRenderのfinally保護がない問題は、既存不具合候補[#146](https://github.com/clryo26/kanade-orchestra/issues/146)として別追跡する。renderEssentialViewsとrenderInitialViewsで例外を注入する再現条件をIssueに記載したが、今回試験は実行していない。性能改善の部分再描画にこの修正を混ぜない。

## 4. 保存後キャッシュ無効化との対応

api_runtime.js:220–258は全更新でbootstrap-lite/core/fullを候補にし、members・extra・sheets・recordings/drive・その他に分岐する。

| 現状 | 実装前に固定すること |
|---|---|
| membersの更新は一覧/詳細/member-introductionsを対象にする | v2追加後も漏らさない。メモリの詳細/紹介状態との整合も確認 |
| extraの更新は指定urlのpathを追加する | /api/extra/name/idの更新が一覧/api/extra/nameへ必ず展開される実装ではない。一覧キャッシュを残さない条件を対象別に試験し、無効化の不足を推測で解決済みにしない |
| sheet/date_adjust/practice_instructionでsheetsを追加 | 実際に影響する一覧と専用sheet syncのrefreshを確認 |
| recording/convert/driveでrecordings・drive/filesを追加 | GCS転送と一覧表示は別。取得条件付きURLの無効化も確認 |
| 成功した更新でportalResponseEpochを進める | 古いGETを拒否する仕組みを保持。描画世代・認証遷移とは別 |

### extra一覧の無効化不足が影響する範囲

`/api/extra/*`はfreshCacheTtlMsの10秒再利用対象ではなく、通常は毎回サーバーへ取得/再検証する。このため、無効化が不足しただけで、正常な200応答の最新本文を古い一覧キャッシュに置き換えるわけではない。サーバーが適切に再検証する前提では、残った古いキャッシュが表示されるのは、主に通信例外・timeout時に許可されたキャッシュ代替へ入る場合である。

HTTPエラー応答の503そのものは、現行Gのキャッシュ代替を起動しない。401回復後の再送D08も初回のcatch外であり、同じ代替表示には入らない。no-storeのpromotions等は通常のGと区別する。

修正の優先度と効果は、正常な200/304と通信例外を分けて評価する。更新後の再取得に成功した場合、再検証で304を受けた場合、ネットワーク例外で古い一覧へ代替した場合を対象別に試験し、「10秒間必ず古い一覧が表示される問題」と説明しない。

## 5. 部分再描画の受入条件

S2-16/17: データ1集合ずつの追加/更新/削除/空化と、上表の結合データ変更を行い、関係画面のDOMを確認する。無関係なフォームでは入力・File・選択・開閉・スクロールが変化しないことを同時に確認する。

修正前の関数呼出数・DOM・固定Linux/WebKitの画像を先に取得する。見た目が同じだけで、依存する非表示タブや次回表示の状態を省略しない。主な画面の実機iPhone確認は別途残す。

本表はレビュー用の依存候補と既存連鎖の棚卸しである。各対象の修正前計測と実行試験が揃う前に、表を根拠として広範な描画関数の置換へ進まない。
