# 奏オケポータル Web設計書

## 1. 概要

奏オケポータルは、福岡奏オーケストラ向けの Web アプリケーションである。
団員向け情報参照、団員自身の入力機能、管理者運用機能、システム管理機能を 1 つのポータルに統合している。

現行実装は以下を満たす。

- 団員ログインと端末認証
- 団員メニューの情報参照と各種登録
- 管理者メニューでの業務データ管理
- システム管理メニューでの運用設定管理
- ローカル JSON 永続化と Google Cloud Storage 連携
- Cloud Run 配備を想定した FastAPI 構成

## 2. アーキテクチャ

### 2.1 フロントエンド

- HTML: src/index.html
- CSS: src/static/css/style.css
- JavaScript: src/static/js/app.js
- UI ライブラリ: Bootstrap 5

特徴:

- SPA 方式（タブ切替ベース）
- appState による単一状態管理
- 初期表示高速化のための二段階ロード
- GET 通信の ETag + IndexedDB キャッシュ

### 2.2 バックエンド

- FastAPI: src/backend/main.py
- Storage 連携: src/backend/drive_storage.py
- 音声処理: pydub + imageio-ffmpeg

特徴:

- JSON コレクションベース CRUD
- 起動時プリロードによるメモリキャッシュ
- ETag を使った bootstrap 応答最適化
- Cloud Storage 有効時の JSON 同期とファイル配信

## 3. 画面構成

### 3.1 共通 UI

- ヘッダー: ブランド表示、ドロワートグル
- サイドドロワー: メニュー遷移、マニュアル、ログアウト、更新
- トーストエリア: 操作結果通知

### 3.2 パネル構成

- 団員パネル: memberPanel
- 管理パネル: adminPanel
- システム管理パネル: systemPanel
- ログインパネル: portalLoginPanel

## 4. 権限・認証設計

### 4.1 権限種別

- 一般
- エキストラ
- 管理者
- システム管理者

補助権限:

- 録音担当
- 楽譜担当

### 4.2 認証方式

- 団員名 + パート + パスワードでログイン
- 端末 ID を auth_devices に保存し再認証を簡略化
- エキストラ権限は system_access_until で期限管理
- 非公開緊急ログイン（Administrator）を実装

関連 API:

- POST /api/auth/portal-login
- POST /api/auth/member-password
- GET /api/auth/devices/{device_id}
- GET /api/auth/devices
- DELETE /api/auth/devices/{device_id}

## 5. メニュー仕様

### 5.1 団員メニュー

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

### 5.2 管理者メニュー

- 録音管理
- 演奏会情報
- 練習予定
- お知らせ
- イベント調整（管理者側は主に確認/削除）
- 楽曲情報管理
- 団員登録
- 支払状況登録
- 会場管理
- 乗り番管理
- 楽譜管理

### 5.3 システム管理メニュー

- 認証端末管理
- 団体情報管理
- SNS情報
- 接続先情報
- パート管理

## 6. 主要機能詳細

### 6.1 演奏会情報

- 基本情報: タイトル、日付、開場、開演、会場、指揮者
- 曲目管理: 曲名、略称、作曲者、アンコール属性
- チラシ画像登録

### 6.2 練習予定

- 演奏会紐付け
- 日付、開始終了、利用可能時間、会場、練習曲
- 指揮トレ、本番、備考
- Google カレンダー連携、ICS 出力

### 6.3 録音管理

- 音声アップロード（ローカル + Cloud）
- 一覧表示、再生、ダウンロード、ZIP 一括 DL
- Cloud 配信時の Range 対応
- 再生時間メタデータ保持

### 6.4 楽譜管理

- 演奏会/曲/PDF 登録
- 楽譜一覧の絞り込み表示
- 単体・曲単位・演奏会単位の DL
- 楽譜パート設定（単票/一括）
- PDF ビューア（拡大縮小、幅合わせ）

### 6.5 欠席連絡

- 団員本人の欠席/遅刻/早退登録
- 練習日単位の可視化
- 本人編集/削除

### 6.6 支払状況

- 団費支払い月（paid_until_month）
- 団員費用額（membership_fee_amount）
- 演奏会費支払い有無（performance_fees）
- 演奏会費金額（performance_fee_amounts）
- 滞納警告表示

### 6.7 乗り番管理

- 演奏会単位の乗り番レコード
- 団員リストとエキストラリストを別管理
- エキストラ情報: 名前、ふりがな、パート

### 6.8 イベント調整

- 団員側でイベント作成
- 参加/不参加回答
- 回答一覧表示
- 削除合言葉による削除保護

### 6.9 楽曲情報

- 演奏会と曲の紐付け情報
- 説明文管理
- 団員側は一覧/詳細表示

### 6.10 演奏希望曲

- 団員投稿（曲名、作曲者、演奏時間、ジャンル、編成、備考）
- 投票機能
- 投稿者のみ編集・削除

### 6.11 宣伝

- タイトル、概要、画像投稿
- 投稿者情報保持
- 投稿者のみ編集・削除

### 6.12 団体・SNS・接続設定

- 団体名、略称、アイコン
- SNS URL 群
- Google 接続情報を JSON 管理
  - project
  - bucket
  - data prefix
  - public flag
  - service account file/json

## 7. データ設計

### 7.1 JSON コレクション

main.py で管理する現行 JSON_DATA_NAMES:

- performances
- schedules
- announcements
- drive_files
- events
- members
- absences
- event_responses
- sheet_library
- payments
- castings
- piece_infos
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

### 7.2 追加運用コレクション

- connection_settings: 接続先設定
- promotions: 宣伝投稿

## 8. API 設計

### 8.1 基本

- GET /
- GET /api/health

### 8.2 bootstrap

- GET /api/bootstrap-lite
- GET /api/bootstrap-core
- GET /api/bootstrap

### 8.3 基本 CRUD

- /api/performances
- /api/schedules
- /api/members
- /api/events
- /api/announcements

各コレクションで GET/POST/PUT/DELETE を提供。

### 8.4 録音

- POST /api/convert
- GET /api/recordings
- GET /api/recordings/download-zip
- GET /api/recordings/play/{path}
- GET /api/recordings/download/{path}
- DELETE /api/recordings
- GET /api/recordings/cloud/play/{object_name}
- GET /api/recordings/cloud/download/{object_name}

### 8.5 Cloud 録音

- POST /api/drive/upload
- GET /api/drive/files

### 8.6 楽譜

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

### 8.7 汎用 extra

- GET /api/extra/{name}
- POST /api/extra/{name}
- PUT /api/extra/{name}/{item_id}
- DELETE /api/extra/{name}/{item_id}

対象 name は EXTRA_COLLECTIONS で制限。

## 9. パフォーマンス設計

### 9.1 バックエンド

- MemoryCache による JSON キャッシュ
- ID/ログイン名インデックス
- bootstrap 系 ETag 応答

### 9.2 フロントエンド

- 初期表示は bootstrap-lite 優先
- in-flight GET 重複排除
- IndexedDB キャッシュ利用
- 重い一覧は遅延ロード

## 10. 配備・運用

### 10.1 実行

- 開発時: uv run python src/backend/main.py
- Uvicorn 実行時は PORT 環境変数を参照（既定 8080）

### 10.2 公開

- Cloud Run で公開
- Google Sites への埋め込み運用を想定

### 10.3 キャッシュ更新

- index.html の app.js/style.css はバージョン付きクエリで更新制御
- index.html は no-store、静的アセットは短期キャッシュ

## 11. 今後の保守方針

- 新機能追加時は appState、API、JSON コレクション定義、設計書を同時更新
- 権限分岐が増える機能は必ず認可ルールを設計書へ明記
- 画面追加時は団員/管理者/システム管理のどの導線に属するかを明記
