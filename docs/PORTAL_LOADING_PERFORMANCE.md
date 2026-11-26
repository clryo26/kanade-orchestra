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

## Scope

- No database schema change.
- No authentication rule change.
- No bundler or script loading order change.
- The unauthenticated login-screen reload path remains a browser reload because
  it is outside the logged-in portal state.
