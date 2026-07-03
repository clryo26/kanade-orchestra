# 奏オケポータル 結合テスト仕様書（CI・運用担当）

版: 1.0
最終更新: 2026-06-18

## 1. 対象

- 結合テストのCI実行保証
- 失敗時の分類と再実行手順
- カバレッジ集約コメント運用

## 2. 実施責任

- 主担当: CI/運用担当
- 協力: バックエンド担当、フロント担当

## 3. ケース一覧（詳細）

### 3.1 CI実行保証

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-CI-001 | P0 | pull_request作成済み | CI起動確認 | backend-tests, frontend-tests, coverage-summary が実行される |
| IT-CI-002 | P0 | backendテスト成功条件 | backend-testsジョブ確認 | pytest終了コード0 |
| IT-CI-003 | P0 | frontendテスト成功条件 | frontend-testsジョブ確認 | vitest終了コード0 |
| IT-CI-004 | P1 | coverage artifact設定済み | artifact出力確認 | backend/frontend coverage artifact生成 |
| IT-CI-005 | P1 | PRイベント | coverage-summaryコメント確認 | 既存コメントが更新される |

### 3.2 障害切り分け

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-CI-TRIAGE-001 | P1 | backend-tests失敗ログ | 失敗分類（認可/整合/依存） | 分類結果をPRコメントへ記録 |
| IT-CI-TRIAGE-002 | P1 | frontend-tests失敗ログ | 失敗分類（通信/描画/キャッシュ） | 分類結果をPRコメントへ記録 |
| IT-CI-TRIAGE-003 | P2 | coverage-summary失敗ログ | 権限/artifact不足を判定 | 再実行手順を明示 |

## 4. 運用ルール

- pull_requestでの必須チェックに CI workflow を設定する
- re-run前に失敗分類を残す
- coverage summary の差分増減はレビュー観点として記録する

## 5. 実装参照

- .github/workflows/ci.yml
- UNIT_TEST_SPEC.md
- INTEGRATION_TEST_SPEC.md
