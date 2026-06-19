# 奏オケポータル フロントエンド設計書

版: 2.0
最終更新: 2026-06-17

## 1. 概要

フロントエンドは SPA 構成で、src/static/js/app.js の appState を中心に画面を制御する。

## 2. 技術要素

- HTML: src/index.html
- CSS: src/static/css/style.css
- JavaScript: src/static/js/app.js
- UI: Bootstrap 5
- クライアントキャッシュ: IndexedDB
- デプロイ時の静的JS反映: index.html の app.js クエリバージョン（`?v=...`）を更新してキャッシュバスト

## 3. UI 構造

### 3.1 レイアウト

- 共通ヘッダー
- サイドドロワー
- サイドドロワー下部アクション（マニュアル/ログアウト/更新）はドロワー描画時に動的生成し、その場でイベントをバインド
- 団員パネル
- 管理パネル
- システム管理パネル

### 3.2 団員タブ

- member-home
- member-announce
- member-performance
- member-schedule
- member-recording
- member-absence
- member-sheet
- member-sheet-viewer
- member-payment
- member-casting
- member-event
- member-piece-info
- member-desired-piece
- member-promotion
- member-manual
- member-album
- member-intro
- member-concert-record
- member-sns

### 3.3 管理タブ

- upload
- performance
- schedule
- announcement
- event
- piece-info-admin
- member
- payment-admin
- venue-admin
- casting-admin
- sheet-admin

### 3.4 システム管理タブ

- system-auth
- system-org
- system-sns
- system-connection
- system-part

## 4. 状態管理

### 4.1 appState 方針

- 画面で扱う主要データを appState に集約
- render 系関数は appState から描画
- save 系関数は API 更新後に再取得して同期

### 4.2 主要状態

- マスタ系: performances, schedules, members, events, announcements
- 団員機能系: absences, payments, castings, pieceInfos, desiredPieces, promotions
- ファイル系: recordings, sheetLibrary
- 設定系: partSettings, venueSettings, orgSettings, snsSettings, connectionSettings
- 認証系: portalAuthVerified, currentUserPermission, currentUserMemberId
- UI 系: selectedSheetIds, castingEditing*, sheetFilters, sheetPdf*

## 5. 初期化・描画戦略

### 5.1 起動フロー

1. DOMContentLoaded
2. IndexedDB 初期化
3. 画面イベントバインド
4. 認証状態確認
5. 認証済みならポータル表示、未認証ならログイン表示

### 5.2 データロード

- 初期: bootstrap-lite
- 追従: bootstrap-core または bootstrap
- 重い一覧: 必要タブ表示時に遅延ロード

### 5.3 ローディング状態表示

- ポータル入場時（enterPortal）: 「読み込み中...」を表示
- 必須データロード中（loadEssentialData）: 「データを読み込んでいます...」に更新
- 追加データロード中（loadFullDataInBackground）: 「全データを取得中...」に更新
- 更新ボタン押下時: 「更新中...」を表示して page reload
- ナビバー下に portalLoadingBar を表示、CSS でプログレスバーアニメーション

## 6. 通信設計

### 6.1 共通 request 関数

- GET: ETag 付き fetch、304 なら IndexedDB から復元
- GET: 同一 URL の in-flight 重複排除
- 更新系: 成功後に IndexedDB クリア

### 6.2 エラーハンドリング

- API エラーは showAlert でユーザー通知
- 保存/削除ボタンは withButtonStatus で連打防止

## 7. 機能別 UI 仕様

### 7.1 楽譜ビューア

- PDF.js を遅延ロード
- 拡大/縮小/幅合わせ
- DL 導線

### 7.2 支払状況

- 団費と演奏会費を同一画面で管理
- 滞納判定を表示

### 7.3 乗り番管理

- 演奏会単位で編集
- 団員とエキストラを別リスト管理

### 7.4 宣伝

- タイトル/概要/画像投稿
- 投稿者のみ編集削除

### 7.5 練習指示

- 管理画面の入力項目は「練習時の指摘内容」のみ
- 団員画面は「練習時の指摘内容が登録済みの曲名」のみを演奏会ごとに一覧表示
- 団員が曲名を選択すると、選択曲の練習時の指摘内容を詳細表示
- 一覧順は演奏会日付の新しい順、曲名は演奏会の曲目順

## 8. コメント規約

- 各関数の直前に責務コメントを置く
- 共有状態変数は用途コメントを明記
- 実装変更時にコメントを必ず同期更新する

## 9. 参照

- DESIGN_WEB.md
- API_DATABASE_SPEC.md
