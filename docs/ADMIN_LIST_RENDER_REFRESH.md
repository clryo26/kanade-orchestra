# Admin List Render Refresh

Updated: 2026-07-02

## Summary

Admin list tabs must render registered records after both initial lightweight loading and background core loading.

## Covered Tabs

- Practice schedule admin tab
- Event adjustment admin tab
- Member registration admin tab

## Rules

- `applyBootstrapData()` must preserve existing state when a staged bootstrap response omits a collection.
- `renderBackgroundViews()` must refresh admin list views after `/api/bootstrap-core` updates state.
- Showing the admin `schedule`, `event`, or `member` tab must rerender the corresponding registered list.

## Regression Tests

`tests/integration/frontend/test_portal_load_flow.test.js` verifies the background refresh and admin tab render targets.
