# 奏オケポータル システム設計書

版: 2.1
最終更新: 2026-06-26

## 1. システム概要

奏オケポータルは、オーケストラ運営向けの統合 Web システムである。

提供価値:

- 団員向け情報参照と自己登録
- 管理者向け運営データ管理
- システム管理者向け設定管理
- ローカル運用と Cloud 連携の両立

## 2. アーキテクチャ

### 2.1 構成

- クライアント: HTML + CSS + Vanilla JavaScript + Bootstrap
- API: FastAPI
- 永続化: JSON ファイル
- ファイル保存: ローカル uploads + Google Cloud Storage

### 2.2 主要コンポーネント

- src/static/js/app.js: 画面制御、状態管理、API 呼び出し
- src/backend/main.py: API 本体、JSON CRUD、ファイル配信
- src/backend/drive_storage.py: Cloud 接続設定解決と保存処理

### 2.3 データ同期方針

- 基本は JSON コレクションを正として扱う
- Cloud 設定有効時は JSON も Cloud へ保存
- 起動時にキャッシュを温めて応答速度を確保
- connection_settings が空の場合は旧環境変数から1件自動登録して互換運用する

## 3. ロール・認可

### 3.1 権限

- 一般
- エキストラ
- 管理者
- システム管理者

### 3.2 補助権限

- is_recording_manager
- is_sheet_manager

### 3.3 認可ルール

- 管理者メニュー: 管理者以上
- システム管理: システム管理者のみ
- 録音管理: 管理者または録音担当
- 楽譜管理: 管理者または楽譜担当
- エキストラ: system_access_until 超過時はログイン不可
- 更新系 API は `X-Device-Id` を必須とし、auth_devices の認証済み端末のみ許可
- 基本マスタ（performances/schedules/members/events/announcements）は管理者以上のみ更新可
- extra のうち運用設定系（connection_settings 等）は管理者以上のみ更新可
- date_adjustments / date_adjustment_responses / absences / event_responses は本人または管理者のみ更新可
- practice_instructions / piece_infos は認証済み団員なら登録・編集・削除可
- extra PUT は `expected_updated_at` 指定時に競合検知を行い、不一致は 409

## 4. 画面構造

### 4.1 共通

- ドロワーメニュー
- マニュアル導線
- トースト通知

### 4.2 団員パネル

- お知らせ、演奏会、練習予定、録音部屋
- 欠席連絡、楽譜ライブラリ、支払状況、乗り番表
- イベント、日程調整、楽曲情報、練習指示、演奏希望曲、宣伝、アルバム
- 楽曲情報は「未開催演奏会 -> 曲選択 -> 曲別編集」導線で、登録済み曲には目印を表示
- 練習指示は「未開催演奏会 -> 曲選択 -> 曲別編集」導線で、登録済み曲には目印を表示
- 団員紹介、演奏会記録、SNS、マニュアル

### 4.3 管理パネル

- 録音管理、演奏会情報、練習予定、お知らせ
- イベント、団員登録
- 支払状況、会場管理、乗り番管理、楽譜管理

### 4.4 システム管理パネル

- 認証端末、団体情報、SNS
- 接続先情報、パート管理
- データメンテナンス（孤立データ検出・削除）

## 5. データモデル

管理コレクション:

- performances
- schedules
- announcements
- events
- members
- absences
- event_responses
- date_adjustments
- date_adjustment_responses
- payments
- castings
- piece_infos
- practice_instructions
- desired_pieces
- promotions
- albums
- sheet_library
- drive_files
- recording_metadata
- part_settings
- venue_settings
- org_settings
- sns_settings
- connection_settings
- auth_devices

## 6. API サブシステム

### 6.1 認証

- /api/auth/portal-login
- /api/auth/member-password
- /api/auth/devices

### 6.2 初期ロード

- /api/bootstrap-lite
- /api/bootstrap-core
- /api/bootstrap

### 6.3 基本 CRUD

- /api/performances
- /api/schedules
- /api/members
- /api/events
- /api/announcements

### 6.4 録音

- /api/convert
- /api/recordings
- /api/recordings/play/{path}
- /api/recordings/download/{path}
- /api/recordings/download-zip
- /api/recordings/cloud/play/{object_name}
- /api/recordings/cloud/download/{object_name}
- /api/drive/upload
- /api/drive/files

### 6.5 楽譜

- /api/sheets
- /api/sheets/upload
- /api/sheets/download/{path}
- /api/sheets/view/{path}
- /api/sheets/cloud/download/{object_name}
- /api/sheets/cloud/view/{object_name}
- /api/sheets/download-zip
- /api/sheets/{sheet_id}/part
- /api/sheets/parts
- /api/sheets (DELETE)

### 6.6 汎用拡張

- /api/extra/{name}  （CRUD: GET / POST / PUT / DELETE）
- POST /api/extra/albums/{album_id}/photos  （アルバム写真アップロード、全員可）
- DELETE /api/extra/albums/{album_id}/photos/{photo_id}  （写真削除、管理者専用）

### 6.7 データメンテナンス

- GET /api/maintenance/orphans  （孤立データ検出、管理者専用）
- POST /api/maintenance/cleanup  （孤立データ削除、管理者専用）
- POST /api/system/data-migration  （JSON->PostgreSQL移行実行、システム管理者専用）

### 6.8 一時運用メニュー（システム管理）

- システム管理パネルに「データ移行」タブを一時追加
- ボタン操作で `scripts/migrate_json_to_postgres.py` をサーバー側から起動
- サーバー側実行時は現在参照している JSON データを一時スナップショットに書き出し、そのディレクトリを `--data-dir` として渡す
- Cloud Run 用 Docker イメージには `scripts/` と `db/` を含め、移行スクリプトと件数確認 SQL を実行時に参照可能にする
- JSON に `created_at` / `updated_at` がない行は、DB の NOT NULL 制約に合わせて移行時刻を補完して INSERT する
- 本実行が成功し、件数照合が `MATCHED` になった場合のみ、移行済み JSON コレクションを削除する。中身が空になった JSON はファイルごと削除する
- 削除したローカル JSON ファイルと Cloud Storage JSON の件数は、データ移行画面の実行ログに表示する
- 実行モード:
  - 件数確認（dry-run）
  - 本実行（truncate + 移行）
- 誤操作防止として本実行前に確認ダイアログを必須とする
- 本実行後は移行スクリプトが自動で件数照合（JSON件数 vs DB件数）を行い、結果を画面に表示する

### 6.9 恒久運用メニュー（システム管理）

- システム管理パネルに「データベース」メニューを配置
- 当ポータル利用テーブルのみを一覧表示し、ページング付きでレコード閲覧可能
- 機微情報カラム（password / service account情報）はマスク表示
- API:
  - GET /api/system/database/tables
  - GET /api/system/database/records?table=...&limit=...&offset=...

## 7. パフォーマンス設計

- バックエンド: MemoryCache + インデックス + ETag
- フロント: IndexedDB キャッシュ + in-flight dedupe
- 初期描画: 軽量 bootstrap 先行、重い一覧は遅延
- `/api/revision` を `Cache-Control: no-store` で取得し、Cloud Run リビジョンを画面に動的表示。bootstrap 側の値は後方互換として扱う

## 8. 運用設計

- Cloud Run 配備を想定
- 静的アセットはバージョンクエリで更新制御
- index.html は no-store で常に最新を取得
- JSON から PostgreSQL への初期移行は `scripts/migrate_json_to_postgres.py` を利用し、`src/data/*.json` を正規化テーブルへ投入する
- 移行時は `--dry-run` で件数確認後、`--truncate` 付きで本投入する運用を標準とする

## 9. 正本ドキュメント

本書は全体設計の正本であり、実装詳細は DESIGN_WEB.md と API_DATABASE_SPEC.md を参照する。

単体テスト仕様は UNIT_TEST_SPEC.md を参照する。

結合テスト仕様は INTEGRATION_TEST_SPEC.md を親として、
INTEGRATION_TEST_SPEC_BACKEND.md / INTEGRATION_TEST_SPEC_FRONTEND.md / INTEGRATION_TEST_SPEC_CI.md を参照する。

運用テスト仕様は OPERATION_TEST_SPEC.md を参照する。

## 10. 機能詳細（新機能・更新機能）

### 10.1 アルバム機能

- 団員が自由にアルバムイベント（イベント名）を作成できる
- 各イベントに対して複数の写真をアップロード可能（Google Cloud Storage に保存）
- 写真はイベントページで gallery 表示（lazy loading）
- 画像表示は `/api/albums/{album_id}/photos/{photo_id}` API 経由で配信し、Cloud/ローカル保存の差異を吸収
- イベント削除・写真削除は管理者のみ可能
- イベント一覧は作成日降順（新しいものが上）
- データ構造: `{ id, event_name, created_by_member_id, created_by_member_name, created_at, updated_at, photos: [{ id, filename, url, uploaded_by_member_id, uploaded_by_member_name, uploaded_at }] }`

### 10.2 Cloud Run リビジョン表示

- バックエンドが Cloud Run 標準の `K_REVISION` を優先して読み込み、後方互換として `CLOUD_RUN_REVISION` も参照する
- リビジョンはデータ更新とは独立して変わるため、`/api/revision` を `Cache-Control: no-store` で提供し、bootstrap/IndexedDB/ETag キャッシュに古い値が残っても最新値を取得できるようにする
- フロントは `loadCloudRunRevision()` と `updateCloudRunRevision()` でサイドドロワーの Rev. 表示を動的更新し、`kanade-orchestra-00060-hsf` のような値は `00060-hsf` と表示する
- Google Cloud が自動的に設定する環境変数のため、デプロイするたびに自動的に最新リビジョン番号に切り替わる

### 10.3 乗り番表（ポータル表示）

- 演奏会ごと・曲ごとにセクション分割して表示
- 各曲の出演者をパートごとにグルーピングして表形式で表示
- 団員名は各パート内で縦並び表示
- パート順は part_settings の登録順に準拠
- エキストラは `extras[].part` フィールドでグルーピング（未設定時は「エキストラ」表示）

### 10.4 データメンテナンス

- 判定は参照IDを文字列正規化して実施し、数値/文字列の型差による誤検出を防止
- 参照IDが未設定（空文字/None）の場合は孤立扱いにしない
- システム管理メニュー「データメンテナンス」タブから実行
- `GET /api/maintenance/orphans` で孤立データを検出（管理者専用）
- `POST /api/maintenance/cleanup` で選択した孤立データを削除（管理者専用）
- 検出対象: castings・absences・payments・piece_infos・practice_instructions・desired_pieces・event_responses・date_adjustment_responses
- 各レコードをチェックボックスで個別選択して削除可能
- 削除後に自動再スキャンを実行して結果を更新

## 11. 今後の保守方針

- 新機能追加時は appState、API、JSON コレクション定義、設計書を同時更新
- 権限分岐が増える機能は必ず認可ルールを設計書へ明記
- 画面追加時は団員/管理者/システム管理のどの導線に属するかを明記

## 12. PostgreSQL テーブル設計（ドラフト）

- 現行 JSON コレクションを Cloud SQL for PostgreSQL へ移行するための初期 DDL は `db/postgresql_schema.sql` を参照
- テーブル仕様書は `db/postgresql_table_spec.md` を参照
- テーブルレイアウト（ER）は `db/postgresql_table_layout.md` を参照
- 対象は音声/画像などのバイナリ本体を除く業務データとメタデータ
- バイナリ本体は従来どおり Google Cloud Storage を継続利用する想定

## 13. Cloud Run 構築値（PostgreSQL移行方針）

### 13.1 本番採用値

- Google Cloud プロジェクトID: kanade-orchestra
- Cloud Run サービス名: kanade-orchestra
- Cloud Storage バケット名: kanade-storage
- リージョン: asia-northeast2
- Cloud SQL 接続名: kanade-orchestra:asia-northeast2:kanade-portal-pg
- DB名: kanade_portal
- DBユーザー: kanade_app
- Secret 名（DBパスワード）: kanade-portal-db-password

### 13.2 接続方式

- Cloud Run から Cloud SQL for PostgreSQL へ Cloud SQL Connector（Unix socket）で接続する
- `DB_HOST=/cloudsql/kanade-orchestra:asia-northeast2:kanade-portal-pg` を使用する
- `DB_PASSWORD` は Secret Manager から注入する
- 既存の GCS 連携設定（GOOGLE_CLOUD_STORAGE_*）は継続利用する

### 13.3 必要権限

- Cloud Run サービスアカウントに以下ロールを付与する
  - roles/cloudsql.client
  - roles/secretmanager.secretAccessor
  - roles/storage.objectAdmin
- 初回構築時の運用チェックは `CLOUD_RUN_INITIAL_CHECKLIST.md` を参照する

│  │  - システム設定                                    │    │
│  └────────────────────────────────────────────────────┘    │
└────────┬───────────────────────────────────────────────────┘
         │ REST API / IndexedDB Cache
┌────────▼───────────────────────────────────────────────────┐
│                    サーバー層（FastAPI）                   │
│  ┌─────────────────────────────────────────────────┐      │
│  │  Authentication & Authorization                 │      │
│  │  - /api/auth/portal-login                       │      │
│  │  - /api/auth/member-password                    │      │
│  │  - /api/auth/devices/*                          │      │
│  └─────────────────────────────────────────────────┘      │
│  ┌─────────────────────────────────────────────────┐      │
│  │  Bootstrap & Data Loading                       │      │
│  │  - /api/bootstrap-lite (初期表示)               │      │
│  │  - /api/bootstrap-core (ベースデータ)           │      │
│  │  - /api/bootstrap (全データ)                    │      │
│  └─────────────────────────────────────────────────┘      │
│  ┌─────────────────────────────────────────────────┐      │
│  │  Content CRUD APIs                              │      │
│  │  - /api/performances/*                          │      │
│  │  - /api/schedules/*                             │      │
│  │  - /api/announcements/*                         │      │
│  │  - /api/members/*                               │      │
│  │  - /api/events/*                                │      │
│  └─────────────────────────────────────────────────┘      │
│  ┌─────────────────────────────────────────────────┐      │
│  │  File Management APIs                           │      │
│  │  - /api/convert (音声変換)                      │      │
│  │  - /api/recordings/* (録音管理)                 │      │
│  │  - /api/sheets/* (楽譜管理)                     │      │
│  │  - /api/drive/upload (GCS アップロード)        │      │
│  └─────────────────────────────────────────────────┘      │
│  ┌─────────────────────────────────────────────────┐      │
│  │  Extra Configuration APIs                       │      │
│  │  - /api/extra/{name} (CRUD)                    │      │
│  └─────────────────────────────────────────────────┘      │
│  ┌─────────────────────────────────────────────────┐      │
│  │  Memory Cache Layer                             │      │
│  │  - JSONデータメモリキャッシュ                    │      │
│  │  - IDインデックス                                │      │
│  │  - ETag管理                                     │      │
│  └─────────────────────────────────────────────────┘      │
└────────┬───────────────────────────────────────────────────┘
         │
    ┌────┴────┐
    │          │
┌───▼──┐  ┌───▼─────────────────────┐
│Local │  │ Google Cloud Services   │
│JSON  │  │ - Cloud Storage         │
│Files │  │ - Cloud Run (Deploy)    │
└──────┘  └───────────────────────────┘
```

### 2. データフロー

#### 2.1 ログインフロー
```
ユーザー入力 (名前, パート, パスワード)
    ↓
/api/auth/portal-login
    ↓
メンバー検索（インデックス利用）
    ↓
パスワード検証
    ↓
デバイス登録 (/api/auth/devices)
    ↓
セッション情報をブラウザに保存 (localStorage)
    ↓
Portal ホーム表示
```

#### 2.2 ブートストラップフロー
```
ページロード
    ↓
IndexedDB キャッシュ確認
    ↓
（キャッシュなし or 更新必要）
    ↓
/api/bootstrap-lite 取得（ETag確認）
    ↓
IndexedDB に保存
    ↓
初期表示 (Performance, Schedule, Announcement)
    ↓
/api/bootstrap-core 非同期取得（バックグラウンド）
    ↓
コアデータ更新表示
    ↓
/api/bootstrap 完全データ取得（バックグラウンド）
```

#### 2.3 ファイルアップロードフロー
```
管理者がファイル選択
    ↓
/api/convert（WAV→MP3変換）
    ↓
    ├─ ローカル保存 (./uploads/converted/)
    │
    └─ Google Cloud Storage へアップロード（設定時）
        ↓
        drive_files.json に登録
        ↓
        キャッシュ更新
```

---

## データモデル

### 1. JSONスキーマ

#### 1.1 Performances (演奏会)
```json
{
  "id": 1,
  "title": "第10回定期演奏会",
  "date": "2026-07-15",
  "open_time": "18:00",
  "start_time": "18:30",
  "venue": "NHKホール",
  "conductor": "指揮者名",
  "flyer_image": "data:image/jpeg;base64,...",
  "pieces": [
    {
      "id": 1,
      "performance_id": 1,
      "title": "交響曲第5番",
      "composer": "ベートーヴェン",
      "parts": ["Violin I", "Violin II", "Viola", "Cello", "Contrabass"]
    }
  ],
  "created_at": "2026-06-01T10:00:00",
  "updated_at": "2026-06-01T10:00:00"
}
```

#### 1.2 Schedules (練習スケジュール)
```json
{
  "id": 1,
  "date": "2026-06-18",
  "time": "19:00",
  "start_time": "19:00",
  "end_time": "21:00",
  "venue": "練習室A",
  "available_hours": "2時間",
  "available_start_time": "19:00",
  "available_end_time": "21:00",
  "performance_id": 1,
  "performance_title": "第10回定期演奏会",
  "pieces": "交響曲第5番",
  "is_conductor_training": false,
  "is_main_performance": false,
  "notes": "楽器を持参してください",
  "created_at": "2026-06-01T10:00:00",
  "updated_at": "2026-06-01T10:00:00"
}
```

#### 1.3 Announcements (お知らせ)
```json
{
  "id": 1,
  "date": "2026-06-17",
  "title": "来週の練習予定変更",
  "content": "天気予報により...",
  "created_at": "2026-06-17T09:00:00",
  "updated_at": "2026-06-17T09:00:00"
}
```

#### 1.4 Members (メンバー)
```json
{
  "id": 1,
  "name": "田中太郎",
  "last_name": "田中",
  "first_name": "太郎",
  "maiden_name": "佐藤",
  "last_name_kana": "タナカ",
  "first_name_kana": "タロウ",
  "maiden_name_kana": "サトウ",
  "part": "Violin I",
  "photo_url": "data:image/jpeg;base64,...",
  "is_founder": true,
  "is_recording_manager": true,
  "is_sheet_manager": false,
  "password": "hashed_password",
  "permission": "管理者",
  "joined_at": "2020-01-15",
  "introducer": "田中次郎",
  "role": "パートリーダー",
  "instrument_history": "ヴァイオリン 15年",
  "past_orchestras": "東京オーケストラ",
  "comment": "団員コメント",
  "created_at": "2020-01-15T00:00:00",
  "updated_at": "2026-06-17T10:00:00"
}
```

#### 1.5 Events (イベント調整)
```json
{
  "id": 1,
  "title": "懇親会の調整",
  "date": "2026-07-20",
  "start_time": "19:00",
  "deadline": "2026-07-15",
  "url": "https://example.com/survey",
  "notes": "会費は3000円です",
  "delete_phrase": "不参加",
  "fee": "3000",
  "created_at": "2026-06-10T10:00:00",
  "updated_at": "2026-06-10T10:00:00"
}
```

#### 1.6 Auth Devices (認証デバイス)
```json
{
  "id": 1,
  "device_id": "550e8400-e29b-41d4-a716-446655440000",
  "device_name": "Windows 11 / ja-JP",
  "member_id": 1,
  "member_name": "田中太郎",
  "member_part": "Violin I",
  "permission": "管理者",
  "is_recording_manager": true,
  "is_sheet_manager": false,
  "user_agent": "Mozilla/5.0 ...",
  "authenticated_at": "2026-06-17T10:00:00",
  "last_seen_at": "2026-06-17T11:00:00"
}
```

#### 1.7 Extra Data (拡張データ)

##### Payments (支払い状況)
```json
{
  "id": 1,
  "member_id": 1,
  "type": "会費",
  "amount": 50000,
  "currency": "JPY",
  "paid_date": "2026-06-15",
  "due_date": "2026-06-30",
  "status": "支払済",
  "notes": "6月分"
}
```

##### Part Settings (パート設定)
```json
{
  "id": 1,
  "part": "Violin I",
  "display_name": "ヴァイオリン第一分奏",
  "color": "#FF6B6B",
  "order": 1
}
```

##### Venue Settings (会場設定)
```json
{
  "id": 1,
  "venue_name": "NHKホール",
  "address": "東京都渋谷区...",
  "capacity": 3500,
  "phone": "03-1234-5678"
}
```

---

## APIリファレンス

### 1. 認証API

#### 1.1 ログイン
```
POST /api/auth/portal-login
Content-Type: application/json

{
  "name": "田中太郎",
  "part": "Violin I",
  "password": "password123",
  "device_id": "device-uuid",
  "device_name": "Windows 11",
  "user_agent": "Mozilla/5.0..."
}

Response 200:
{
  "authenticated": true,
  "device_id": "device-uuid",
  "member_id": 1,
  "member_name": "田中太郎",
  "member_part": "Violin I",
  "permission": "管理者",
  "is_recording_manager": true,
  "is_sheet_manager": false,
  "hidden_user": false
}
```

#### 1.2 パスワード設定
```
POST /api/auth/member-password
{
  "name": "田中太郎",
  "part": "Violin I",
  "password": "newpassword"
}

Response 200:
{
  "password_registered": true,
  "member_id": 1
}
```

#### 1.3 デバイス管理
```
GET /api/auth/devices
Response: List[AuthDevice]

GET /api/auth/devices/{device_id}
Response: { authenticated: true, device: AuthDevice }

DELETE /api/auth/devices/{device_id}
Response: { message: "Deleted" }
```

### 2. ブートストラップAPI

```
GET /api/bootstrap-lite
→ 初期表示用（軽量）: performances, schedules, announcements, members, extras

GET /api/bootstrap-core
→ 通常用（中程度）: 上記 + events, absences, event_responses, castings...

GET /api/bootstrap
→ フル読み込み: 全データ + recordings, sheets
```

**ETag対応**: すべての GET リクエストに `If-None-Match` ヘッダーが送信可能。  
**レスポンス**: 304 Not Modified or 200 with ETag header

### 3. コンテンツCRUD API

#### 3.1 Performances
```
GET    /api/performances              → List[Performance]
POST   /api/performances              → Performance (新規作成)
GET    /api/performances/{id}         → Performance
PUT    /api/performances/{id}         → Performance (更新)
DELETE /api/performances/{id}         → { message: "Deleted" }
```

#### 3.2 Schedules
```
GET    /api/schedules                 → List[Schedule]
POST   /api/schedules                 → Schedule
GET    /api/schedules/{id}            → Schedule
PUT    /api/schedules/{id}            → Schedule
DELETE /api/schedules/{id}            → { message: "Deleted" }
```

#### 3.3 Announcements
```
GET    /api/announcements             → List[Announcement]
POST   /api/announcements             → Announcement
GET    /api/announcements/{id}        → Announcement
PUT    /api/announcements/{id}        → Announcement
DELETE /api/announcements/{id}        → { message: "Deleted" }
```

#### 3.4 Members
```
GET    /api/members                   → List[Member]
POST   /api/members                   → Member
GET    /api/members/{id}              → Member
PUT    /api/members/{id}              → Member
DELETE /api/members/{id}              → { message: "Deleted" }
```

#### 3.5 Events
```
GET    /api/events                    → List[EventAdjustment]
POST   /api/events                    → EventAdjustment
GET    /api/events/{id}               → EventAdjustment
PUT    /api/events/{id}               → EventAdjustment
DELETE /api/events/{id}               → { message: "Deleted" }
```

### 4. ファイル管理API

#### 4.1 音声変換・管理
```
POST   /api/convert
Content-Type: multipart/form-data
body: {
  file: <WAV/MP3>,
  bitrate: 192  // 128, 192, 320
}
Response: { success: true, file: Recording }

GET    /api/recordings                → List[Recording]
GET    /api/recordings/play/{path}    → Audio stream
GET    /api/recordings/download/{path} → Audio file
GET    /api/recordings/download-zip   → ZIP file
DELETE /api/recordings                → Batch delete
```

#### 4.2 楽譜管理
```
POST   /api/sheets/upload
Content-Type: multipart/form-data
body: {
  files: [File, ...],
  performance_id: "123",
  piece: "Piece Name"
}
Response: List[Sheet]

GET    /api/sheets                    → List[Sheet]
GET    /api/sheets/view/{path}        → PDF inline
GET    /api/sheets/download/{path}    → PDF download
GET    /api/sheets/download-zip       → ZIP file
PUT    /api/sheets/{id}/part          → Sheet (パート更新)
DELETE /api/sheets                    → Batch delete
```

#### 4.3 Google Cloud Storage (GCS)
```
POST   /api/drive/upload              → Cloud Storage へアップロード
GET    /api/recordings/cloud/play/{name}    → Cloud Stream
GET    /api/recordings/cloud/download/{name} → Cloud Download
GET    /api/sheets/cloud/view/{name}  → Cloud PDF view
GET    /api/sheets/cloud/download/{name} → Cloud PDF download
GET    /api/drive/files               → Cached drive files
```

### 5. 拡張設定API
```
GET    /api/extra/{name}              → List[ExtraItem]
POST   /api/extra/{name}              → ExtraItem
PUT    /api/extra/{name}/{item_id}    → ExtraItem
DELETE /api/extra/{name}/{item_id}    → { message: "Deleted" }

name: payments | castings | piece_infos | absences | event_responses
      | albums | part_settings | venue_settings | org_settings
      | sns_settings | sheet_library | recording_metadata | desired_pieces
```

### 6. ヘルスチェック
```
GET /api/health
Response: {
  "status": "healthy",
  "timestamp": "2026-06-17T11:00:00",
  "service": "Orchestra Activity Tool",
  "storage_configured": "true"
}
```

---

## フロントエンド構造

### 1. グローバルステート (appState)

```javascript
const appState = {
  // UI表示状態
  selectedFiles: [],
  dataLoaded: false,
  recordingsLoaded: false,
  sheetsLoaded: false,
  essentialDataLoaded: false,
  fullDataLoading: false,
  suppressDerivedRender: false,
  
  // コンテンツデータ
  performances: [],
  performancePieces: [],
  schedules: [],
  announcements: [],
  events: [],
  members: [],
  recordings: [],
  absences: [],
  eventResponses: [],
  sheetLibrary: [],
  payments: [],
  castings: [],
  pieceInfos: [],
  desiredPieces: [],
  albums: [],
  
  // 設定データ
  partSettings: [],
  venueSettings: [],
  orgSettings: [],
  snsSettings: [],
  
  // 認証情報
  portalAuthVerified: false,
  currentUserMemberId: null,
  currentUserName: '',
  currentUserPermission: '',
  currentUserPart: '',
  currentUserIsRecordingManager: false,
  currentUserIsSheetManager: false,
  authDevices: [],
  
  // 再生制御
  currentAudio: null,
  currentPlayButton: null,
  currentRecordingItem: null,
  continuousPlayback: false,
  
  // 楽譜表示
  sheetPdfScale: 1,
  sheetPdfUrl: '',
  sheetPdfRendering: false,
  sheetFilters: {
    performanceId: '',
    piece: '',
    part: ''
  },
  manifestObjectUrl: '',
  
  // キャッシュ
  authDevices: []
}
```

### 2. UI構成

#### 2.1 ページ構成
```
root (/)
  ├─ portalLoginPanel (ログイン)
  ├─ memberPanel (団員ビュー)
  │  ├─ memberHomeTab (ホーム)
  │  ├─ memberPerformanceTab (演奏会情報)
  │  ├─ memberScheduleTab (練習予定)
  │  ├─ memberRecordingTab (録音部屋)
  │  ├─ memberIntroTab (団員紹介)
  │  ├─ memberAbsenceTab (欠席連絡)
  │  ├─ memberSheetTab (楽譜ライブラリ)
  │  ├─ memberSheetViewerTab (楽譜表示)
  │  ├─ memberPaymentTab (支払い状況)
  │  ├─ memberCastingTab (乗り番表)
  │  ├─ memberEventTab (イベント調整)
  │  ├─ memberAlbumTab (アルバム)
  │  └─ memberConcertRecordTab (演奏会記録)
  │
  ├─ adminPanel (管理者ビュー)
  │  ├─ uploadTab (録音管理)
  │  ├─ performanceTab (演奏会管理)
  │  ├─ scheduleTab (スケジュール管理)
  │  ├─ announcementTab (お知らせ管理)
  │  ├─ memberTab (メンバー管理)
  │  ├─ eventTab (イベント管理)
  │  ├─ paymentAdminTab (支払い管理)
  │  ├─ sheetAdminTab (楽譜管理)
  │  └─ venueAdminTab (会場設定)
  │
  └─ systemPanel (システム管理)
     ├─ systemOrgTab (団体設定)
     └─ systemSnsTab (SNS設定)
```

#### 2.2 モジュール構成

| モジュール | 責務 | 行数（目安） |
|-----------|------|------------|
| Cache/Auth | ログイン、セッション管理、キャッシュ | 500+ |
| Portal Home | ホームページ、メニュー、カウントダウン | 300+ |
| Content Rendering | Performance, Schedule, Announcement 表示 | 1000+ |
| Member Views | 団員向けビュー表示 | 2000+ |
| Admin Views | CRUD管理画面 | 1500+ |
| File Management | 音声再生、楽譜表示、ダウンロード | 1000+ |
| UI Utilities | ヘルパー関数、イベントハンドラ | 500+ |

### 3. 主要関数

#### 3.1 認証・初期化
```javascript
isPortalAuthenticated()      // ログイン状態確認
enterPortal()                // ポータル入場
loadEssentialData()          // 基本データ読み込み
loadFullDataInBackground()   // フル読み込み（バックグラウンド）
```

#### 3.2 データ読み込み
```javascript
request(url, options)        // キャッシュ対応のHTTP通信
requestJson(url)             // JSON取得
ensureRecordingsLoaded()     // 録音データ確認読み込み
ensureSheetsLoaded()         // 楽譜データ確認読み込み
```

#### 3.3 レンダリング
```javascript
renderPortalHome()           // ホームページ表示
renderMemberPerformances()   // 演奏会一覧
renderMemberSchedules()      // スケジュール一覧
renderMemberIntros()         // 団員紹介
renderRecordings()           // 録音リスト
renderSheets()               // 楽譜リスト
```

#### 3.4 ファイル操作
```javascript
toggleRecordingPlayback(item) // 録音再生/停止
startRecordingPlayback(item)  // 単一 audio 要素を使った録音再生
playNextRecording(item)       // 連続再生時に次の録音へ遷移
downloadFile(url, filename)  // ダウンロード
displaySheet(sheetUrl)       // 楽譜表示（PDFビューア）
uploadFile(file)             // ファイルアップロード
```

#### 3.5 データ管理
```javascript
createItem(type, data)       // 新規作成
updateItem(type, id, data)   // 更新
deleteItem(type, id)         // 削除
savePendingChanges()         // 変更保存
```

---

## 認証・認可

### 1. 認証フロー

```
ユーザーがログイン画面を開く
  ↓
localStorage から device_id を取得（なければ生成）
  ↓
ユーザーが名前、パート、パスワードを入力
  ↓
POST /api/auth/portal-login
  ↓
  ├─ (隠し認証) name == "Administrator" && password == "systemadminadmin"
  │  → System Admin ロール付与
  │
  └─ members.json で検索
     ├─ (パスワード未設定) → 初期設定画面へ
     ├─ (パスワード不一致) → 401 Unauthorized
     └─ (一致) → 認証成功
         ↓
         auth_devices.json に登録
         ↓
         localStorage に token 保存
         ↓
         ポータルホームへ遷移
```

### 2. 権限モデル

| 権限 | 説明 | 利用可能な機能 |
|-----|------|--------------|
| システム管理者 | システムレベルの全操作 | 全機能 + システム設定 |
| 管理者 | 全コンテンツの編集 | CRUD全操作 + ファイル管理 |
| 録音マネージャー | 録音ファイル管理のみ | 録音アップロード・削除 |
| 楽譜マネージャー | 楽譜ファイル管理のみ | 楽譜アップロード・削除 |
| 一般 | 閲覧のみ | GET操作のみ |

### 3. 認可チェック

```javascript
canAccessAdmin()           // 管理者以上か確認
canAccessSystemAdmin()     // システム管理者か確認
canManageRecordings()      // 録音管理可能か確認
canManageSheets()          // 楽譜管理可能か確認
```

---

## ファイル管理

### 1. ディレクトリ構成

```
./
├── src/
│   ├── backend/
│   │   ├── main.py                 # FastAPI アプリケーション
│   │   └── drive_storage.py        # GCS 統合
│   ├── data/
│   │   ├── performances.json
│   │   ├── schedules.json
│   │   ├── announcements.json
│   │   ├── members.json
│   │   ├── events.json
│   │   ├── auth_devices.json
│   │   ├── sheet_library.json
│   │   ├── recording_metadata.json
│   │   └── ... (その他JSON)
│   ├── static/
│   │   ├── index.html
│   │   ├── css/
│   │   │   └── style.css
│   │   ├── js/
│   │   │   └── app.js             # フロントエンド メインコード (4000+ 行)
│   │   ├── icons/
│   │   └── img/
│   └── uploads/
│       ├── converted/              # MP3 変換ファイル
│       │   └── {YYYY-MM-DD}/{piece}/
│       ├── drive/                  # GCS キャッシュ
│       ├── drive-staging/          # アップロード待機
│       └── sheets/                 # 楽譜 PDF
│           └── {performance_id}/{piece}/
└── logs/                           # アプリケーション ログ
```

### 2. JSONデータ管理

#### ファイル一覧
```
データ型                      用途
────────────────────────────────────────────
performances.json           演奏会情報 (CRUD)
schedules.json             練習スケジュール (CRUD)
announcements.json         お知らせ (CRUD)
members.json               メンバー (CRUD)
events.json                イベント調整 (CRUD)
auth_devices.json          認証デバイス (Append/Delete)
────────────────────────────────────────────
(Extra Data) 
payments.json              支払い状況
castings.json              乗り番表
piece_infos.json           楽曲情報
absences.json              欠席連絡
event_responses.json       イベント回答
albums.json                アルバム
part_settings.json         パート設定
venue_settings.json        会場設定
org_settings.json          団体設定
sns_settings.json          SNS設定
sheet_library.json         楽譜ライブラリ
recording_metadata.json    録音メタデータ
desired_pieces.json        演奏希望曲
────────────────────────────────────────────

* キャッシュ戦略: MemoryCache + IndexedDB + ETag
* ファイル更新: アトミック更新（.tmp ファイル経由）
* GCS同期: storage_enabled() チェック後、自動保存
```

### 3. キャッシュ戦略

#### 3.1 サーバー側キャッシュ
```
┌─────────────────────────────┐
│   MemoryCache クラス        │ (in Python)
│ ┌─────────────────────────┐ │
│ │ _cache (dict)           │ │ JSONデータ保持
│ │ _etags (dict)           │ │ SHA256 ハッシュ
│ │ _indexes (dict)         │ │ ID/名前インデックス
│ └─────────────────────────┘ │
└─────────────────────────────┘

効果:
・JSON読み込みスキップ（10-100倍高速）
・ETag検証で304レスポンス（80%トラフィック削減）
・インデックス検索でO(n)→O(1)化
```

#### 3.2 クライアント側キャッシュ
```
┌────────────────────────────────┐
│   IndexedDB キャッシュ         │ (in Browser)
│ ┌────────────────────────────┐ │
│ │ bootstrap_cache store      │ │
│ │  - key: API endpoint URL   │ │
│ │  - data: JSON response     │ │
│ │  - etag: ETag ハッシュ      │ │
│ │  - timestamp: 保存時刻      │ │
│ └────────────────────────────┘ │
└────────────────────────────────┘

効果:
・起動2回目で30%以上高速化
・304 Not Modified でローカル復帰
・オンデマンドで更新（POST/PUT/DELETE後クリア）
```

#### 3.3 ブラウザキャッシュ
```
Cache-Control ポリシー:

静的ファイル (.js, .css, .png等):
  → Cache-Control: public, max-age=3600 (1時間)

index.html:
  → Cache-Control: no-store (常に新規取得)

API レスポンス:
  → ETag 対応（304 Not Modified）
  → 実ボディ変更時のみ更新
```

---

## 性能最適化

### 1. 実装された最適化

#### 1.1 バックエンド
- **メモリキャッシング**: JSONをメモリに保持（10-100倍高速化）
- **ETag対応**: 304レスポンスでトラフィック80%削減
- **インデックス化**: ID検索O(1)化
- **GZip圧縮**: テキストレスポンス60-80%圧縮

#### 1.2 フロントエンド
- **IndexedDB永続化**: 2回目以降の起動30%以上短縮
- **画像遅延読み込み**: loading="lazy" 属性
- **段階的データ読み込み**:
  - ステップ1: bootstrap-lite (軽量)
  - ステップ2: bootstrap-core (バックグラウンド)
  - ステップ3: bootstrap (フルデータ)

### 2. パフォーマンス指標

| メトリクス | 改善前 | 改善後 | 削減率 |
|-----------|-------|-------|-------|
| 初回ログイン | 5-10秒 | 1-3秒 | 70% |
| 再訪問（未変更） | ~500ms | <10ms | 98% |
| 検索（1000項目） | O(n) | O(1) | 99%+ |
| ネットワークトラフィック | 100% | 20% | 80% |

### 3. 継続的な最適化案

1. **Service Worker**: オフライン対応
2. **WebP画像**: さらに20-30%削減
3. **Code Splitting**: JavaScript バンドル分割
4. **Database**: SQLiteへの移行（仕様変更）

---

## セキュリティ

### 1. 認証セキュリティ
- **デバイスID**: UUID ベースの一意識別
- **パスワードハッシング**: PBKDF2-SHA256 + ソルト（標準ライブラリ `hashlib` + `secrets` 使用、追加パッケージ不要）
  - 新規設定時: 常にハッシュ化して保存
  - 既存平文パスワード: ログイン成功後に自動的にハッシュ化して上書き保存（移行不要）
  - 形式: `pbkdf2$sha256$<iterations>$<salt>$<hex_hash>`
  - イテレーション数: 260,000 回（OWASP 2023 推奨値）
- **CORS**: 環境変数 `CORS_ORIGINS` でカンマ区切りで許可オリジンを指定可能
  - 未設定時は `*`（ローカル開発向け）
  - 本番環境では `CORS_ORIGINS=https://sites.google.com,https://xxxxx.run.app` のように設定する

### 2. データ保護
- **HTTPS**: 本番環境での必須
- **GCS認証**: Service Account キー管理
- **JSONアトミック更新**: .tmp ファイル経由で破損防止

### 3. 推奨改善項目
- [ ] パスワードのハッシング（bcrypt など）
- [ ] CORS の制限
- [ ] レート制限
- [ ] 監査ログ記録
- [ ] SQL Injection 対策（JSONのため現在無関連）

---

## デプロイメント

### 1. ローカル開発
```bash
uv sync
uv run python src/backend/main.py
# http://0.0.0.0:8000
```

### 2. Docker デプロイ
```dockerfile
FROM python:3.10-slim
WORKDIR /app
COPY . .
RUN pip install -r src/backend/requirements.txt
CMD ["uvicorn", "src.backend.main:app", "--host", "0.0.0.0"]
```

### 3. Google Cloud Run
```bash
gcloud run deploy orchestra-tool \
  --source . \
  --platform managed \
  --region asia-northeast2
```

### 4. 環境変数
```
GOOGLE_CLOUD_STORAGE_BUCKET     # GCS バケット名
GOOGLE_CLOUD_PROJECT            # GCP プロジェクトID
GOOGLE_CLOUD_STORAGE_DATA_PREFIX # JSON保存プレフィックス（空文字可）
GOOGLE_SERVICE_ACCOUNT_JSON     # GCS 認証JSON
GOOGLE_SERVICE_ACCOUNT_FILE     # サービスアカウントJSONファイルパス
GOOGLE_CLOUD_STORAGE_PUBLIC     # 公開設定
LOG_LEVEL                        # ログレベル (INFO, DEBUG)
```

---

## トラブルシューティング

### 1. よくある問題

| 問題 | 原因 | 解決策 |
|------|------|--------|
| ffmpeg エラー | ffmpeg 未インストール | ffmpeg をシステムにインストール |
| GCS 接続失敗 | 認証情報なし | サービスアカウントキーを設定 |
| キャッシュ古い | ETag ズレ | キャッシュをクリア（F5で再読み込み） |
| ファイルアップロード失敗 | ディスク容量 | 容量確認、古いファイル削除 |

### 2. ログ確認
```
./logs/ ディレクトリを確認
標準エラー出力を監視
```

---

## 14. JSON->PostgreSQL移行時の外部キー順序

- 移行スクリプトは、外部キー制約に合わせて親テーブルを先にINSERTする。
- `payments.performance_fees` / `payments.performance_fee_amounts` から生成する `payment_performance_fees` は、必ず `payments` の後にINSERTする。

---

## バージョン履歴

| 版 | 日付 | 変更内容 |
|----|------|---------|
| 1.1 | 2026-06-18 | 接続設定の旧環境変数自動移行を追記 |
| 1.0 | 2026-06-17 | 初版 - 性能最適化実装済み |

---

**作成**: 2026-06-17  
**保守者**: Infrastructure Team  
**ライセンス**: MIT
