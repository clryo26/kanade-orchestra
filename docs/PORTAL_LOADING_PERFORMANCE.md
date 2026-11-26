# Portal Loading Performance

## Purpose

This note records the loading path changes for the mobile portal startup and
the portal refresh button. The goal is to avoid a full page reload when the
user is already logged in and to reuse the existing frontend GET cache for
bootstrap payloads.

## Loading Path

- Logged-in startup enters the portal and renders placeholders before the
  essential data load finishes.
- Essential data is loaded from `/api/bootstrap-lite`.
- Background data is loaded from `/api/bootstrap-core`.
- Full bootstrap data remains available through `/api/bootstrap` for legacy
  fallback paths.
- Bootstrap routes evaluate ETag before payload assembly and return `304` early
  when the requested revision is unchanged.

## Change

- Successful bootstrap-lite reloads (refresh, resume synchronization, or concert
  fee saves) reset all deferred loaded flags and advance their generation without
  clearing displayed data.
- Only the visible screen (`appState.currentPortalTab`) reloads immediately with
  `_forceRevalidate`; resume synchronization also preserves `_requestOrigin:
  'automatic'`. Other screens load when next opened. Startup/login do not start
  these deferred reloads.
- While the full payment list from `/api/extra/payments` is held for the same
  authentication identity, member-only bootstrap-lite payments cannot overwrite
  it. The full list is reloaded immediately, with ownership tracked separately
  from loaded flags so failures and overlapping refreshes preserve the list.
  If `/api/extra/payments` fails with 403, ownership is released and
  `appState.payments` is filtered to the current member's records (matching
  `member_id`, or matching `name` when the current member ID is absent).
  Other failures (network errors, timeouts, 503 retry waits, and 5xx responses)
  preserve the full list and its ownership.
- 403 で本人分に絞ったときは payments を「読込済みでない」状態に戻します。
  管理者に戻ったあと、次に支払管理・支払設定を開くと全員分を取得します。
- ログアウト・セッション解除では、前の利用者の payments、connectionSettings、
  authDevices を新しい空配列に置き換え、全件保持、遅延読込フラグ、起動の読込済み
  フラグと取得時刻をリセットします。団員ホームの公演・予定・お知らせ・支払い表示を
  空にし、ホームとドロワーのメニューを描き直して滞納警告を消します。
  partSettings、orgSettings、snsSettings、cloudRunRevision と全員共通のコレクションは残します。
- 別タブでログアウトされた場合も本人情報と上記データを消してログイン画面を出します。
  別タブでログインした場合や端末IDが変わった場合は、上記データを消してページを
  読み直します。ログイン画面のタブでは認証の遷移番号だけを進めます。
  セッション確認で別の団員と分かった場合は、遷移番号を進め、本人情報を反映し、
  上記データを消してページを読み直します。
- 「別の団員」は、前と次の両方に団員IDがあればIDだけで比べ、どちらかにIDが
  なければ名前を完全一致で比べます。サーバーの `personal_payment_list` と同じ基準で、
  同じ団員IDなら名前の表記が変わっただけでは読み直しやデータの消去は起きません。
- `loadEssentialData` と `enterPortal` は開始時の認証遷移番号を覚え、await 後に
  変わっていたら古い処理から状態・フラグ・表示を反映しません。最新データの反映に
  失敗して保存済みプレビューに戻す場合も、キャッシュ削除を待つ間に認証が変わって
  いたら、前の利用者のプレビューを戻さず、失敗の文言や警告も出しません。
  同じ本人・同じ遷移でのプレビュー表示と失敗時の復元は従来どおりです。
- IndexedDB の鍵は端末ID・団員ID・権限・認証世代により本人ごとに分かれます。
  鍵の形式と cleanup 条件は変更しません。ログアウト時は本人情報を消す前に
  `/api/bootstrap-lite` のプレビュー1件だけを非同期で削除します。再ログインでは
  認証世代が変わるため、通常の起動の速さへの影響はほとんどありません。
- サーバーは `/api/extra/payments` と `/api/extra/connection_settings` の読み取りで、
  未認証なら 401、管理者（管理者・システム管理者）でなければ 403 を返します。
  200 の応答には `Cache-Control: no-store` を付けます。
- `/api/bootstrap` は、管理者以外には本人分の payments、空の connection_settings、
  空の auth_devices を返します（未認証の payments も空です）。bootstrap-lite の ETag は、
  read context がないときも端末と本人ごとに分かれます。
- Extra loads started before a reload are discarded and may retry once in the
  new generation. Earlier `loadEvents` / `loadAuthManagement` responses do not
  mark a new generation loaded or overwrite responses from newer calls.
- Bootstrap-core continues to return empty `extras`; startup does not load it
  automatically.
- Bootstrap requests now go through the shared `request()` helper when it is
  available.
- The shared request helper provides IndexedDB cache restoration, in-flight GET
  deduplication, ETag revalidation, and offline fallback for cached GET data.
- Server-side ETag generation now prefers cached or lightweight collection
  signatures and avoids full payload construction on `If-None-Match` hit
  paths.
- Bootstrap payload application preserves existing state for collections that
  are not included in a lighter response. This prevents `/api/bootstrap-lite`
  from clearing admin data such as `venue_settings` and `castings` while
  `/api/bootstrap-core` is still loading.
- The logged-in portal refresh button no longer calls `window.location.reload()`.
  It refreshes `/api/bootstrap-lite` in place and then revalidates the broader
  background payload.

## 練習予定・SNS の遅延読込

- `/api/bootstrap-lite` は `schedules` と `extras.sns_settings` を返さず、サーバーでもこの2集合を読み込まない。performances、announcements、members、本人分の payments、part_settings、org_settings は残す。
- `member-schedule`、`member-absence`、`schedule` は未読込の予定を `/api/schedules` から取得する。`member-sns`、`system-sns` は未読込の SNS 情報を `/api/extra/sns_settings` から取得する。成功したときだけ読込済みにし、失敗時は既存の表示データを残す。
- 練習予定と出欠一覧は、予定が未読込かつ手元にもない間は「読み込み中です...」を表示する。管理画面の期間切替ボタンは維持する。
- 起動後の出欠督促は、初期表示の後に `/api/schedules` と出欠を取得し、両方が読込済みで開始時と同じ世代の場合だけ判定する。取得失敗や途中の世代変更では督促しない。取得関数が失敗を受け止めて正常終了しても、成功とはみなさない。
- SNS 保存時は先に入力値を保持し、未読込なら取得して既存の id を確認してから PUT/POST する。読込失敗、再試行待機、世代変更では保存しない。取得によるフォーム再描画後は保持した入力値を戻してから送信する。
- ログイン画面は part と org のみ取得し、SNS は取得しない。
- 再取得では既存のフラグリセット・世代更新により、表示中の対象画面だけ `_forceRevalidate` で読み直す。起動・ログイン時のリセット自体は遅延読込を始めない。利用者切替でも予定と SNS の共通データは残し、フラグを戻す。
- `LITE_COLLECTIONS` から schedules は外すが、一覧 API の依存には残す。sns_settings は本文に含めなくても依存に残し、CLOCK_COLLECTIONS、table_dependencies()、migration 023 の生成結果と適用済みトリガーを一致させる。これにより生成物の `--check` を維持する。SNS 更新時に版クロックの lite が 200 を返す場合は増えるが、正しさは保たれる。read context がない経路の ETag は予定・SNS を除く6集合で作る。

## 起動時間の見込み（未計測の見積もり）

合成データのサーバー計測 `docs/perf_stage3a/BASELINE_POSTGRES16.json` に基づく。本番の予定件数、回線、iPhone 実機では測っていない。

- 標準量（予定200件）の lite 本文は 142,234B → 約58,700B（142,234 − 83,513 = 58,721B、約83KB・約59%減）。予定一覧と lite 内の予定がほぼ同じ形という前提。
- 2倍量では 283,964B → 約116,700B（283,964 − 167,313 = 116,651B、約59%減）。SNS は1行程度を想定し、サイズの効果はほぼない。GZip 後の実際の通信量差は数十KB未満の見込みだが圧縮率は未計測。
- read context がない経路の 304 は ETag の対象が8集合から6集合になり、SQL は約13→12、接続の貸出は約11→10の見込み。版クロック方式の SQL 数は変わらない。
- 初回取得の中央値72.8msから予定の取得・変換が抜けるが、その内訳は未計測。単独の `/api/schedules` の15.8msを上限の目安とし、正確な短縮幅は未算定。
- 端末では JSON 解析と IndexedDB 保存が軽くなるという仮説であり、時間は未算定。`renderEssentialViews()` は変えず、予定の描画が軽くなるのは手元に予定がない初回や新形式のプレビューだけを保存した後に限る。旧プレビューに予定がある場合や、同一セッションで予定を取得済みの場合は従来どおり描画する。プレビューあり・なしを分けて `ESSENTIAL_RENDER_END` を比較する。
- 初期表示後の督促用に `/api/schedules` の取得が1回増える（サーバーで約16ms、表示は待たせない）。ログイン画面の SNS 取得は1回減る。本番の予定件数が少なければ本文サイズの効果も小さく、30件なら約1/7が目安。

## Scope

- No database schema change.
- No authentication rule change.
- No bundler or script loading order change.
- The unauthenticated login-screen reload path remains a browser reload because
  it is outside the logged-in portal state.
