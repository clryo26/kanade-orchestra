# 奏オケポータル 単体テスト仕様書

版: 1.0
最終更新: 2026-06-18

## 1. 目的

本仕様書は、奏オケポータルのプログラム全体に対して単体テストを実施するための基準を定義する。

達成目標:

- 主要機能のロジックを関数・APIハンドラ単位で検証する
- 認証・認可・競合検知の回帰を防止する
- 変更時に壊れやすい箇所を優先的に自動化する

## 2. 適用範囲

### 2.1 対象モジュール

- バックエンド
  - src/backend/main.py
  - src/backend/drive_storage.py
- フロントエンド
  - src/static/js/app.js

### 2.2 対象仕様

- DESIGN.md
- DESIGN_WEB.md
- SYSTEM_DESIGN.md
- API_DATABASE_SPEC.md

### 2.3 除外

- E2E（ブラウザ全体動作）
- 負荷試験
- セキュリティ診断（脆弱性スキャン）

## 3. テスト方針

### 3.1 テストレベル

- レベルA: 純粋関数単体（入出力検証）
- レベルB: APIハンドラ単体（FastAPI TestClient + モック）
- レベルC: フロント関数単体（DOM依存を分離して検証）

### 3.2 優先度

- P0: 認証・認可・競合検知・データ破損防止
- P1: 基本CRUD・ファイル入出力分岐
- P2: 表示補助ロジック・フォーマット

### 3.3 合否基準

- P0: 100%合格
- P1: 100%合格
- P2: 95%以上合格
- 重大障害（データ破壊・権限逸脱）は1件でも不合格

## 4. 実行環境

### 4.1 共通

- OS: Windows 11
- Python: 3.10+
- パッケージ管理: uv

### 4.2 推奨コマンド

- 全体: uv run pytest
- 詳細: uv run pytest -q -ra
- バックエンドカバレッジ: uv run pytest -q --cov=src/backend --cov-report=term-missing --cov-report=xml:coverage/backend/coverage.xml
- フロントカバレッジ: npm run test:frontend:coverage

### 4.3 テストデータ方針

- src/data の実データは直接上書きしない
- テスト時は一時ディレクトリへ差し替える
- テスト終了時に必ずクリーンアップする

## 5. モック/スタブ方針

- Google Cloud Storage 呼び出しはモック化
- 音声変換（pydub/ffmpeg）は関数境界をモック化
- 時刻依存は固定時刻を注入
- ファイルI/Oは tmp_path を利用

## 6. バックエンド単体テスト仕様

## 6.1 共通ユーティリティ（main.py）

| ID | 優先 | 対象 | 観点 | 入力 | 期待結果 |
|---|---|---|---|---|---|
| BE-UTIL-001 | P1 | next_id | 採番 | [] | 1 |
| BE-UTIL-002 | P1 | next_id | 欠番あり採番 | [{id:1},{id:3}] | 4 |
| BE-UTIL-003 | P1 | find_item | 正常検索 | 既存ID | index,item返却 |
| BE-UTIL-004 | P0 | find_item | 未存在 | 不正ID | 404例外 |
| BE-UTIL-005 | P1 | safe_segment | 禁止文字除去 | '..\\a/b' | 安全な文字列 |
| BE-UTIL-006 | P1 | safe_upload_name | ファイル名正規化 | 危険文字含む名 | 安全名 |
| BE-UTIL-007 | P1 | format_duration | 秒→表示 | 65 | 1:05 |
| BE-UTIL-008 | P1 | parse_range_header | 範囲正常 | bytes=0-99 | (0,99) |
| BE-UTIL-009 | P1 | parse_range_header | 範囲不正 | bytes=abc | None |
| BE-UTIL-010 | P1 | normalize_bool_text | 真偽正規化 | true/false/yes/no | true/false/空 |

## 6.2 認証・認可（main.py）

| ID | 優先 | 対象 | 観点 | 前提/入力 | 期待結果 |
|---|---|---|---|---|---|
| BE-AUTH-001 | P0 | POST /api/auth/portal-login | 正常ログイン | 正しい名前/パート/パスワード | authenticated=true |
| BE-AUTH-002 | P0 | POST /api/auth/portal-login | パスワード不一致 | 誤パスワード | 401 |
| BE-AUTH-003 | P0 | POST /api/auth/portal-login | 初回パスワード未設定 | member.password空 | needs_password_setup=true |
| BE-AUTH-004 | P0 | GET /api/auth/devices/{id} | 認証照会 | 登録済みdevice | authenticated=true |
| BE-AUTH-005 | P0 | DELETE /api/auth/devices/{id} | 管理者制御 | 一般端末ヘッダ | 403 |
| BE-AUTH-006 | P0 | require_admin_device | 管理者判定 | permission=管理者 | 例外なし |
| BE-AUTH-007 | P0 | require_admin_device | 非管理者拒否 | permission=一般 | 403 |
| BE-AUTH-008 | P0 | require_recording_manager_device | 補助権限許可 | is_recording_manager=true | 例外なし |
| BE-AUTH-009 | P0 | require_sheet_manager_device | 補助権限許可 | is_sheet_manager=true | 例外なし |
| BE-AUTH-010 | P0 | device_auth_record | ヘッダ必須 | X-Device-Id空 | 401 |

## 6.3 起動・接続設定移行

| ID | 優先 | 対象 | 観点 | 前提/入力 | 期待結果 |
|---|---|---|---|---|---|
| BE-MIG-001 | P1 | has_connection_setting | 設定有無判定 | 空配列 | false |
| BE-MIG-002 | P1 | has_connection_setting | 設定有無判定 | 有効項目あり | true |
| BE-MIG-003 | P1 | legacy_connection_setting_from_env | envフォールバック | env設定あり | 設定辞書生成 |
| BE-MIG-004 | P1 | seed_connection_settings_from_legacy_env | 自動シード | connection_settings空 + envあり | 1件追加 |
| BE-MIG-005 | P1 | seed_connection_settings_from_legacy_env | 多重登録防止 | 既存設定あり | 追加なし |

## 6.4 bootstrap/ETag

| ID | 優先 | 対象 | 観点 | 入力 | 期待結果 |
|---|---|---|---|---|---|
| BE-BS-001 | P1 | GET /api/bootstrap-lite | 正常取得 | 初回GET | 200 + 必須キー |
| BE-BS-002 | P1 | GET /api/bootstrap-core | 正常取得 | 初回GET | 200 + extras含む |
| BE-BS-003 | P1 | GET /api/bootstrap | 正常取得 | 初回GET | 200 + files含む |
| BE-BS-004 | P1 | check_etag | 304判定 | If-None-Match一致 | 304 |
| BE-BS-005 | P1 | check_etag | 不一致 | If-None-Match不一致 | None（通常処理継続） |

## 6.5 基本CRUD

### performances/schedules/members/events/announcements

| ID | 優先 | 対象 | 観点 | 前提/入力 | 期待結果 |
|---|---|---|---|---|---|
| BE-CRUD-001 | P0 | POST 基本CRUD | 認可 | X-Device-Idなし | 401 |
| BE-CRUD-002 | P0 | POST 基本CRUD | 認可 | 一般権限 | 403 |
| BE-CRUD-003 | P0 | POST 基本CRUD | 認可 | 管理者権限 | 200 |
| BE-CRUD-004 | P1 | PUT 基本CRUD | 更新保存 | 既存ID | updated_at更新 |
| BE-CRUD-005 | P1 | DELETE 基本CRUD | 削除 | 既存ID | 200 + 実データ削除 |
| BE-CRUD-006 | P1 | GET 単体 | 未存在 | 不正ID | 404 |

## 6.6 録音API

| ID | 優先 | 対象 | 観点 | 前提/入力 | 期待結果 |
|---|---|---|---|---|---|
| BE-REC-001 | P0 | POST /api/convert | 認可 | 一般権限 | 403 |
| BE-REC-002 | P0 | POST /api/convert | 認可 | 録音担当 | 200 |
| BE-REC-003 | P1 | ensure_audio_file | 拡張子検証 | 非対応形式 | 400 |
| BE-REC-004 | P1 | GET /api/recordings | 一覧統合 | ローカル+クラウド | files返却 |
| BE-REC-005 | P1 | DELETE /api/recordings | source=local | path未存在 | 404 |
| BE-REC-006 | P1 | DELETE /api/recordings | source=cloud | object_name空 | 400 |
| BE-REC-007 | P1 | parse_range_header | suffix指定 | bytes=-100 | 妥当範囲返却 |
| BE-REC-008 | P1 | stream_storage_blob | Range再生 | rangeヘッダあり | 206 + Content-Range |

## 6.7 楽譜API

| ID | 優先 | 対象 | 観点 | 前提/入力 | 期待結果 |
|---|---|---|---|---|---|
| BE-SHEET-001 | P0 | POST /api/sheets/upload | 認可 | 一般権限 | 403 |
| BE-SHEET-002 | P0 | POST /api/sheets/upload | 認可 | 楽譜担当 | 200 |
| BE-SHEET-003 | P1 | ensure_pdf_file | MIME/拡張子検証 | PDF以外 | 400 |
| BE-SHEET-004 | P1 | PUT /api/sheets/{id}/part | 単体更新 | 既存ID+part | 200 |
| BE-SHEET-005 | P1 | PUT /api/sheets/parts | 一括更新 | sheet_ids空 | 400 |
| BE-SHEET-006 | P1 | DELETE /api/sheets | 条件削除 | performance_id未指定 | 400 |
| BE-SHEET-007 | P1 | GET /api/sheets/download-zip | ZIP生成 | 条件一致あり | 200 + zip |

## 6.8 extraコレクション

| ID | 優先 | 対象 | 観点 | 前提/入力 | 期待結果 |
|---|---|---|---|---|---|
| BE-EXTRA-001 | P0 | GET /api/extra/{name} | name制限 | 不正name | 404 |
| BE-EXTRA-002 | P0 | POST /api/extra/{name} | ヘッダ必須 | X-Device-Idなし | 401 |
| BE-EXTRA-003 | P0 | 運用設定系extra更新 | 管理者限定 | 一般端末 | 403 |
| BE-EXTRA-004 | P0 | date_adjustments更新 | 所有者制御 | 他人データ更新 | 403 |
| BE-EXTRA-005 | P0 | date_adjustment_responses更新 | 所有者制御 | 他人データ更新 | 403 |
| BE-EXTRA-006 | P0 | PUT /api/extra/* | 楽観ロック | expected_updated_at不一致 | 409 |
| BE-EXTRA-007 | P1 | validate_date_adjustment_payload | 必須検証 | title空 | 400 |
| BE-EXTRA-008 | P1 | validate_date_adjustment_payload | 候補重複 | 同日同時刻候補重複 | 400 |
| BE-EXTRA-009 | P1 | validate_date_adjustment_response_payload | status検証 | ok/maybe/ng以外 | 400 |
| BE-EXTRA-010 | P1 | parse_extra_upsert_request | 2形式対応 | payload形式/従来形式 | 正規化成功 |

## 6.9 drive_storage.py

| ID | 優先 | 対象 | 観点 | 入力 | 期待結果 |
|---|---|---|---|---|---|
| BE-DRV-001 | P1 | 設定解決関数 | JSON優先 | JSONに空文字設定あり | envへフォールバックしない |
| BE-DRV-002 | P1 | 設定解決関数 | envフォールバック | JSON未設定 | env値採用 |
| BE-DRV-003 | P1 | storage_enabled | 有効判定 | 必須値あり | true |
| BE-DRV-004 | P1 | get_storage_bucket | バケット生成 | 設定有効 | bucket返却 |

## 7. フロントエンド単体テスト仕様（app.js）

注記:

- app.jsは単一巨大ファイルのため、まず純粋関数群を優先して自動化する
- DOM依存関数は最小DOMを組み立てて検証する

## 7.1 純粋関数

| ID | 優先 | 対象 | 観点 | 入力 | 期待結果 |
|---|---|---|---|---|---|
| FE-FN-001 | P1 | dateAdjustmentStatusLabel | 記号変換 | ok/maybe/ng/空 | ○/△/×/- |
| FE-FN-002 | P1 | dateAdjustmentStatusText | 文言変換 | ok/maybe/ng/空 | 参加可/調整可/不可/未回答 |
| FE-FN-003 | P1 | dateAdjustmentKeywordTokens | 形態抽出 | 日本語/英数/URL | URL除外・語抽出 |
| FE-FN-004 | P1 | dateAdjustmentFrequentKeywordsFromNotes | 頻度集計 | コメント配列 | 頻度順上位返却 |
| FE-FN-005 | P1 | dedupeDateAdjustmentResponses | 重複排除 | 同一候補・同一ユーザ重複 | 1件化 |
| FE-FN-006 | P1 | dateAdjustmentCandidateLabel | 表示整形 | 日付/時間/備考 | 想定フォーマット |
| FE-FN-007 | P1 | mutationRelatedCacheKeys | キャッシュキー判定 | 各API URL | 想定キー集合 |
| FE-FN-008 | P1 | escapeHtml | XSS無害化 | <script>等 | エスケープ済み |

## 7.2 通信/キャッシュ

| ID | 優先 | 対象 | 観点 | 前提/入力 | 期待結果 |
|---|---|---|---|---|---|
| FE-REQ-001 | P0 | request | 更新時ヘッダ付与 | localStorageにdevice_id | X-Device-Id送信 |
| FE-REQ-002 | P1 | request(GET) | ETag利用 | 既存etag | If-None-Match送信 |
| FE-REQ-003 | P1 | request(更新系) | 無効化範囲 | POST/PUT/DELETE | 関連キーのみdelete |
| FE-REQ-004 | P1 | loadExtraData | 部分失敗耐性 | 一部API失敗 | 他データ継続反映 |

## 7.3 日程調整UIロジック

| ID | 優先 | 対象 | 観点 | 前提/入力 | 期待結果 |
|---|---|---|---|---|---|
| FE-DATE-001 | P0 | ランキング計算 | スコア算出 | ok=2/maybe=1/ng=0 | 順位が期待通り |
| FE-DATE-002 | P1 | 第1候補表示 | 上位候補抽出 | 複数候補 | 1位候補表示 |
| FE-DATE-003 | P1 | 未回答抽出 | 回答者との差分 | members + responses | 未回答者一覧 |
| FE-DATE-004 | P1 | コメント抽出フィルタ | ON/OFF切替 | commentOnly=true/false | 表示件数切替 |
| FE-DATE-005 | P1 | 候補日並び替え | 上下操作 | 行移動クリック | DOM順序更新 |

## 8. トレーサビリティ

### 8.1 要件対応マトリクス

| 要件 | 対応テスト |
|---|---|
| 更新系APIの認可 | BE-AUTH-005, BE-CRUD-001..003, BE-REC-001..002, BE-SHEET-001..002, BE-EXTRA-002..005 |
| 楽観ロック409 | BE-EXTRA-006 |
| 日程調整バリデーション | BE-EXTRA-007..009 |
| 日程調整ランキング表示 | FE-DATE-001..002 |
| 未回答抽出/リマインド補助 | FE-DATE-003 |
| キャッシュ安定性 | FE-REQ-002..004 |

## 9. 実装ガイド（テストコード構成）

推奨ディレクトリ:

- tests/backend/test_auth.py
- tests/backend/test_crud.py
- tests/backend/test_extra.py
- tests/backend/test_recordings.py
- tests/backend/test_sheets.py
- tests/backend/test_utils.py
- tests/backend/test_drive_storage.py
- tests/frontend/test_app_pure_functions.js
- tests/frontend/test_app_date_adjustment.js

現行実装:

- tests/frontend/frontend_logic.test.js
- src/static/js/frontend_testable_logic.js（FE-FN/FE-REQ/FE-DATE の単体テスト用ロジック分離）

命名規則:

- test_<対象>_<条件>_<期待>

例:

- test_update_extra_returns_409_when_expected_updated_at_is_stale
- test_create_performance_requires_admin_device

## 10. 完了判定

単体テスト仕様完了条件:

- 本仕様書のP0/P1ケースがすべてテストコード化済み
- CIで常時実行される
- 変更差分に対する追加ケースが追記されている

CIカバレッジ出力:

- backend: coverage/backend/coverage.xml
- frontend: coverage/frontend/lcov.info, coverage/frontend/coverage-summary.json
- pull_request: backend/frontendのカバレッジ率を集約したCoverage Summaryコメントを自動更新

## 11. 保守ルール

- API追加時は本書へテストIDを追加する
- 認可ルール変更時はBE-AUTH/BE-EXTRA群を必ず更新する
- 日程調整関連変更時はFE-DATE群を必ず更新する
- 仕様改訂時は版番号と最終更新日を更新する
