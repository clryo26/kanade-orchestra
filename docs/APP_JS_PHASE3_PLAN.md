# APP_JS Phase3 Plan

最終更新: 2026-07-01

## app.js の責務分類

- API
- UI
- Dialog
- Cache
- State
- Utility
- Rendering
- Event
- Audio
- Recording
- Members
- Admin
- Bootstrap / Initial Load

## Phase3 再評価（今回）

- `src/static/js/app.js` は本番ロジックを保持せず、互換ローダーへ縮小する。
- 旧 `app.js` 参照環境でも、`main.js` + `modules/` + `utils/` + `store/` を順次ロードして既存挙動を維持する。
- 純粋関数は `frontend_testable_logic.js` を正とし、Vitest は同ファイルを直接検証する。

## 現在の整理状況

- `src/static/js/main.js`: 本番エントリポイント
- `src/static/js/app.js`: deprecated 互換ローダー（本番機能実装なし）
- `src/static/js/utils/api.js`: API共通
- `src/static/js/utils/dialog.js`: ダイアログ共通
- `src/static/js/utils/cache.js`: キャッシュ共通
- `src/static/js/store/app_state.js`: 状態ストア
- `src/static/js/modules/`: 機能別モジュール
- `src/static/js/frontend_testable_logic.js`: テスト用純粋ロジック

## modules への分割計画

- API: `utils/api.js`
- Dialog: `utils/dialog.js`
- Cache: `utils/cache.js`
- State: `store/appState.js` 相当へ再分解
- Rendering: `modules/portal_views.js`
- Navigation/Event: `modules/navigation.js`
- Audio/Recording: `modules/recordings.js`, `recordings_feature.js`
- Members/Admin: 各 `modules/*.js`

## 今回実施した移動

- `app.js` の巨大実装を撤去し、互換ローダー化
- 実行責務を `main.js` と分割済み `modules/` / `utils/` / `store/` 側へ固定
- pure helper は `frontend_testable_logic.js` 側を優先利用する運用を明文化

## 運用ルール

- `app.js` へ新規実装禁止
- 新規本番ロジックは `main.js`, `modules/`, `utils/`, `frontend_testable_logic.js` のみに追加する
- テスト互換で必要な断片は段階的に `frontend_testable_logic.js` へ移行する
- `app.js` に残る純粋関数は、まず `frontend_testable_logic.js` を正とし、文字列ベーステストへの影響を避けながら段階削減する

## 次フェーズ候補

- `main.js` から定数/起動ヘルパーを `utils/` へ追加分離
- `frontend_testable_logic.js` の pure helper カバレッジを拡張
- `modules/` への再配置差分に合わせて Vitest シナリオを追加

## 追補（Phase6）

- `navigation.js`, `members.js`, `practice_casting.js` を薄い互換ローダーへ縮小した。
- `frontend_testable_logic.js` は `src/static/js/testable/` 配下の pure helper 集約へ再編した。
- `app.js` は引き続き互換ローダー専用で、新規本番実装は追加していない。

## 追補（Phase3-2）

- `main.js` から移設履歴コメント群を削除し、起動コンテキスト定義のみへ整理。
- 以後の移設履歴は本ドキュメントに記録し、実装ファイル内に長大な履歴コメントは残さない。

## 追補（Phase3-3）

- `main.js` に残っていた共有定数・起動コンテキストを `utils/runtime_context.js` へ分離。
- `main.js` は runtime context を受ける薄い委譲レイヤーとして維持。
- `index.html` と `app.js` 互換ローダーの読み込み順に `runtime_context.js` を追加。

## 追補（Phase3-4）

- `runtime_context.js` 側で legacy グローバル識別子（`$`, `today`, `appState` など）を提供。
- `main.js` は存在確認だけを行う最小ブリッジに縮小。

## 追補（Phase3-5）

- `main.js` に残っていた移設履歴コメント群を削除。
- 移設履歴の一次情報は本ドキュメントへ集約し、実装ファイルは最小責務を維持。

## 追補（Phase4-1）

- `frontend_testable_logic.js` に時刻・カレンダー系 pure helper を追加。
- `tests/frontend/frontend_logic.test.js` へ FE-TIME 系テストを追加し、
	app.js/main.js 文字列依存ではなく pure helper 直接検証を強化。

## 追補（Phase4-2）

- `displayNameWithoutExtension` / `formatDurationLabel` / `paymentPaymentRangeLabel` を
	`frontend_testable_logic.js` に追加。
- `tests/frontend/frontend_logic.test.js` に FE-PURE 系テストを追加し、
	common helper の pure 契約を直接検証。

## 追補（Phase4-3）

- `formatTimeRange` と `icsEscape` を `frontend_testable_logic.js` へ追加。
- FE-TIME / FE-PURE テストを拡張し、時刻・ICS文字列整形の pure 契約を直接検証。

## 追補（Phase4-4）

- `PORTAL_AUTH_KEY` / `PORTAL_DEVICE_ID_KEY` の参照を
	`window.portalRuntimeContext.*` へ移行。
- `runtime_context.js` での `PORTAL_*` 互換グローバル公開を削減。
- frontend syntax / Vitest で回帰なしを確認。

## 追補（Phase4-5）

- `dbCache` / `inFlightGetRequests` / `WHOLE_PRACTICE_RECORDING_PIECE` の利用を
	`window.portalRuntimeContext.*` 参照へ移行。
- `runtime_context.js` の同名互換グローバル公開を削減。

## 追補（Phase4-6）

- `today()` の呼び出しを `modules/` 一式で
	`window.portalRuntimeContext.today()` へ移行。
- `admin_system.js` の `DEFAULT_MEMBER_PARTS` 参照を
	`window.portalRuntimeContext.DEFAULT_MEMBER_PARTS` へ移行。
- `runtime_context.js` で `today` / `DEFAULT_MEMBER_PARTS` の
	互換グローバル公開を削減し、名前空間経由の利用へ寄せた。

## 追補（Phase4-7）

- `modules/absences.js` / `modules/announcements.js` / `modules/schedules.js` で、
	`appState` と `$` を `window.portalRuntimeContext` 由来のローカルエイリアスへ段階移行。
- 互換グローバル削減に向け、ファイル単位の小バッチ移行を継続する方針を明確化。

## 追補（Phase4-17）

- 練習予定の Google カレンダー連携は、予定タイトルを `略称　練習` または `略称　本番` に統一する。
- カレンダー連携用日時は `start_time` / `end_time` を優先し、秒付き時刻も `HH:mm` に正規化して Google Calendar URL / ICS に渡す。

## 追補（Phase4-18）

- 団員向けの楽曲紹介・練習指示は、閲覧モードでは登録本文内の URL をリンク化して表示する。
- 編集モードのみ textarea を表示し、保存時の入力取得 ID は従来どおり維持する。

## 追補（Phase4-19）

- 支払管理・支払設定などの金額表示は、円単位の整数表示に統一し、小数部を表示しない。
- 金額入力欄の初期値と保存値も整数に正規化し、`5000.00` のような値を画面に残さない。

## 追補（Phase4-20）

- 団員向け録音部屋の折りたたみ表示は、楽譜ライブラリと同じ `details/summary` + `sheet-library-details` の表示方式に統一する。
- 録音部屋独自の開閉ラベル表示と最新日の曲だけ別制御する `files-collapsed` は廃止し、標準の折りたたみ挙動に揃える。

## 再発防止（文字コード事故対策）

- 非 ASCII を含む JS ファイルでは、`Set-Content` による一括書き戻しを行わない。
- 置換は原則 `apply_patch` の最小差分で実施し、編集後に文字化けパターンを grep で確認する。
- バッチ置換が必要な場合は、対象を小分けにして都度 `check:frontend:syntax` を通す。

## 追補（Phase4-8）

- `modules/members.js` / `modules/payments.js` / `modules/performances.js` で、
	`appState` と `$` を `window.portalRuntimeContext` 由来のローカルエイリアスへ段階移行。
- 互換グローバル削減は、既存挙動を優先して小バッチ適用 + 毎回テストの運用を継続する。

## 追補（Phase4-9）

- `modules/portal_views.js` / `modules/upload_forms.js` / `modules/bootstrap_loader.js` で、
	`appState` と `$` を `window.portalRuntimeContext` 由来のローカルエイリアスへ段階移行。
- 互換グローバル縮小に向けた移行対象を拡大しつつ、同じ検証手順（文字化け検査 + syntax + Vitest）を維持した。

## 追補（Phase4-10）

- `modules/admin_system.js` / `modules/navigation.js` / `modules/practice_casting.js` で、
	`appState` と `$` を `window.portalRuntimeContext` 由来のローカルエイリアスへ段階移行。
- 画面制御・管理機能・配役/指示系の主要モジュールにも同方針を展開し、
	互換グローバル縮小の準備範囲を拡大した。

## 追補（Phase4-11）

- `modules/albums.js` / `modules/events.js` / `modules/sns.js` で、
	`appState` と `$` を `window.portalRuntimeContext` 由来のローカルエイリアスへ段階移行。
- 団員向け表示系（アルバム・イベント・SNS）へ同方針を適用し、
	Phase5 の互換グローバル縮小に向けた移行カバレッジを拡大した。

## 追補（Phase4-12）

- `modules/recordings.js` / `modules/scores.js` で、
	`appState` と `$` を `window.portalRuntimeContext` 由来のローカルエイリアスへ段階移行。
- Phase5 前監査として、`appState` / `$` を利用しつつエイリアス未導入の残ファイルを確認。
	現時点の主な残対象は `auth_feature.js` / `recordings_feature.js` /
	`modules/common_helpers.js` / `modules/date_piece_promotion.js` /
	`modules/performance_day.js`（加えて状態定義の `store/app_state.js` と
	公開レイヤーの `utils/runtime_context.js`）で、
	`runtime_context.js` の `globalObj.appState` / `globalObj.$` の互換公開削減は
	次バッチ以降に継続する。

## 追補（Phase4-13）

- `modules/common_helpers.js` / `modules/performance_day.js` / `auth_feature.js` で、
	`appState` と `$` を `window.portalRuntimeContext` 由来のローカルエイリアスへ段階移行。
- 残件監査を更新し、エイリアス未導入の主対象は
	`modules/date_piece_promotion.js` / `recordings_feature.js` の2ファイル
	（および基盤の `store/app_state.js` / `utils/runtime_context.js`）まで縮小した。

## 追補（Phase4-14）

- `modules/date_piece_promotion.js` / `recordings_feature.js` で、
	`appState` と `$` を `window.portalRuntimeContext` 由来のローカルエイリアスへ段階移行。
- エイリアス未導入の残件を再監査し、アプリ機能側は移行完了
	（残件は `store/app_state.js` / `utils/runtime_context.js` の基盤2ファイルのみ）。

## 追補（Phase5-1）

- `runtime_context.js` の `globalObj.appState` / `globalObj.$` 互換公開を削減し、
	`portalRuntimeContext` 名前空間経由を正式経路にした。
- `index.html` の読み込み順（`runtime_context.js` 先行）と
	エイリアス移行完了を前提に、互換グローバルへの依存を解消した。

## 追補（Phase5-2）

- 初期化順の依存を明確化し、読み込み順を
	`store/app_state.js` -> `utils/runtime_context.js` -> `main.js` に統一。
- `runtime_context.js` の `appState` は遅延参照（getter）へ変更し、
	初期化順の揺れでも `portalAppState` / `appState` を解決できるようにした。
- `tests/frontend/test_runtime_bootstrap_order.test.js` を追加し、
	`index.html` と `app.js` 互換ローダーの順序回帰を自動検証する。

## 追補（Phase4-15）

- `modules/date_piece_promotion/helpers.js` を新設し、
	日程調整の純粋/補助ヘルパー（候補日整形・集計・トークン化・候補行収集）を分離。
- `modules/date_piece_promotion.js` は描画・イベント・API 呼び出し中心の薄い層へ整理。

## 追補（Phase4-16）

- `modules/admin_system/helpers.js` を新設し、
	パート/会場/団体情報/接続設定の補助関数を分離。
- `modules/admin_system.js` は管理画面の操作ロジック中心の層へ整理。
- `index.html` と `app.js` 互換ローダーに helper 読み込み順を追加し、
	既存の外部公開関数名と画面挙動を維持したまま段階分割を実施。

## 追補（Phase5-3）

- `modules/date_piece_promotion/state.js` / `api.js` / `render.js` を追加。
- `modules/date_piece_promotion.js` は互換ローダー層へ縮小（主に日程調整本体のみ残置）。
- 読み込み順を `helpers -> state -> api -> render -> date_piece_promotion.js` に固定し、
	既存のグローバル関数公開を維持した。

## 追補（Phase5-4）

- `modules/admin_system/render.js` / `api.js` / `database_viewer.js` / `diagnostics.js` を追加。
- `modules/admin_system.js` は移行ゲート（互換ローダー）として最小化した。
- 読み込み順を `helpers -> render -> api -> database_viewer -> diagnostics -> admin_system.js` に固定し、
	既存管理画面の挙動互換を維持した。
