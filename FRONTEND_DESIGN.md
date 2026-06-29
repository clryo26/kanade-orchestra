# 奏オケポータル フロントエンド設計書

版: 2.0
最終更新: 2026-06-29

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
- member
- payment-admin
- venue-admin
- casting-admin
- sheet-admin

### 3.5 演奏会情報管理

- 管理側と団員側の演奏会情報では、曲目一覧を略称ではなく正式名称（作曲者: 曲名）で表示する
- チラシ画像ファイル欄は曲目一覧の下に配置する

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
- bootstrap 系の 304 判定は、バックエンドが全コレクション合成 ETag で行う

### 6.2 エラーハンドリング

- API エラーは showAlert でユーザー通知
- 保存/削除ボタンは withButtonStatus で連打防止

## 7. 機能別 UI 仕様

### 7.0 共通表示

- 練習予定などの時刻表示は `HH:MM` 形式に統一し、DB由来の `HH:MM:SS` は画面表示前に秒を省く

### 7.1 楽譜ビューア

- PDF.js を遅延ロード
- 拡大/縮小/幅合わせ
- DL 導線
- 楽譜ライブラリの演奏会名・曲名見出しは左寄せで表示する

### 7.2 支払状況

- 支払設定で月額団費と演奏会費の金額を管理
- 支払管理では団費支払済み月、最新支払日、演奏会費支払済み有無だけを管理
- 団員向け支払状況では金額を出さず、団費の支払済み月と演奏会費の支払済み/未払いを表示する
- 滞納判定を表示

### 7.3 団員登録

- 登録済み団員一覧ではパスワード値を表示せず、設定済み/未設定のみ表示する
- パスワード入力欄は再設定用とし、団員選択時は空のままにする

### 7.4 乗り番管理

- 演奏会単位で編集
- 団員とエキストラを別リスト管理

### 7.5 宣伝

- タイトル/概要/画像投稿
- 投稿者のみ編集削除

### 7.6 練習指示

- 管理画面の入力項目は「練習時の指摘内容」のみ
- 団員画面は「練習時の指摘内容が登録済みの曲名」のみを演奏会ごとに一覧表示
- 団員が曲名を選択すると、選択曲の練習時の指摘内容を詳細表示
- 一覧順は演奏会日付の新しい順、曲名は演奏会の曲目順

### 7.6 楽曲情報

- 管理画面では登録せず、団員画面で練習指示と同じ導線を使う
- 未開催演奏会に登録済みの曲を一覧表示し、登録済みの曲には「情報あり」目印を表示する
- 団員が曲名を選択すると、選択曲の楽曲情報を登録・編集・削除できる

## 8. コメント規約

- 各関数の直前に責務コメントを置く
- 共有状態変数は用途コメントを明記
- 実装変更時にコメントを必ず同期更新する

## 9. 参照

- DESIGN_WEB.md
- API_DATABASE_SPEC.md

## 10. 録音管理追記

- 録音アップロード UI は uploadPerformance と uploadPiece を連動させ、選択演奏会の登録曲目だけを uploadPiece に表示する
- uploadPiece の表示名は正式名称（作曲者: 曲名）を使用し、option value は保存フォルダ名に使う略称優先の曲名を保持する
- uploadPiece には録音管理専用の分類として「練習全体の通し」を追加し、曲単位でない通し録音を登録できるようにする
- 曲目表示名と録音保存フォルダ名は、曲目の alias/short_name があれば略称を優先する

## 11. エキストラ権限メニュー

- currentUserPermission が「エキストラ」の場合、member-payment/member-event/member-date-adjustment/member-desired-piece はホームメニュー、ドロワー、固定タブから非表示にする
- 非表示対象タブへ直接切り替えようとした場合は member-home に戻す
