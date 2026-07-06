# Performance Save Stability

Updated: 2026-07-03

## Summary

Performance create/update endpoints must accept admin form payloads that contain blank optional fields.

Covered endpoints:

- `POST /api/performances`
- `PUT /api/performances/{performance_id}`
- `GET /api/performances`

## Normalization Rules

- `date`, `open_time`, and `start_time` may be blank and are stored as database `NULL` for typed columns.
- API responses normalize blank `date`, `open_time`, and `start_time` back to empty strings for frontend compatibility.
- `performance_fee_amount` accepts number, numeric string, blank string, or `null`; blank and invalid values are saved as `0`.
- The main performance form preserves the existing `performance_fee_amount` because the fee is edited from the payment settings screen.
- `pieces` accepts both string items and object items.
- Empty piece titles are ignored.
- `created_at` is immutable after creation. Update payloads may include `created_at: null`, but the server keeps the existing value and never writes `created_at = null` to the DB.
- `updated_at` is refreshed on update.

## DB Child Table Rule

`performance_pieces` rows are fully rebuilt when the performances collection is saved.

Incoming piece IDs are not reused for newly inserted child rows. The DB layer assigns fresh IDs to avoid primary-key collisions, especially after organization-scoped deletes.

`created_at` is excluded from DB upsert update assignments. New rows receive a non-null timestamp before insert, while existing rows keep the DB value on conflict.

## Regression Coverage

Backend tests cover:

- performance creation with blank date/time/fee fields
- performance update with blank date/time/fee fields
- mixed string/object `pieces`
- piece add/remove/reorder payloads
- `GET /api/performances` after save
- DB tuple conversion for blank numeric/date/time values
- `performance_pieces` child rows ignoring incoming IDs
- update payloads containing `created_at: null`
- DB upsert preparation for non-null `created_at` / `updated_at`
