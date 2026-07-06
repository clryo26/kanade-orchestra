# Auth Device Session Stability

Updated: 2026-07-06

## Summary

Authenticated portal devices must not depend on per-process collection cache.

`auth_devices` is session-critical data. In DB mode, authentication checks and
auth device management read the DB directly so Cloud Run instance switching does
not treat a valid logged-in device as unauthenticated because of stale memory
cache.

## Rules

- `auth_devices` must be read directly from DB in DB mode for device
  authentication.
- Login, last-seen refresh, and device deletion must update a single device
  record where possible.
- Local JSON mode may continue using collection save behavior.
- Explicit logout remains a frontend state change and does not grant access
  without a valid server-side auth device.

## Reason

The portal can run on multiple Cloud Run instances. If one instance has stale
`auth_devices` cache, a valid device can receive `401 Device is not
authenticated` after PWA resume or page reload. Auth device checks therefore
avoid the cached collection path in DB mode.
