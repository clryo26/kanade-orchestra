# STATE_ACCESS_MIGRATION_PLAN

最終更新: 2026-07-02

## 目的

Issue 9 に基づき、グローバル状態参照の書き方を統一して保守性を高める。

## 参照ルール

- 禁止: `window.appState` の直接参照
- 禁止: `window.portalAppState` の直接参照
- 推奨: `window.getAppState()`
- 許容: `window.portalRuntimeContext.appState`

## 適用範囲

- 対象: `src/static/js/**/*.js`
- 除外: `src/static/js/store/app_state.js`, `src/static/js/utils/runtime_context.js`

除外理由:

- `app_state.js` は互換 alias を提供する土台実装であるため
- `runtime_context.js` は移行期の互換参照解決を担うため

## 現状可視化

- `window.appState` 直接参照: 0件
- `window.portalAppState` 直接参照: 0件

計測方法:

- `npm run check:frontend:state-access`

## 段階適用方針

1. 新規/修正コードは必ず参照ルールに従う。
2. 例外が必要な場合は設計判断ログへ理由を記録する。
3. 既存互換層の削減タイミングで除外ファイルを段階的に縮小する。

## 完了条件

- CI と `qa:local` の両方で state-access チェックが常時実行される。
- ルール違反が混入したPRは自動で失敗する。
