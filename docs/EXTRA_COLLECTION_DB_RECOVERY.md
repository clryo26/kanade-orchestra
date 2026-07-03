# Extra Collection DB Recovery

Updated: 2026-07-03

## Summary

Emergency recovery for admin extra collections in DB mode.

The portal must not let an unfinished or newly added extra collection break existing admin data loading.

## Fixed Areas

- `flyer_places` and `flyer_distributions` remain DB-backed writable collections, but are temporarily excluded from bootstrap payloads during recovery.
- Bootstrap payload building logs failed extra collections and returns an `extra_errors` array so failures are visible instead of silently looking like real empty data.
- Legacy frontend bootstrap fallback no longer requests flyer collections during initial/bootstrap recovery loading.
- `venue_settings` and `castings` remain covered by DB-mode extra save regression tests.
- Non-table extra collections use `portal_json_collections` through the generic DB load/save path instead of accidentally calling structured table replacement.
- `castings` reads structured `castings` / `casting_members` / `casting_extras` plus legacy `portal_json_collections` entries for `castings`, `seating_assignments`, and `performance_members`.
- `venue_settings` and `payments` read structured tables and also merge/fallback to legacy `portal_json_collections` entries so existing data does not appear deleted during migration.

## Operational Notes

- `castings` is the current canonical collection for ride-on/casting data.
- `GET /api/extra/seating_assignments` and `GET /api/extra/performance_members` should return the canonical casting data, including legacy JSON rows when present.
- `flyer_places` / `flyer_distributions` are admin-only extra collections and are kept out of bootstrap until existing admin features are stable again.
- A single optional extra collection failure should be logged server-side, surfaced in `extra_errors`, and isolated from existing performance, schedule, payment, venue, sheet, recording, and casting data.
