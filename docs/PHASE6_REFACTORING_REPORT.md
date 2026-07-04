# PHASE6_REFACTORING_REPORT

最終更新: 2026-07-01

## 実施概要

既存 API / レスポンス / DB スキーマ / UI 挙動 / ZIP 互換を維持したまま、
navigation / members / practice_casting の追加分割と
frontend_testable_logic の helper 分離を実施した。

## 今回分割したファイル

### navigation

- src/static/js/modules/navigation/helpers.js
- src/static/js/modules/navigation/tabs.js
- src/static/js/modules/navigation/menu.js
- src/static/js/modules/navigation/routes.js
- src/static/js/modules/navigation/events.js
- src/static/js/modules/navigation.js（互換ローダー化）

### members

- src/static/js/modules/members/helpers.js
- src/static/js/modules/members/form.js
- src/static/js/modules/members/api.js
- src/static/js/modules/members/render.js
- src/static/js/modules/members/events.js
- src/static/js/modules/members.js（互換ローダー化）

### practice_casting

- src/static/js/modules/practice_casting/helpers.js
- src/static/js/modules/practice_casting/api.js
- src/static/js/modules/practice_casting/render.js
- src/static/js/modules/practice_casting/events.js
- src/static/js/modules/practice_casting.js（互換ローダー化）

### frontend_testable_logic

- src/static/js/testable/dates.js
- src/static/js/testable/pieces.js
- src/static/js/testable/formatting.js
- src/static/js/testable/validation.js
- src/static/js/frontend_testable_logic.js（互換集約レイヤー化）

## app_core.py の状況

- 追加薄化後の行数: 503
- 400行以下は未達
- 未対応理由:
  - ここから先は recording/json/bootstrap 互換ラッパーの更なる外出しが必要
  - monkeypatch 互換、公開面互換、import boundary テストを壊さない保証コストが高い

## 互換維持方針

- 既存外部公開関数名は維持
- index.html と app.js 互換ローダーの読み込み順を同期更新
- window.appState は互換 alias として維持
- 新規参照は portalRuntimeContext / testable helper 集約へ寄せた

## フルテスト結果

- uv sync: 成功
- npm install: 成功
- uv sync --extra dev: 成功
- pytest: 100 passed
- npm run test:frontend: 18 files / 64 tests passed
- npm run check:frontend:syntax: 成功
- python -m compileall -q src/backend tests: 成功
- python scripts/create-source-zip.py: 成功
- npm run zip:source: 成功

## 残った巨大ファイル

- src/backend/app_core.py
- src/static/js/modules/performance_day.js
- src/static/js/modules/scores.js
- src/static/js/modules/date_piece_promotion/render.js
- src/static/js/modules/common_helpers.js

## 次回以降の改善候補

1. app_core の recording/json/bootstrap 互換ラッパーを安全に段階分離
2. performance_day.js / scores.js の追加分割
3. date_piece_promotion/render.js の再分割
4. common_helpers.js の pure helper 整理

## Phase7 追補（2026-07-01）

- 分割最適化より品質保証を優先し、Playwright E2E 基盤と CI 運用を追加した
- 詳細は `docs/PHASE7_QA_AND_RELEASE_REPORT.md` を参照
