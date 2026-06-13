# 奏オケポータル 全体設計書

## 1. 目的

奏オケポータルは、福岡奏オーケストラの団員向け情報共有と管理作業を一つにまとめるWebポータルである。

主な目的は以下。

- 団員が練習、演奏会、録音、楽譜、イベント、支払い、写真をインターネット経由で確認できること
- 管理者が演奏会情報、練習予定、お知らせ、録音、団員プロフィールを管理できること
- Google Sitesに埋め込めること
- Cloud Runで運用できること
- iPhoneホーム画面に追加したとき、奏オケのアイコンと名称で表示されること

## 2. システム名

- 表示名: 奏オケポータル
- iPhoneホーム画面名: 奏オケポータル
- manifest名: 奏オケポータル

## 3. 技術構成

### 3.1 フロントエンド

- HTML
- CSS
- Vanilla JavaScript
- Bootstrap 5

### 3.2 バックエンド

- Python 3.10+
- FastAPI
- Uvicorn
- pydub / imageio-ffmpeg
- Google Cloud Storage
- Google Drive API互換のアップロード処理

### 3.3 データ保存

- ローカル開発: `src/data/*.json`
- ファイル: `src/uploads/`
- Cloud Storage設定時: JSONと録音メタデータをCloud Storageへ同期

## 4. 主要ファイル

```text
src/
  index.html
  backend/
    main.py
    drive_storage.py
    requirements.txt
  static/
    css/style.css
    js/app.js
    icons/
      favicon-32x32.png
      apple-touch-icon.png
      icon-192.png
      icon-512.png
      kanade-original.png
    manifest.webmanifest
    site.webmanifest
  data/
  uploads/
```

## 5. 画面構成

### 5.1 初期表示

初期表示は団員メニューのみとし、「お知らせ」を表示する。

ヘッダーには以下を表示する。

- 奏オケアイコン
- 奏オケポータル
- 更新ボタン

更新ボタンはブラウザ更新と同じ `window.location.reload()` を実行する。

### 5.2 団員メニュー

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

### 5.3 管理メニュー

管理メニューはパスワード入力後に表示する。

- 録音管理
- 演奏会情報
- 練習予定
- お知らせ
- 団員登録

## 6. 機能一覧

### 6.1 録音管理

- WAV/MP3ファイルをアップロードできる。
- WAVはMP3へ変換する。
- MP3はそのまま保存できる。
- Google Cloud Storage直接アップロードに対応する。
- 録音一覧は練習日、曲名ごとにグルーピングする。
- 団員側では再生とダウンロードを提供する。
- 管理側では削除を提供する。
- 再生APIはHTTP Rangeに対応し、再生開始を速くする。
- 日本語パスをURLエンコードして再生URLを生成する。

### 6.2 演奏会情報

- タイトル
- 日付
- 開場時刻
- 開演時刻
- 会場
- 指揮者
- 曲目

曲目は以下を持つ。

- 作曲者
- 曲名
- 略称

入力例は以下。

- 作曲者: チャイコフスキー
- 曲名: 交響曲第5番
- 略称: チャイ5

団員メニューでは直近の演奏会までのカウントダウンを表示する。

### 6.3 練習予定

登録項目は以下。

- 練習日
- 開始時刻
- 終了時刻
- 練習場所
- 利用可能開始時刻
- 利用可能終了時刻
- 練習曲
- 指揮者トレ
- 備考

練習場所は以下から選択する。

- 千早音楽練習場　大練習室
- 千早音楽練習場　中練習室
- パピオ
- その他

「その他」の場合は任意入力欄を表示する。

### 6.4 お知らせ

- 日付と本文を登録する。
- 団員メニューと管理メニューの両方で表示する。

### 6.5 団員紹介

- 外部リンクやiframeではなく、ポータル内にプロフィールカードを表示する。
- 管理メニューの団員登録データを利用する。
- 未登録時は仮プロフィールを表示する。

### 6.6 団員登録

管理メニューから以下を登録する。

- 写真
- 名前
- パート
- 入団年月
- 紹介者
- 役割
- 楽器歴
- 過去所属オケ
- コメント

写真は `member_photos` として保存し、団員紹介に表示する。

### 6.7 欠席連絡

- 名前と練習日を登録する。
- 練習日ごとの欠席者を表示する。

### 6.8 楽譜ライブラリ

- 演奏会、曲名、PDFを登録する。
- PDFの閲覧とダウンロードを提供する。

### 6.9 支払状況

- 団員ごとに団費、演奏会費の支払い状況を登録する。

### 6.10 乗り番表

- 演奏会、パート、乗り番メンバーを登録する。

### 6.11 イベント調整

- 最初にイベント名と日付を登録する。
- 登録済みイベントを選択すると、子画面で名前と参加/不参加を登録する。
- イベントごとに回答一覧を表示する。

### 6.12 楽曲情報

- 演奏会ごとに曲名、作曲者、参考情報、注意点などを登録する。

### 6.13 アルバム

- 写真タイトルと画像ファイルを登録する。
- 投稿者入力は不要。
- 写真は一覧で共有する。

## 7. 日付表示

画面表示では日付に曜日を付ける。

例:

```text
2026-06-13（土）
```

保存値は `YYYY-MM-DD` のままとする。

## 8. API概要

### 8.1 基本

- `GET /api/health`
- `GET /`

### 8.2 CRUD

- `/api/performances`
- `/api/schedules`
- `/api/announcements`
- `/api/portal/{collection}`

### 8.3 録音

- `GET /api/recordings`
- `GET /api/recordings/play/{path}`
- `GET /api/recordings/download/{path}`
- `POST /api/recordings/download-zip`
- `DELETE /api/recordings`
- `GET /api/recordings/cloud/play/{object_name}`
- `GET /api/recordings/cloud/download/{object_name}`

### 8.4 アップロード

- `POST /api/drive/upload`
- `POST /api/drive/direct-upload-session`
- `POST /api/drive/direct-upload-complete`
- `POST /api/portal-files/{kind}`
- `GET /api/portal-files/{kind}/{path}`
- `POST /api/portal-members`

## 9. PWA / iPhoneホーム画面

`src/index.html` で以下を指定する。

- `link rel="apple-touch-icon"`: `/static/icons/apple-touch-icon.png`
- `link rel="manifest"`: `/static/manifest.webmanifest`
- `theme-color`: `#235789`

`manifest.webmanifest` には以下を指定する。

- `name`: 奏オケポータル
- `short_name`: 奏オケ
- `icons`: `/static/icons/icon-192.png`, `/static/icons/icon-512.png`

## 10. デプロイ

### 10.1 Cloud Run

Dockerfileでコンテナ化してCloud Runへデプロイする。

### 10.2 Google Sites

Cloud RunのURLをGoogle Sitesへ埋め込む。

```html
<iframe
  src="https://...run.app/"
  width="100%"
  height="900"
  frameborder="0"
  allow="microphone"
  sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-top-navigation-by-user-activation"
></iframe>
```

## 11. 運用注意

- Cloud Runへ再デプロイしたあと画面が古い場合は、ポータルの「更新」ボタンを押す。
- iPhoneホーム画面アイコンはキャッシュされやすいため、変更が反映されない場合はホーム画面リンクを削除して追加し直す。
- 大容量録音はCloud Storage直接アップロードを優先する。
- 管理メニューのパスワードはフロント側簡易ロックなので、本格運用ではサーバー側認証の導入を検討する。
