# 奏オケポータル API / データ仕様書

版: 2.0
最終更新: 2026-06-17

## 1. 概要

本書は現行実装の API と JSON コレクション仕様を定義する。

## 2. 共通ルール

### 2.1 データ形式

- API の基本レスポンスは JSON
- 一覧は配列、単体はオブジェクト
- 更新系は created_at / updated_at を保持

### 2.2 ID

- next_id により整数採番
- 削除後も欠番は再利用しない

### 2.3 キャッシュ

- bootstrap 系 API は ETag を返却
- クライアントは If-None-Match を送信可能

## 3. API 一覧

### 3.1 基本

- GET /
- GET /api/health

### 3.2 認証

- POST /api/auth/portal-login
- POST /api/auth/member-password
- GET /api/auth/devices/{device_id}
- GET /api/auth/devices
- DELETE /api/auth/devices/{device_id}

### 3.3 bootstrap

- GET /api/bootstrap-lite
- GET /api/bootstrap-core
- GET /api/bootstrap

### 3.4 基本 CRUD

- /api/performances
- /api/schedules
- /api/members
- /api/events
- /api/announcements

各リソースで GET/POST/PUT/DELETE を提供。

### 3.5 録音

- POST /api/convert
- GET /api/recordings
- GET /api/recordings/download-zip
- GET /api/recordings/play/{path}
- GET /api/recordings/download/{path}
- DELETE /api/recordings
- GET /api/recordings/cloud/play/{object_name}
- GET /api/recordings/cloud/download/{object_name}
- POST /api/drive/upload
- GET /api/drive/files

### 3.6 楽譜

- GET /api/sheets
- GET /api/sheets/download/{path}
- GET /api/sheets/view/{path}
- GET /api/sheets/cloud/download/{object_name}
- GET /api/sheets/cloud/view/{object_name}
- GET /api/sheets/download-zip
- POST /api/sheets/upload
- PUT /api/sheets/{sheet_id}/part
- PUT /api/sheets/parts
- DELETE /api/sheets

### 3.7 汎用 extra

- GET /api/extra/{name}
- POST /api/extra/{name}
- PUT /api/extra/{name}/{item_id}
- DELETE /api/extra/{name}/{item_id}

更新系リクエスト（POST/PUT/DELETE）は `X-Device-Id` ヘッダ必須。

PUT は以下を許容:

- 従来形式: 更新したい JSON 本体
- 競合検知形式: `{ payload: {...}, expected_updated_at: "..." }`

`expected_updated_at` が現行 `updated_at` と不一致の場合は `409` を返す。

対象 name は以下。

- absences
- event_responses
- date_adjustments
- date_adjustment_responses
- sheet_library
- payments
- castings
- piece_infos
- practice_instructions
- albums
- part_settings
- venue_settings
- org_settings
- sns_settings
- connection_settings
- desired_pieces
- promotions

## 4. 認証 API 詳細

### 4.1 POST /api/auth/portal-login

用途:

- 団員資格確認
- 端末認証情報登録
- ログイン応答返却

主要入力:

- name
- part
- password
- device_id
- device_name
- user_agent

主要出力:

- authenticated
- member_id
- member_name
- permission
- is_recording_manager
- is_sheet_manager

### 4.2 POST /api/auth/member-password

用途:

- 初回パスワード登録

### 4.3 GET /api/auth/devices/{device_id}

用途:

- 端末単位の認証照会
- 最終アクセス時刻更新

## 5. 録音・楽譜仕様

### 5.1 録音メタデータ

代表キー:

- name
- date
- piece
- path または object_name
- play_url
- download_url
- source
- duration_seconds
- duration

録音一覧では、Cloud Storage のメタデータとローカル保存ファイルが同じ録音を指す場合、Cloud Storage 側を優先して 1 ファイル 1 件として返す。

### 5.2 楽譜メタデータ

代表キー:

- id
- performance_id
- performance_title
- piece
- part
- source
- path または object_name
- view_url
- download_url

## 6. JSON コレクション仕様

### 6.1 管理対象

- performances
- schedules
- announcements
- drive_files
- events
- members
- absences
- event_responses
- date_adjustments
- date_adjustment_responses
- sheet_library
- payments
- castings
- piece_infos
- practice_instructions
- albums
- part_settings
- venue_settings
- org_settings
- sns_settings
- connection_settings
- auth_devices
- recording_metadata
- desired_pieces
- promotions

### 6.2 重要フィールド

members:

- permission
- system_access_until
- is_recording_manager
- is_sheet_manager

payments:

- paid_until_month
- membership_fee_amount
- performance_fees
- performance_fee_amounts

castings:

- performance_id
- piece
- members[]
- extras[]

date_adjustments:

- title
- deadline
- notes
- delete_phrase
- created_by
- member_id
- candidates[]

制約:

- title 必須
- candidates は1件以上必須
- candidates の date/start_time/end_time 重複は禁止

date_adjustment_responses:

- adjustment_id
- candidate_id
- name
- member_id
- status (ok / maybe / ng)
- note

制約:

- status は ok / maybe / ng のみ
- candidate_id/name 必須

piece_infos:

- performance_id
- piece
- description

認可:

- 認証済み団員なら登録・編集・削除可

practice_instructions:

- performance_id
- piece
- practice_notes
- performance_instruction

認可:

- 認証済み団員なら登録・編集・削除可

connection_settings:

- google_project_id
- google_cloud_storage_bucket
- google_cloud_storage_data_prefix
- google_cloud_storage_public
- google_service_account_file
- google_service_account_json

## 7. エラーハンドリング

- バリデーション失敗: 400
- 認証失敗: 401 / 403
- 未検出: 404
- クラウド保存失敗: 502

detail フィールドでメッセージを返す。

## 8. 参照

- main.py のコメント付き API 定義
- DESIGN_WEB.md
- SYSTEM_DESIGN.md
