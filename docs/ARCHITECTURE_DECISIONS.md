# ARCHITECTURE_DECISIONS

最終更新: 2026-07-02

この文書は設計判断を一箇所で追跡するためのADR集約ポイントです。

## ADR-001: Frontendエントリは main.js を正とする

- Status: Accepted
- Context: `src/static/js/app.js` は互換ローダーとして維持しつつ、本番処理は `main.js` と `modules/` へ分離済み。
- Decision: 新規実装は `app.js` へ追加しない。
- Consequence: 互換維持と構造改善を両立できる。
- Related: [README.md](README.md), [AGENTS.md](AGENTS.md)

## ADR-002: 共有状態の正式名は window.portalAppState

- Status: Accepted
- Context: `window.appState` 直接参照が残ると移行が停滞する。
- Decision: 新規実装は `window.getAppState()` / `window.portalRuntimeContext.appState` を優先する。
- Consequence: 将来の状態管理差し替え余地を確保。
- Related: [README.md](README.md), [src/static/js/store/app_state.js](src/static/js/store/app_state.js)

## ADR-003: DB Only運用を既定とし、local fallbackは開発限定

- Status: Accepted
- Context: 本番運用でJSON fallbackが混在すると障害切り分けが困難。
- Decision: `DATA_BACKEND=db` を標準とし、`local` は明示的開発用途のみ。
- Consequence: 本番運用の再現性が上がる。
- Related: [docs/CLOUD_RUN_GCS_DB_CHECK.md](docs/CLOUD_RUN_GCS_DB_CHECK.md)

## ADR-004: app_coreは互換専用レイヤとして維持

- Status: Accepted
- Context: 既存テスト・互換面が依存しており即時削除は高リスク。
- Decision: app_coreは互換公開面のみ維持し、新規ロジック実装先にしない。
- Consequence: 段階的薄化を継続できる。
- Related: [src/backend/app_core.py](src/backend/app_core.py), [docs/APP_CORE_EXPORT_INVENTORY.md](docs/APP_CORE_EXPORT_INVENTORY.md)

## ADR-005: QA標準入口は setup:local / qa:local

- Status: Accepted
- Context: ローカルQA手順漏れが品質低下につながる。
- Decision: 依存導入は `npm run setup:local`、自動検証は `npm run qa:local` を標準化。
- Consequence: 実行手順が統一される。
- Related: [docs/LOCAL_TEST_SETUP.md](docs/LOCAL_TEST_SETUP.md)

## ADR-006: 本番前確認は自動化 + 手動実機のハイブリッド

- Status: Accepted
- Context: iPhone/PWA/実GCSなどは完全自動化が困難。
- Decision: 自動化可能項目を `qa:local` と `check:release:readiness` へ統合し、実機依存はチェックリスト運用。
- Consequence: 品質と現実運用のバランスを維持。
- Related: [docs/PRODUCTION_RELEASE_CHECKLIST.md](docs/PRODUCTION_RELEASE_CHECKLIST.md), [docs/MANUAL_DEVICE_QA_CHECKLIST.md](docs/MANUAL_DEVICE_QA_CHECKLIST.md)

## ADR-007: Router認可は共通依存へ集約する

- Status: Accepted
- Context: 各routerで `X-Device-Id` 取得と権限判定の重複実装が増え、将来の権限仕様変更時に更新漏れリスクが高い。
- Decision: `src/backend/core/auth_dependencies.py` に認可依存を集約し、主要routerは `Depends(...)` で共通認可を適用する。
- Consequence: 権限判定の変更点が一箇所に寄り、横断的な保守性が向上する。
- Related: [src/backend/core/auth_dependencies.py](src/backend/core/auth_dependencies.py), [tests/backend/test_auth_dependencies.py](tests/backend/test_auth_dependencies.py)

## ADR-008: performanceモジュールのpure関数は共通ヘルパへ集約する

- Status: Accepted
- Context: `modules/performances.js` にpure処理が混在し、他モジュールとのロジック重複が発生していた。
- Decision: 曲ラベル・piece正規化・スコープ解決・upload option 生成などのpure処理を `modules/common_helpers/pure.js` と `testable/pieces.js` に寄せる。
- Consequence: UIイベント処理と計算ロジックの分離が進み、ユニットテスト追加が容易になる。
- Related: [src/static/js/modules/common_helpers/pure.js](src/static/js/modules/common_helpers/pure.js), [src/static/js/modules/performances.js](src/static/js/modules/performances.js), [tests/frontend/frontend_logic.test.js](tests/frontend/frontend_logic.test.js)

## ADR-009: 手動運用チェックは構成整合を自動検証する

- Status: Accepted
- Context: 実機依存項目は手動運用が必要だが、チェックリスト文書の欠落や劣化は自動で検知可能。
- Decision: `check_operational_checklists.py` を導入し、必須セクションとチェック形式をCI/qa:localで検証する。
- Consequence: 手動運用の再現性低下を早期検知できる。
- Related: [scripts/check_operational_checklists.py](scripts/check_operational_checklists.py), [docs/PRODUCTION_RELEASE_CHECKLIST.md](docs/PRODUCTION_RELEASE_CHECKLIST.md)

## ADR-010: マルチテナント準備の最低検証をCIへ組み込む

- Status: Accepted
- Context: organization_id 対応は進んでいるが、マイグレーション対象漏れやヘッダ運用の崩れを継続監視する必要がある。
- Decision: `check_tenant_migration.py` と tenant context テストを追加し、qa/CIで定期検証する。
- Consequence: tenant導入前段階の安全性を維持できる。
- Related: [scripts/check_tenant_migration.py](scripts/check_tenant_migration.py), [tests/backend/test_tenant_context.py](tests/backend/test_tenant_context.py), [db/migrations/004_multi_tenant_organization_id.sql](db/migrations/004_multi_tenant_organization_id.sql)

## ADR-011: CSS配信信頼性はE2Eで最低保証を継続検証する

- Status: Accepted
- Context: CDN/CSS配信の障害や崩れは単体テストで拾いにくい。
- Decision: `tests/e2e/ui_css_reliability.spec.js` を追加し、スタイルシート適用と主要UI導線をスモーク検証する。
- Consequence: 画面崩れの早期検知が可能になる。
- Related: [tests/e2e/ui_css_reliability.spec.js](tests/e2e/ui_css_reliability.spec.js), [playwright.config.js](playwright.config.js)

## ADR-012: 設計判断はADR一本化とPR運用チェックで維持する

- Status: Accepted
- Context: 判断理由が分散すると追跡不能になり、再議論コストが増える。
- Decision: 判断の記録先を `ARCHITECTURE_DECISIONS.md` に統一し、`DECISION_LOG_GUIDE.md` と PRテンプレートで運用を固定する。
- Consequence: 新規参加者のオンボーディングと判断トレースが容易になる。
- Related: [docs/DECISION_LOG_GUIDE.md](docs/DECISION_LOG_GUIDE.md), [.github/pull_request_template.md](.github/pull_request_template.md), [scripts/check_decision_log.py](scripts/check_decision_log.py)
