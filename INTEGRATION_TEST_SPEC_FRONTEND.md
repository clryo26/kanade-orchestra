# 奏オケポータル 結合テスト仕様書（フロントエンド担当）

版: 1.0
最終更新: 2026-06-18

## 1. 対象

- フロントの request と API連携
- 画面再描画とキャッシュ無効化
- 日程調整UIの連鎖整合

## 2. 実施責任

- 主担当: フロントエンド担当
- 協力: バックエンド担当（API応答保証）

## 3. ケース一覧（詳細）

### 3.1 request/キャッシュ連携

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-FE-REQ-001 | P0 | localStorage.device_id設定済み | 更新系request実行 | X-Device-Idが送信される |
| IT-FE-REQ-002 | P1 | 既存ETagあり | GET request実行 | If-None-Matchが送信される |
| IT-FE-REQ-003 | P1 | IndexedDBに対象キーあり | POST/PUT/DELETE request実行 | 関連キーのみ無効化 |
| IT-FE-REQ-004 | P1 | mutationRelatedCacheKeys判定対象URL準備 | 判定関数実行 | 想定キー集合が返る |
| IT-FE-REQ-005 | P2 | extra API一部失敗をモック | loadExtraData実行 | 成功分のみ反映し継続 |

### 3.2 日程調整UI連携

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-FE-DATE-001 | P0 | 候補3件、回答複数 | 詳細表示描画 | ランキング順が正しい |
| IT-FE-DATE-002 | P1 | IT-FE-DATE-001の表示状態 | 第1候補表示確認 | 最高スコア候補が表示 |
| IT-FE-DATE-003 | P1 | members + responses準備 | 未回答抽出処理実行 | 差分集合が一致 |
| IT-FE-DATE-004 | P1 | コメント有無混在 | コメントのみ表示ON | コメントありのみ表示 |
| IT-FE-DATE-005 | P1 | IT-FE-DATE-004後 | コメントのみ表示OFF | 全回答表示に戻る |
| IT-FE-DATE-006 | P1 | 候補複数 | 候補並び替え操作（上下） | DOM順序が期待通り更新 |
| IT-FE-DATE-007 | P1 | 未回答者あり | リマインド文面生成 | 名前と候補情報を含む |

### 3.3 画面連鎖（軽量）

| ID | 優先 | 事前条件 | 手順 | 期待結果 |
|---|---|---|---|---|
| IT-FE-FLOW-001 | P1 | portal-login成功モック | enterPortal→loadAll | 主要セクションが初期描画 |
| IT-FE-FLOW-002 | P2 | bootstrap-lite成功、core遅延 | 段階ロード実行 | 先行表示後に追加表示 |

## 4. 実装推奨

- tests/integration/frontend/test_request_cache_integration.test.js
- tests/integration/frontend/test_date_adjustment_integration.test.js
- tests/integration/frontend/test_portal_load_flow.test.js

## 5. 完了判定

- P0/P1ケースが自動化済み
- 仕様変更時に IT-FE-REQ / IT-FE-DATE が更新される

実装状況（2026-06-18）:

- tests/integration/frontend/test_request_cache_integration.test.js
	- IT-FE-REQ-001 + 003
	- IT-FE-REQ-002
	- IT-FE-REQ-004
	- IT-FE-REQ-005
- tests/integration/frontend/test_date_adjustment_integration.test.js
	- IT-FE-DATE-001 + 002
	- IT-FE-DATE-003
	- IT-FE-DATE-006（DOMモック）
	- IT-FE-DATE-004 + 005
	- IT-FE-DATE-007
- tests/integration/frontend/test_portal_load_flow.test.js
	- IT-FE-FLOW-001
	- IT-FE-FLOW-002
