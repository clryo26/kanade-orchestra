# 奏オケポータル Web設計書

最終更新: 2026-06-19

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
- ローディング状態の視覚化（ナビバー下にプログレスバーと状態テキスト表示）
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
- エキストラ権限では団員メニューの「支払状況」「イベント調整」「日程調整」「演奏希望曲」を非表示にする
- 非公開緊急ログイン（Administrator）を実装

関連 API:

- POST /api/auth/portal-login
- POST /api/auth/member-password
- GET /api/auth/devices/{device_id}
- GET /api/auth/devices
- DELETE /api/auth/devices/{device_id}

## 5. メニュー仕様

### 5.1 団員メニュー

グループ配置:

- 演奏会情報グループに「乗り番表」を配置
- 楽団情報（`${orgShortName()}情報`）グループに「イベント調整」を配置

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
- 練習指示管理
- 団員登録
- 支払状況登録
- 会場管理
- 乗り番管理
- 楽譜管理
- 日程調整

### 5.3 システム管理メニュー

- 認証端末管理
- 団体情報管理
- SNS情報
- 接続先情報
- パート管理
- データメンテナンス（孤立データ検出・削除）

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

- 録音アップロード時の曲名は、選択した演奏会に登録されている曲目からコンボボックスで選択する
- 録音の保存フォルダ名と画面表示の曲名は、曲目に略称が登録されている場合は略称を優先する

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
- ポータル表示: 演奏会ごと・曲ごとにセクション分割し、出演者をパートごとグルーピングして表形式表示
  - 団員名は各パート内で縦並び表示
  - パート順は part_settings の登録順に準拠
  - エキストラは `extras[].part` フィールドでグルーピング（未設定時は「エキストラ」表示）

### 6.8 イベント調整

- 団員側でイベント作成
- 参加/不参加回答
- 回答一覧表示
- 削除合言葉による削除保護

### 6.9 日程調整

- 調整さん形式で候補日を複数登録
- 候補日の並び替え（上下移動）
- 団員ごとに候補日へ ○ / △ / × で回答
- 候補日ごとの集計、回答者一覧を表示
- 候補日ごとの回答コメント集計を表示
- 候補日ごとの頻出キーワードを表示
- 回答一覧で「コメントあり回答のみ抽出」フィルタを提供
- 候補日をスコア（○=2, △=1, ×=0）で順位付けして第1候補を表示
- 未回答団員を抽出して一覧表示し、リマインド文面コピーを提供
- 作成者または管理者が削除可能（合言葉設定時は入力必須）

### 6.10 楽曲情報

- 演奏会と曲の紐付け情報
- 説明文管理
- 団員側は一覧/詳細表示

### 6.11 練習指示

- 演奏会と曲ごとの練習時の指摘内容を管理
- 団員側は「練習時の指摘内容が登録された曲」のみを演奏会ごとに一覧表示
- 曲名を選択すると、選択した曲の練習時の指摘内容を詳細表示
- 一覧順は、演奏会日付の新しい順 / 曲は演奏会に登録された曲目順

### 6.12 演奏希望曲

- 団員投稿（曲名、作曲者、演奏時間、ジャンル、編成、備考）
- 投票機能
- 投稿者のみ編集・削除

### 6.13 宣伝

- タイトル、概要、画像投稿
- 投稿者情報保持
- 投稿者のみ編集・削除

### 6.14 団体・SNS・接続設定

- 団体名、略称、アイコン
- SNS URL 群
- Google 接続情報を JSON 管理
  - project
  - bucket
  - data prefix
  - public flag
  - service account file/json

### 6.15 アルバム

- 団員が自由にアルバムイベント（イベント名）を作成できる
- 各イベントに対して複数の写真をアップロード
- 写真は Google Cloud Storage に保存し、公開 URL を取得して albums JSON に記録
- 写真はイベントページで gallery 表示（lazy loading）
- 写真表示は `/api/albums/{album_id}/photos/{photo_id}` 経由で配信し、Cloud/ローカル保存差を吸収
- イベント削除・写真削除は管理者のみ可能
- イベント一覧は作成日降順（新しいものが上）
- データ構造: `{ id, event_name, created_by_member_id, created_by_member_name, created_at, updated_at, photos: [{ id, filename, url, uploaded_by_member_id, uploaded_by_member_name, uploaded_at }] }`

### 6.16 Cloud Run リビジョン表示

- バックエンドが Cloud Run 標準の `K_REVISION` を優先して読み込み、後方互換として `CLOUD_RUN_REVISION` も参照して bootstrap レスポンスに `cloudRunRevision` フィールドを含める
- フロントは `updateCloudRunRevision()` でドロワーの Rev. 表示を動的更新し、`kanade-orchestra-00060-hsf` のような値は `00060-hsf` と表示する
- 新しいリビジョンでデプロイするたびに自動的に展示内容が切り替わる

### 6.17 データメンテナンス

- システム管理メニュー「データメンテナンス」から実行
- 「孤立データをスキャン」ボタンで `/api/maintenance/orphans` を呼び出し、孤立データをチェックボックス付き一覧で表示
- 孤立判定は親ID参照の実在確認のみで行い、IDの型差（数値/文字列）は正規化して判定
- 参照ID未設定（空文字/None）のデータは孤立扱いにしない
- 各アイテムを個別選択して「選択した項目を削除」ボタンで削除
- 削除後に自動再スキャンを実行し結果を更新
- 検出対象: castings / absences / payments / piece_infos / practice_instructions / desired_pieces / event_responses / date_adjustment_responses
- 管理者専用機能

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

### 7.2 追加運用コレクション

- connection_settings: 接続先設定
- promotions: 宣伝投稿
- practice_instructions: 練習指示
- date_adjustments: 日程調整本体
- date_adjustment_responses: 日程調整回答

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

更新系は `X-Device-Id` を必須とし、コレクション単位で認可を適用。

- 管理者限定: connection_settings / practice_instructions / piece_infos / castings / payments / sheet_library ほか
- 所有者更新可: date_adjustments / date_adjustment_responses / absences / event_responses

PUT では `expected_updated_at` を受け付け、サーバの `updated_at` と不一致時は 409 を返す。

### 8.8 アルバム写真

- POST /api/extra/albums/{album_id}/photos  （全員可、GCS へ保存）
- DELETE /api/extra/albums/{album_id}/photos/{photo_id}  （管理者専用）

### 8.9 データメンテナンス

- GET /api/maintenance/orphans  （管理者専用）
- POST /api/maintenance/cleanup  （管理者専用）

### 8.10 bootstrap 拡張

全 bootstrap API（bootstrap-lite / bootstrap-core / bootstrap）のレスポンスに以下を含む:

- `cloudRunRevision`: `CLOUD_RUN_REVISION` 環境変数の値（Google Cloud 自動設定）

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
