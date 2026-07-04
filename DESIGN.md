# 奏オケポータル 全体設計書

最終更新: 2026-06-19

## 1. システム目的

奏オケポータルは、団員向け情報共有と運営管理業務を 1 つの Web システムに統合することを目的とする。

達成対象:

- 団員が日常的に必要な情報を即時参照できる
- 団員自身が欠席連絡やイベント回答などを入力できる
- 管理者が演奏会関連データを運用できる
- システム管理者が接続設定や権限基盤を管理できる

## 2. システム境界

### 2.1 フロント

- src/index.html
- src/static/js/app.js
- src/static/css/style.css

### 2.2 バック

- src/backend/main.py
- src/backend/drive_storage.py

### 2.3 永続化

- ローカル: src/data/*.json, src/uploads
- クラウド: Google Cloud Storage（設定有効時）

## 3. 役割モデル

### 3.1 ユーザー権限

- 一般
- エキストラ
- 管理者
- システム管理者

### 3.2 補助フラグ

- 録音担当
- 楽譜担当

### 3.3 認証方針

- 団員ログイン + 端末認証
- 端末情報は auth_devices へ保存
- エキストラは利用期限でアクセス制御

## 4. 画面体系

### 4.1 団員パネル

主要機能:

- お知らせ
- 演奏会情報
- 練習予定
- 録音部屋
- 欠席連絡
- 楽譜ライブラリ
- 支払状況
- 乗り番表
- イベント調整
- 楽曲情報
- 演奏希望曲
- 宣伝
- アルバム
- 団員紹介
- 演奏会記録
- SNS
- マニュアル

### 4.2 管理パネル

主要機能:

- 録音管理
- 演奏会情報管理
- 練習予定管理
- お知らせ管理
- イベント管理
- 楽曲情報管理
- 団員登録
- 支払状況登録
- 会場管理
- 乗り番管理
- 楽譜管理

### 4.3 システム管理パネル

主要機能:

- 認証端末管理
- 団体情報設定
- SNS 設定
- 接続先設定
- パート設定
- データメンテナンス（孤立データ検出・削除）

## 5. データ設計

### 5.1 管理対象コレクション

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

### 5.2 特記事項

- connection_settings を設定ソースの第一優先とし、環境変数はフォールバック
- recording_metadata で再生時間などを保持
- albums はイベント単位で写真配列（photos）を内包して管理
- bootstrap レスポンスに `cloudRunRevision` フィールドを含め Cloud Run リビジョンを画面に表示

## 6. API 構成

### 6.1 共通・起動

- GET /
- GET /api/health
- GET /api/bootstrap-lite
- GET /api/bootstrap-core
- GET /api/bootstrap

### 6.2 認証

- POST /api/auth/portal-login
- POST /api/auth/member-password
- GET /api/auth/devices/{device_id}
- GET /api/auth/devices
- DELETE /api/auth/devices/{device_id}

### 6.3 基本 CRUD

- /api/performances
- /api/schedules
- /api/members
- /api/events
- /api/announcements

### 6.4 録音

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

### 6.5 楽譜

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

### 6.6 汎用 extra

- GET /api/extra/{name}
- POST /api/extra/{name}
- PUT /api/extra/{name}/{item_id}
- DELETE /api/extra/{name}/{item_id}

### 6.7 アルバム写真

- POST /api/extra/albums/{album_id}/photos  （全員可、GCS へ保存）
- DELETE /api/extra/albums/{album_id}/photos/{photo_id}  （管理者専用）

### 6.8 データメンテナンス

- GET /api/maintenance/orphans  （管理者専用）
- POST /api/maintenance/cleanup  （管理者専用）

## 7. 非機能設計

### 7.1 性能

- メモリキャッシュとインデックスによる検索高速化
- ETag と IndexedDB による通信最適化
- 初期描画高速化のための段階ロード

### 7.2 可用性

- ローカル JSON を基準にクラウド同期
- Cloud 接続不可時はローカル処理継続

### 7.3 セキュリティ

- 端末単位認証の保存
- エキストラ期限切れ時のアクセス拒否
- extra コレクション名のホワイトリスト制御

## 8. 運用

### 8.1 配備想定

- Cloud Run 運用
- Google Sites 埋め込み利用

### 8.2 保守規約

- 実装変更時は API、データ定義、画面定義を同時に更新
- コメント規約に従い関数・変数の責務を明記
- 設計変更は DESIGN_WEB.md と本書の両方へ反映

## 9. 参照ドキュメント

- DESIGN_WEB.md: Web 実装詳細
- SYSTEM_DESIGN.md: システム横断設計
- FRONTEND_DESIGN.md: UI 詳細
- API_DATABASE_SPEC.md: API とデータ仕様
