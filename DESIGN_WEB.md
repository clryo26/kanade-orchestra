# 奏オケポータル Web設計書

## 1. 概要

奏オケポータルは、福岡奏オーケストラの団員向け情報共有と管理作業を行うWebアプリケーションである。

主な用途は以下。

- 団員向けのお知らせ、演奏会情報、練習予定、録音データの閲覧
- 欠席連絡、楽譜ライブラリ、支払状況、乗り番表、イベント調整、楽曲情報、アルバムの共有
- 管理者による録音管理、演奏会情報、練習予定、お知らせ、団員登録の管理
- Google Sites への埋め込み、Cloud Run での公開
- iPhoneホーム画面追加時のPWA風アイコン表示

ポータル名は「奏オケポータル」とする。

## 2. 画面構成

### 2.1 共通ヘッダー

- 左側に奏オケアイコンと「奏オケポータル」を表示する。
- 右側に「更新」ボタンを表示する。
- 「更新」ボタンはアプリ内データ再取得ではなく、ブラウザの更新ボタンと同じ `window.location.reload()` を実行する。
- 管理メニューへの入口は団員メニュー末尾に配置する。

### 2.2 初期表示

- 初期表示は団員メニューのみ。
- 初期タブは「お知らせ」。
- 管理メニューはパスワード入力後に表示する。

### 2.3 団員メニュー

団員メニューのタブは以下。

- お知らせ
- 演奏会情報
- 練習予定
- 録音部屋
- 団員紹介
- SNS
- 演奏会記録
- 欠席連絡
- 楽譜ライブラリ
- 支払状況
- 乗り番表
- イベント調整
- 楽曲情報
- アルバム
- 管理メニュー

### 2.4 管理メニュー

管理メニューのタブは以下。

- 録音管理
- 演奏会情報
- 練習予定
- お知らせ
- 団員登録

管理メニューはフロント側で簡易パスワードロックする。現状のパスワードは `kanadeadmin`。

## 3. フロントエンド設計

### 3.1 技術構成

- HTML
- CSS
- Vanilla JavaScript
- Bootstrap 5

### 3.2 主要ファイル

- `src/index.html`
  - 画面の基本HTML
  - favicon、apple-touch-icon、manifest指定
- `src/static/css/style.css`
  - レイアウト、カード、録音一覧、プロフィール、アルバム等のスタイル
- `src/static/js/app.js`
  - 画面状態管理、API通信、各タブの描画、イベント処理
- `src/static/icons/*`
  - PWA/ホーム画面用アイコン
- `src/static/manifest.webmanifest`
  - ホーム画面追加時の名称・アイコン定義

### 3.3 アイコン

アイコンはユーザー提供画像を元に作成したPNGを使用する。

- favicon: `/static/icons/favicon-32x32.png`
- iPhoneホーム画面: `/static/icons/apple-touch-icon.png`
- PWA manifest: `/static/icons/icon-192.png`, `/static/icons/icon-512.png`
- 元画像保存: `/static/icons/kanade-original.png`

iPhoneでホーム画面に追加した場合は `apple-touch-icon.png` が表示される。

## 4. バックエンド設計

### 4.1 技術構成

- Python 3.10+
- FastAPI
- Uvicorn
- pydub / imageio-ffmpeg
- Google Cloud Storage
- Google Drive API互換の既存命名API
- JSONファイルによるローカル永続化

### 4.2 主要ファイル

- `src/backend/main.py`
  - FastAPIアプリ本体
  - API定義
  - 録音ファイル、ポータルデータ、アップロードファイル管理
- `src/backend/drive_storage.py`
  - Google Cloud Storage / Drive関連処理
- `src/backend/requirements.txt`
  - Python依存関係

### 4.3 データ保存

ローカル開発時は `src/data/*.json` に保存する。

Google Cloud Storage設定がある場合は、JSONデータをCloud Storageへ保存する。

対象データは以下。

- `performances`
- `schedules`
- `announcements`
- `drive_files`
- `absences`
- `sheet_library`
- `payments`
- `rosters`
- `events`
- `event_responses`
- `song_info`
- `albums`
- `members`

## 5. API設計

### 5.1 基本API

- `GET /api/health`
- `GET /`

### 5.2 演奏会情報

- `GET /api/performances`
- `POST /api/performances`
- `GET /api/performances/{performance_id}`
- `PUT /api/performances/{performance_id}`
- `DELETE /api/performances/{performance_id}`

曲目は以下を保持できる。

```json
{
  "composer": "チャイコフスキー",
  "title": "交響曲第5番",
  "alias": "チャイ5"
}
```

### 5.3 練習予定

- `GET /api/schedules`
- `POST /api/schedules`
- `GET /api/schedules/{schedule_id}`
- `PUT /api/schedules/{schedule_id}`
- `DELETE /api/schedules/{schedule_id}`

練習場所は以下から選択する。

- 千早音楽練習場　大練習室
- 千早音楽練習場　中練習室
- パピオ
- その他

「その他」を選択した場合は任意の練習場所を入力する。

### 5.4 お知らせ

- `GET /api/announcements`
- `POST /api/announcements`
- `GET /api/announcements/{announcement_id}`
- `PUT /api/announcements/{announcement_id}`
- `DELETE /api/announcements/{announcement_id}`

### 5.5 録音

- `GET /api/recordings`
- `GET /api/recordings/play/{path}`
- `GET /api/recordings/download/{path}`
- `POST /api/recordings/download-zip`
- `DELETE /api/recordings`
- `GET /api/recordings/cloud/play/{object_name}`
- `GET /api/recordings/cloud/download/{object_name}`

録音再生は以下を考慮する。

- 再生URLは日本語パスをURLエンコードする。
- ローカル再生APIはHTTP Rangeに対応し、`206 Partial Content` を返せる。
- ブラウザ側では再生ボタン押下時にaudio要素を作成し、`preload="auto"` と `play()` を使う。

### 5.6 アップロード

- `POST /api/drive/upload`
- `POST /api/drive/direct-upload-session`
- `POST /api/drive/direct-upload-complete`
- `GET /api/drive/files`

大きい音声ファイルはCloud Runのリクエストサイズ制限を避けるため、Google Cloud Storageへの直接アップロードを優先する。

### 5.7 ポータル汎用データ

- `GET /api/portal/{collection}`
- `POST /api/portal/{collection}`
- `PUT /api/portal/{collection}/{item_id}`
- `DELETE /api/portal/{collection}/{item_id}`

### 5.8 ポータルファイル

- `POST /api/portal-files/{kind}`
- `GET /api/portal-files/{kind}/{path}`

`kind` は以下。

- `sheets`
- `albums`
- `member_photos`

### 5.9 団員登録

- `POST /api/portal-members`

登録項目は以下。

- 写真
- 名前
- パート
- 入団年月
- 紹介者
- 役割
- 楽器歴
- 過去所属オケ
- コメント

登録された団員は団員紹介ページに表示される。

## 6. 機能仕様

### 6.1 演奏会情報

- 本番日、開場、開演、会場、指揮者、曲目を登録する。
- 曲目は作曲者、曲名、略称を登録できる。
- 団員メニューでは一番直近の演奏会までのカウントダウンを表示する。
- 日付表示には曜日を付ける。

### 6.2 練習予定

- 練習日、開始/終了時刻、利用可能時間、練習場所、練習曲、指揮者トレ、備考を登録する。
- 練習場所は選択式。
- 団員メニューではGoogleカレンダー追加ボタンを表示する。
- 日付表示には曜日を付ける。

### 6.3 欠席連絡

- 名前と練習日を選択して登録する。
- 各練習日ごとの欠席者を確認できる。

### 6.4 楽譜ライブラリ

- 演奏会、曲名、PDFファイルを登録する。
- PDFを閲覧、ダウンロードできる。

### 6.5 支払状況

- 団員名ごとに団費、演奏会費の支払い状況を登録、確認する。

### 6.6 乗り番表

- 演奏会、パート、乗り番メンバーを登録する。
- 演奏会ごとに本番に乗る人を確認できる。

### 6.7 イベント調整

- まずイベント名と日付を登録する。
- 登録済みイベントを選択すると、子画面で名前と参加/不参加を登録する。
- 登録済み回答はイベントごとに一覧表示する。

### 6.8 楽曲情報

- 演奏会ごとに曲名、作曲者や参考情報、注意点などのメモを登録する。

### 6.9 アルバム

- 写真タイトルと画像ファイルを登録する。
- 投稿者入力は不要。
- 写真は遅延読み込みする。

### 6.10 団員紹介

- 外部Google Sitesリンクやiframeではなく、ポータル内にプロフィールカードとして表示する。
- 管理メニューの団員登録データがある場合は、その内容を表示する。
- 未登録時は仮のプロフィールセクションを表示する。

## 7. デプロイ

### 7.1 Cloud Run

Dockerfileでコンテナ化し、Cloud Runへデプロイする。

### 7.2 Google Sites

Cloud Runで発行された `https://...run.app` のURLをGoogle Sitesへ埋め込む。

### 7.3 PWA/ホーム画面

iPhoneの「ホーム画面に追加」では以下を使う。

- 表示名: 奏オケポータル
- アイコン: `/static/icons/apple-touch-icon.png`

AndroidやChrome系では `manifest.webmanifest` の `icon-192.png` / `icon-512.png` を使う。

## 8. 運用メモ

- 再ビルドや再デプロイ後に新しい内容を確認する場合は、ポータルの「更新」ボタンを押す。
- 「更新」ボタンはブラウザ更新と同じ動作なので、HTML/JS/CSSの再取得にも使える。
- ブラウザやiPhoneのホーム画面アイコンはキャッシュされやすいため、反映が遅い場合は一度ホーム画面リンクを削除して追加し直す。
