# Login Device Cache Fix Report

## Summary

Fixed a login flow bug where `/api/auth/portal-login` wrote `auth_devices`
directly to the DB replacement layer and bypassed the compatibility cache update.

If `auth_devices` had already been read as an empty collection during startup or
bootstrap, a successful login could be followed by `/api/auth/devices/{device_id}`
reading stale cached data and treating the device as unauthenticated.

## Changed Behavior

- Auth device writes now use the same `save_json_data` compatibility path as
  other collection writes.
- The compatibility path refreshes the in-memory collection cache immediately.
- Hidden `Administrator` login is covered by a DB-mode regression test.

## Regression Coverage

- Member login after a cached empty `auth_devices` read.
- Hidden `Administrator` login after a cached empty `auth_devices` read.

## Recurrence Prevention

- Login code must not bypass the shared collection save path for `auth_devices`.
- Any future auth-device write path should verify that immediate device lookup
  succeeds after login.
