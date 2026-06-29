# 奏オケポータル 運用テスト仕様書

版: 1.0
最終更新: 2026-06-18

## 1. 目的

本仕様書は、リリース後の安定運用に必要な運用観点テストの基準を定義する。

達成目標:

- サービス起動性・基本疎通・権限制御を継続確認する
- CI構成とカバレッジ可視化の運用経路を維持する
- 設計書/仕様書の参照整合を維持する

## 2. 適用範囲

- バックエンド運用経路（FastAPI API疎通、認可、ETag）
- CI運用経路（workflow定義、coverage summary）
- ドキュメント運用経路（設計書参照整合）

除外:

- 実ブラウザ操作による運用手順（手動運用テスト）
- 本番クラウド実環境への疎通

## 3. 優先度・合否基準

- P0: 100%合格（運用停止に直結）
- P1: 100%合格（運用劣化に直結）
- P2: 95%以上合格（補助観点）

## 4. ケース一覧

### 4.1 API運用スモーク

| ID | 優先 | 自動 | 観点 | 手順 | 期待結果 |
|---|---|---|---|---|---|
| OP-API-001 | P0 | Yes | 起動疎通 | GET /api/bootstrap-lite | 200 + ETagあり |
| OP-API-002 | P0 | Yes | 更新系保護 | ヘッダなしでPOST /api/performances | 401 |
| OP-API-003 | P0 | Yes | 管理運用 | 管理者ログイン後POST /api/performances | 200 |
| OP-API-004 | P1 | Yes | ETag再利用 | If-None-Match付きGET /api/bootstrap-lite | 304 |
| OP-API-005 | P0 | Yes | データ整合性必須ゲート | 管理者端末でGET /api/maintenance/orphans | 200 + total=0 |

### 4.2 CI運用

| ID | 優先 | 自動 | 観点 | 手順 | 期待結果 |
|---|---|---|---|---|---|
| OP-CI-001 | P0 | Yes | ジョブ構成 | ci.yml内のjobs確認 | backend/frontend/coverage-summaryが存在 |
| OP-CI-002 | P1 | Yes | 品質可視化 | coverage-summary投稿設定確認 | sticky comment actionが存在 |
| OP-CI-003 | P0 | Yes | Node未導入時の代替ゲート | ci.yml内のfrontend syntax check設定確認 | `Run frontend syntax check` と `npm run check:frontend:syntax` が存在 |

### 4.3 ドキュメント運用

| ID | 優先 | 自動 | 観点 | 手順 | 期待結果 |
|---|---|---|---|---|---|
| OP-DOC-001 | P1 | Yes | 仕様書存在 | 主要仕様書ファイル存在確認 | すべて存在 |
| OP-DOC-002 | P1 | Yes | 導線整合 | DESIGN_DOCS_NAVIGATION参照確認 | 運用テスト仕様書への導線あり |

## 5. 実行手順

- 運用テスト実行: uv run pytest -q tests/operations
- 全体確認: uv run pytest -q
- CI常時実行: .github/workflows/ci.yml の backend-tests ジョブ内「Run backend operation tests」ステップ
- デプロイ可否判定: OP-API-005（orphan整合性）が失敗したコミットはデプロイ不可

## 6. 実施記録（2026-06-18）

- 実施者: GitHub Copilot
- 実施方法: tests/operations の自動テスト実行
- 実行コマンド: uv run pytest -q tests/operations
- 実行結果: 8 passed, 5 warnings
- 判定: 合格（P0/P1対象ケースはすべて成功）
