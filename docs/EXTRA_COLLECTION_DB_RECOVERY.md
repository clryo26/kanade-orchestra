# Extra Collection DB Recovery

Updated: 2026-07-03

## Summary

Emergency recovery for admin extra collections in DB mode.

The portal must not let an unfinished or newly added extra collection break existing admin data loading.

## Fixed Areas

- `flyer_places` and `flyer_distributions` are registered as DB-backed writable collections.
- Bootstrap payload building now returns an empty list for a failed extra collection instead of failing the whole bootstrap response.
- Legacy frontend bootstrap fallback keeps `flyer_places`, `flyer_distributions`, and `castings` in the correct response slots.
- `venue_settings` and `castings` remain covered by DB-mode extra save regression tests.

## Operational Notes

- `castings` is the current canonical collection for ride-on/casting data.
- `flyer_places` / `flyer_distributions` are admin-only extra collections.
- A single optional extra collection failure should be logged server-side and isolated from existing performance, schedule, payment, venue, sheet, recording, and casting data.
