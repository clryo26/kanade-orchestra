# PHASE5_REFACTORING_REPORT

最終更新: 2026-07-01

## 実施概要

既存API/レスポンス/DBスキーマ/UI挙動を維持したまま、
フロントエンド分割と app_core 薄化を追加実施した。

## 今回分割したファイル

### date_piece_promotion

- src/static/js/modules/date_piece_promotion/state.js（新規）
- src/static/js/modules/date_piece_promotion/api.js（新規）
- src/static/js/modules/date_piece_promotion/render.js（新規）
- src/static/js/modules/date_piece_promotion.js（互換ローダー化）

### admin_system

- src/static/js/modules/admin_system/render.js（新規）
- src/static/js/modules/admin_system/api.js（新規）
- src/static/js/modules/admin_system/database_viewer.js（新規）
- src/static/js/modules/admin_system/diagnostics.js（新規）
- src/static/js/modules/admin_system.js（互換ローダー化）

## app_core.py の状況

- 追加薄化後の行数: 513
- 500行以下は未達（安全優先で見送り）
- 未対応理由:
  - `load_json_data` / `save_json_data` / startup 系は依存注入前提の互換ゲートであり、
    一括分離は monkeypatch 互換と import 境界テストへの影響が大きい

## appState移行方針

- 正式名: window.portalAppState
- 互換 alias: window.appState（維持）
- 新規実装は getAppState() / portalRuntimeContext.appState を優先

## テストセットアップ

- docs/LOCAL_TEST_SETUP.md を追加
- 会社PC/個人PC共通で `uv sync`, `npm install`, `pytest`, `npm run test:frontend` を明文化

## 互換維持方針

- 既存外部公開関数名は維持
- index.html と app.js 互換ローダーの読み込み順を同期更新
- UIイベント登録順を保持

## 残課題

- app_core の依存注入互換層分離（500行以下化）
- date_piece_promotion の date-adjustment 本体の更なる分離（events/validation/state）
- admin_system の maintenance/cache_admin 相当責務の独立分離

## Phase6 への引継ぎ結果

- app_core は 503 行まで薄化し、`core/app_lifecycle.py` へ一部互換委譲を追加分離した。
- `navigation.js`, `members.js`, `practice_casting.js` は追加分割済み。
- `frontend_testable_logic.js` は `src/static/js/testable/` 配下へ pure helper 分割済み。
- 詳細は `docs/PHASE6_REFACTORING_REPORT.md` を参照。
