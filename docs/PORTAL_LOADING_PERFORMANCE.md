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
