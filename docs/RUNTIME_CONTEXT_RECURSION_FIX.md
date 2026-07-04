# Runtime Context Recursion Fix

Updated: 2026-07-02

## Summary

`runtime_context.js` must not read accessor-based `window.appState` as a fallback while resolving `portalRuntimeContext.appState`.

Mixed cached scripts can create a legacy `window.appState` getter that returns `window.portalRuntimeContext.appState`. If `portalRuntimeContext.appState` then reads that getter again, Chrome raises `Maximum call stack size exceeded`.

## Rule

- Prefer `window.getAppState()` after `app_state.js` has initialized it.
- Fallback resolution may read own data properties only.
- Do not call the `window.appState` getter from inside `portalRuntimeContext.appState`.

## Regression Test

`tests/frontend/test_runtime_bootstrap_order.test.js` includes a regression case where a legacy `window.appState` getter points back to `portalRuntimeContext.appState`. The expected behavior is that state resolution returns `undefined` instead of recursing.
