# 奏オケポータル 結合テスト仕様書（バックエンド担当）

版: 1.1
最終更新: 2026-07-07

## 1. 対象

- API連鎖の整合
- 認証・認可・競合検知
- CRUD連鎖とレスポンス整合
- システム管理の環境管理/同期API契約（権限制御・失敗契約・履歴）

## 2. 実施責任

- 主担当: バックエンド担当
- 協力: フロント担当（再現手順確認）、運用担当（データ準備）

## 3. ケース一覧（詳細）

### 3.1 認証・認可フロー

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-BE-AUTH-001 | P0 | member/password有効 | POST /api/auth/portal-login | 200 + authenticated=true |
| IT-BE-AUTH-002 | P0 | IT-BE-AUTH-001のdevice_id取得済み | GET /api/auth/devices/{id} | 200 + authenticated=true |
| IT-BE-AUTH-003 | P0 | 一般端末認証済み | POST /api/performances | 403 |
| IT-BE-AUTH-004 | P0 | 管理者端末認証済み | POST /api/performances | 200 |
| IT-BE-AUTH-005 | P0 | 一般端末認証済み | POST /api/convert | 403 |
| IT-BE-AUTH-006 | P0 | 録音担当端末認証済み | POST /api/convert | 200 |
| IT-BE-AUTH-007 | P0 | 一般端末認証済み | POST /api/sheets/upload | 403 |
| IT-BE-AUTH-008 | P0 | 楽譜担当端末認証済み | POST /api/sheets/upload | 200 |

### 3.2 基本CRUD連鎖

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-BE-CRUD-001 | P1 | 管理者端末認証済み | POST /api/performances | 200 + id採番 |
| IT-BE-CRUD-002 | P1 | IT-BE-CRUD-001でid取得済み | GET /api/performances/{id} | 200 + 作成内容一致 |
| IT-BE-CRUD-003 | P1 | IT-BE-CRUD-001でid取得済み | PUT /api/performances/{id} | 200 + updated_at更新 |
| IT-BE-CRUD-004 | P1 | IT-BE-CRUD-001でid取得済み | DELETE /api/performances/{id} | 200 |
| IT-BE-CRUD-005 | P1 | IT-BE-CRUD-004実施済み | GET /api/performances/{id} | 404 |

### 3.3 extra + 楽観ロック

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-BE-EXTRA-001 | P0 | 本人端末認証済み | POST /api/extra/date_adjustments | 200 |
| IT-BE-EXTRA-002 | P0 | IT-BE-EXTRA-001でid取得済み | PUT /api/extra/date_adjustments（本人） | 200 |
| IT-BE-EXTRA-003 | P0 | IT-BE-EXTRA-001でid取得済み | PUT /api/extra/date_adjustments（他人端末） | 403 |
| IT-BE-EXTRA-004 | P0 | 現在updated_at取得済み | PUT expected_updated_at=最新 | 200 |
| IT-BE-EXTRA-005 | P0 | 古いupdated_at保持 | PUT expected_updated_at=旧値 | 409 |
| IT-BE-EXTRA-006 | P1 | 候補重複payload準備 | POST /api/extra/date_adjustments | 400 |

### 3.4 bootstrap + ETag

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-BE-BS-001 | P1 | なし | GET /api/bootstrap-lite | 200 + 必須キーあり |
| IT-BE-BS-002 | P1 | なし | GET /api/bootstrap-core | 200 + extrasあり |
| IT-BE-BS-003 | P1 | なし | GET /api/bootstrap | 200 + filesあり |
| IT-BE-BS-004 | P1 | IT-BE-BS-001でETag取得済み | If-None-Match付きGET /api/bootstrap-lite | 304 |

### 3.5 環境管理 + 本番->テスト同期API契約

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-BE-SYNC-001 | P0 | APP_ENV=test + 通常システム管理者端末認証済み | GET /api/system/environment/status | 200 + can_manage_operations=true + sync_rules.direction=production_to_test_only |
| IT-BE-SYNC-002 | P0 | APP_ENV=test + 隠しシステム管理者端末認証済み | GET /api/system/environment/status | 403 |
| IT-BE-SYNC-003 | P0 | APP_ENV=production または APP_ENV未設定 + 通常システム管理者端末認証済み | GET /api/system/environment/status | 403 |
| IT-BE-SYNC-004 | P0 | APP_ENV=test + 通常システム管理者端末認証済み | POST /api/system/sync/prod-to-test | accepted=false + execution_status=not_configured |
| IT-BE-SYNC-005 | P0 | APP_ENV=test + 通常システム管理者端末認証済み | POST /api/system/release/promote | accepted=false + execution_status=not_configured |
| IT-BE-SYNC-006 | P1 | IT-BE-SYNC-004実行後 | GET /api/system/sync/history | total>=1 + 最新履歴にoperation_type=prod_to_test_sync |
| IT-BE-SYNC-007 | P1 | IT-BE-SYNC-004実行後 | GET /api/system/environment/status | db_sync_excludedにauth_devices/access_logs/audit_logs/production_operation_historiesを含む |

## 4. 実装推奨

- tests/integration/backend/test_auth_flow.py
- tests/integration/backend/test_crud_flow.py
- tests/integration/backend/test_extra_lock_flow.py
- tests/integration/backend/test_bootstrap_cache_flow.py
- tests/backend/test_system_production_ops.py

## 5. 完了判定

- P0ケースが全て自動化済み
- P1ケースが全て自動化済み
- CIで pull_request ごとに実行・結果確認可能

実装状況（2026-06-18）:

- tests/integration/backend/test_integration_flows.py に以下を実装済み
	- test_auth_to_admin_crud_chain
	- test_general_login_then_admin_api_forbidden_chain
	- test_date_adjustment_owner_and_lock_chain
	- test_bootstrap_lite_etag_chain
