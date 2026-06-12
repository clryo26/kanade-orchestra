# オーケストラ音声共有ツール 設計書（Web版）

## 現行実装仕様（2026-06-12時点）

### サービス名
- 画面表示名、ブラウザタイトルは **奏オケポータル**。
- 管理者メニューと団員メニューを同一Webアプリ内で切り替える。

### 技術構成
- フロントエンド: HTML / Bootstrap 5 / Vanilla JavaScript。
- バックエンド: FastAPI。
- 音声変換: pydub + ffmpeg。
- パッケージ管理: uv。
- 永続化: Google Cloud Storage。
- ローカル開発時は `src/data/*.json` と `src/uploads/` にも保存する。

### Google Cloud Storage構成
- 環境変数:
  - `GOOGLE_CLOUD_STORAGE_BUCKET`: 保存先バケット名。
  - `GOOGLE_CLOUD_STORAGE_DATA_PREFIX`: JSONデータ保存プレフィックス。既定値は `app-data`。
  - `GOOGLE_CLOUD_STORAGE_PUBLIC`: 音声オブジェクトを公開するか。既定値は `false`。
  - `GOOGLE_SERVICE_ACCOUNT_FILE`: ローカル開発用サービスアカウントJSON。
- 音声ファイル保存パス:
  - `{練習日}/{練習曲名}/{ファイル名}.mp3`
  - 例: `2026-06-06/オルガン付き/sample.mp3`
- アプリデータ保存パス:
  - `app-data/performances.json`
  - `app-data/schedules.json`
  - `app-data/announcements.json`
  - `app-data/drive_files.json`
- 起動時、GCS側にJSONが存在しない場合はローカルJSONから初回コピーする。

### 録音管理
- ドラッグ&ドロップは使用しない。
- `ファイルを選択` ボタンからWAV/MP3を複数一括選択できる。
- `録音ファイルを保存` 実行時の挙動:
  - WAVファイルは自動でMP3に変換して保存する。
  - MP3ファイルは変換せずそのまま保存する。
  - 変換品質は128/192/320kbpsから選択する。
  - 複数選択時は同一の練習日・練習曲名で順番に保存する。
- 管理者メニューの録音ファイル一覧:
  - 録音管理タブ内にのみ表示する。
  - `再生` と `削除` を提供する。
  - `削除` はGCS上の音声オブジェクトと `drive_files.json` のメタデータを削除する。
- 団員メニューの録音部屋:
  - `再生` と `DL` を提供する。
  - GCSが非公開でも、バックエンド経由のストリーミング/ダウンロードURLで扱う。

### 演奏会情報管理
- 登録項目:
  - タイトル
  - 開催日
  - 開場時間
  - 開演時間
  - 会場
  - 指揮者
  - 曲目リスト
- 曲目は1曲ごとに以下を登録する。
  - 作曲者
  - 曲名
- 既存の文字列配列形式の曲目データも読み込み時に `{ composer, title }` 相当へ正規化して表示する。

### 練習予定管理
- 登録項目:
  - 練習日
  - 練習開始時間
  - 練習終了時間
  - 場所
  - 利用可能開始時間
  - 利用可能終了時間
  - 練習曲
  - 備考
- 旧形式の `time` / `available_hours` も読み込み時に表示互換を維持する。

### お知らせ管理
- 登録項目:
  - 日付
  - 内容
- 管理者が作成・更新・削除し、団員メニューで閲覧する。

### APIエンドポイント
- ヘルスチェック:
  - `GET /api/health`
- 演奏会情報:
  - `GET /api/performances`
  - `POST /api/performances`
  - `GET /api/performances/{performance_id}`
  - `PUT /api/performances/{performance_id}`
  - `DELETE /api/performances/{performance_id}`
- 練習予定:
  - `GET /api/schedules`
  - `POST /api/schedules`
  - `GET /api/schedules/{schedule_id}`
  - `PUT /api/schedules/{schedule_id}`
  - `DELETE /api/schedules/{schedule_id}`
- お知らせ:
  - `GET /api/announcements`
  - `POST /api/announcements`
  - `GET /api/announcements/{announcement_id}`
  - `PUT /api/announcements/{announcement_id}`
  - `DELETE /api/announcements/{announcement_id}`
- 録音:
  - `GET /api/recordings`
  - `GET /api/recordings/play/{path}`
  - `GET /api/recordings/download/{path}`
  - `GET /api/recordings/cloud/play/{object_name}`
  - `GET /api/recordings/cloud/download/{object_name}`
  - `DELETE /api/recordings`
- 録音アップロード:
  - `POST /api/drive/upload`
  - API名は既存フロント互換のため `drive` のままだが、実体はGoogle Cloud Storage保存。
- 互換API:
  - `POST /api/convert`
  - 単体変換APIとして残すが、録音管理画面からは直接使用しない。
  - `GET /api/drive/files`

### 主要データモデル

#### Performance
```json
{
  "id": 1,
  "title": "第1回定期演奏会",
  "date": "2026-06-12",
  "open_time": "18:00",
  "start_time": "19:00",
  "venue": "ホール名",
  "conductor": "指揮者名",
  "pieces": [
    {
      "composer": "サン＝サーンス",
      "title": "交響曲第3番 オルガン付き"
    }
  ],
  "created_at": "...",
  "updated_at": "..."
}
```

#### Schedule
```json
{
  "id": 1,
  "date": "2026-06-12",
  "time": "13:00 - 16:30",
  "start_time": "13:00",
  "end_time": "16:30",
  "venue": "練習場所",
  "available_hours": "12:30 - 16:30",
  "available_start_time": "12:30",
  "available_end_time": "16:30",
  "pieces": "練習曲",
  "notes": "備考",
  "created_at": "...",
  "updated_at": "..."
}
```

#### Recording Metadata
```json
{
  "id": "2026-06-06/オルガン付き/sample.mp3",
  "name": "sample.mp3",
  "date": "2026-06-06",
  "piece": "オルガン付き",
  "size": 123456,
  "mime_type": "audio/mpeg",
  "modified_at": "...",
  "bucket": "kanade-storage",
  "object_name": "2026-06-06/オルガン付き/sample.mp3",
  "source": "google_cloud_storage"
}
```

---

## プロジェクト概要

オーケストラの団員向けに、Webブラウザから WAV形式の音声ファイルを MP3形式に変換し、Google Driveを経由で共有・再生できるWebアプリケーション。Google Sites内に埋め込み可能で、リハーサル音声やパート別録音などを効率的に共有・再生するための統合Webツール。

---

## 1. 機能要件

### 1.1 コア機能
- **WAVファイル読み込み**: ブラウザからのファイル選択またはドラッグ&ドロップ
- **MP3変換**: WAV → MP3 (品質設定可能)
- **再生機能**: 変換したMP3ファイルの再生・停止・一時停止
- **バッチ処理**: 複数ファイルの一括変換
- **ファイル管理**: 変換済みファイルの表示・削除

### 1.2 Google Drive統合機能
- **自動アップロード**: 変換完了後のMP3をGoogle Driveに自動保存
- **共有リンク生成**: ワンクリックで共有可能なリンク生成
- **アクセス管理**: 団員ごとのアクセス権限設定
- **共有履歴管理**: アップロード済みファイルの一覧表示
- **同期機能**: Google Drive内のファイルをブラウザで管理

### 1.3 Google Sites対応
- **iFrame埋め込み**: Google Sites に直接埋め込み可能
- **レスポンシブ対応**: スマートフォン・タブレット対応
- **OAuth連携**: Google アカウントでのシームレス認証

---

## 2. 技術スタック

### 2.1 環境
- **OS**: Windows11 / Linux / macOS（マルチプラットフォーム）
- **Python**: 3.10+
- **パッケージマネージャー**: UV
- **ホスティング**: Google Cloud Run
- **フロントエンド**: HTML5 / CSS3 / JavaScript

### 2.2 バックエンドライブラリ
| 用途 | ライブラリ | バージョン |
|------|----------|----------|
| Webフレームワーク | FastAPI | ^0.100.0 |
| WAV読み込み | librosa | ^0.10.0 |
| MP3エンコード | pydub | ^0.25.1 |
| Google Drive API | google-api-python-client | ^2.100.0 |
| 認証 | google-auth-oauthlib | ^1.1.0 |
| CORS対応 | python-multipart | ^0.0.6 |
| ログ管理 | loguru | ^0.7.0 |
| テスト | pytest / pytest-asyncio | latest |

### 2.3 フロントエンドライブラリ
- HTML5 Audio API（再生制御）
- Fetch API / XMLHttpRequest（API通信）
- Bootstrap 5 / Tailwind CSS（UI）

---

## 3. アーキテクチャ設計

### 3.1 全体構成

```
┌──────────────────────────────────────────────────────────┐
│                   Google Sites                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ <iframe src="https://orchestra-tool.cloud.run">   │  │
│  │   オーケストラ活動管理ツール                       │  │
│  │ </iframe>                                          │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
              ↓ (HTTPS + REST API)
┌──────────────────────────────────────────────────────────┐
│            Google Cloud Run (バックエンド)               │
│                                                          │
│  FastAPI Webサーバー + 音声処理エンジン                 │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │ /api/convert    - WAV→MP3 変換                  │  │
│  │ /api/player     - 再生管理                      │  │
│  │ /api/drive      - Google Drive 連携            │  │
│  │ /api/auth       - OAuth認証                     │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
│  ストレージ: Google Cloud Storage (一時ファイル)      │
└──────────────────────────────────────────────────────────┘
              ↓ (OAuth 2.0)
┌──────────────────────────────────────────────────────────┐
│         Google Drive / Google Cloud               │
│  • ファイルストレージ                                    │
│  • 認証サービス                                          │
└──────────────────────────────────────────────────────────┘
```

### 3.2 バックエンド構成

```
backend/
├── app/
│   ├── main.py                 # FastAPI アプリ初期化
│   ├── config.py               # 設定管理
│   │
│   ├── routes/
│   │   ├── converter.py         # 変換API
│   │   ├── player.py            # 再生API
│   │   ├── drive.py             # Drive連携API
│   │   └── auth.py              # OAuth認証
│   │
│   ├── core/
│   │   ├── audio_converter.py
│   │   ├── file_handler.py
│   │   └── metadata_handler.py
│   │
│   ├── cloud/
│   │   ├── google_drive_handler.py
│   │   ├── auth_manager.py
│   │   └── sync_manager.py
│   │
│   └── utils/
│       ├── logger.py
│       └── validators.py
│
├── frontend/
│   ├── index.html
│   ├── css/
│   │   ├── styles.css
│   │   └── responsive.css
│   └── js/
│       ├── app.js
│       ├── api-client.js
│       ├── converter.js
│       └── player.js
│
├── tests/
├── pyproject.toml
└── Dockerfile
```

---

## 4. API仕様

### 4.1 認証エンドポイント

```
POST /api/auth/login
- OAuth2 Google ログイン開始
- レスポンス: { auth_url: string, state: string }

POST /api/auth/callback
- OAuth2 コールバック処理
- パラメータ: code, state
- レスポンス: { access_token, user_info }

GET /api/auth/user
- 現在のユーザー情報取得
- ヘッダー: Authorization: Bearer <token>
- レスポンス: { email, name, picture }

POST /api/auth/logout
- ログアウト
```

### 4.2 変換エンドポイント

```
POST /api/convert/start
- WAV → MP3 変換開始
- リクエスト: multipart/form-data (file)
- レスポンス: { job_id, status, progress }

GET /api/convert/{job_id}
- 変換進捗取得
- レスポンス: { job_id, status, progress, file_url, error }

GET /api/convert/files
- 変換済みファイル一覧
- レスポンス: [{ file_id, name, size, created_at, download_url }]

DELETE /api/convert/{file_id}
- ファイル削除
- レスポンス: { success, message }
```

### 4.3 再生エンドポイント

```
GET /api/player/file/{file_id}
- MP3ファイル取得（ストリーミング）
- レスポンス: audio/mpeg stream

GET /api/player/metadata/{file_id}
- メタデータ取得
- レスポンス: { title, artist, duration, bitrate }
```

### 4.4 Google Drive 連携エンドポイント

```
POST /api/drive/upload
- Google Drive へアップロード
- パラメータ: file_id
- レスポンス: { drive_file_id, share_link }

GET /api/drive/files
- Drive上のアップロード済みファイル一覧
- レスポンス: [{ file_id, name, size, created_at, share_url }]

POST /api/drive/share/{file_id}
- 共有リンク生成
- パラメータ: access_type (viewer/commenter/editor)
- レスポンス: { share_url, access_type }

POST /api/drive/permissions/{file_id}
- 権限設定
- パラメータ: email, role
- レスポンス: { success, message }
```

---

## 5. フロントエンド設計

### 5.1 メインページ全体構成

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 🎼 オーケストラ活動管理ツール    [管理者メニュー] [団員メニュー] [Google認証] │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ◎ 管理者メニュー                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  [録音管理] [演奏会情報管理] [スケジュール管理] [お知らせ管理]      │ │
│  │  ※ 現在の画面は「録音管理」から呼び出される構成                    │ │
│  │                                                                       │
│  │  【録音アップロード】                                                │ │
│  │  ┌───────────────────────────────────────────────────────────────┐  │
│  │  │  練習日: [2026-06-11]    練習曲: [第1楽章を入力してください]       │  │
│  │  │  保存先: /2026-06-11/第1楽章/                                     │  │
│  │  │                                                               │  │
│  │  │  📄 WAV / MP3 をドラッグ&ドロップ                                │  │
│  │  │      または [ファイルを選択]                                    │  │
│  │  │  ⚙️ 変換設定: 192kbps / 320kbps  □ メタデータ自動補完            │  │
│  │  │  [🔄 変換開始]  [🗑️ クリア]  [☁️ 自動アップロード]               │  │
│  │  └───────────────────────────────────────────────────────────────┘  │
│  │                                                                       │
│  │  【演奏会情報管理】                                                  │ │
│  │  ┌───────────────────────────────────────────────────────────────┐  │
│  │  │  ・ タイトル: [演奏会の名称を入力]                               │  │
│  │  │  ・ 開催日: [2026-07-15]                                        │  │
│  │  │  ・ 開場時間: [18:00]                                           │  │
│  │  │  ・ 開演時間: [19:00]                                           │  │
│  │  │  ・ 場所: [会場名を入力]                                       │  │
│  │  │  ・ 指揮者: [指揮者名を入力]                                   │  │
│  │  │  [＋ 演奏会を追加]  [編集]  [削除]                              │  │
│  │  │  [▶️ 演奏曲を管理]                                           │  │
│  │  │  ・ ボタン押下で演奏曲登録ダイアログを展開                     │  │
│  │  │  ・ ダイアログ内で「曲名」「作曲者」を登録・編集できる          │  │
│  │  └───────────────────────────────────────────────────────────────┘  │
│  │                                                                       │
│  │  【スケジュール管理】                                                │ │
│  │  ┌───────────────────────────────────────────────────────────────┐  │
│  │  │  ・ 練習日: [2026-06-11]                                       │  │
│  │  │  ・ 時間: [13:00 - 16:00]                                      │  │
│  │  │  ・ 場所: [練習室A]                                             │  │
│  │  │  ・ 会場使用可能時間: [12:30 - 16:30]                          │  │
│  │  │  ・ 練習曲: [第1楽章 / 第2楽章]                                 │  │
│  │  │  ・ 備考: [備考を入力]                                          │  │
│  │  │  [＋ スケジュールを追加]  [編集]  [削除]                        │  │
│  │  └───────────────────────────────────────────────────────────────┘  │
│  │                                                                       │
│  │  【お知らせ管理】                                                  │ │
│  │  ┌───────────────────────────────────────────────────────────────┐  │
│  │  │  ・ 日付: [2026-06-11]                                         │  │
│  │  │  ・ お知らせ内容: [集合時間は18:30です]                        │  │
│  │  │  [＋ お知らせを追加]  [編集]  [削除]                          │  │
│  │  └───────────────────────────────────────────────────────────────┘  │
│  │                                                                       │
│  │  【曲リストエリア】                                                │ │
│  │  ┌───────────────────────────────────────────────────────────────┐  │
│  │  │  📋 曲一覧                                                       │  │
│  │  │  ┌─ ▶️ 2026-06-11                                              │  │
│  │  │  │    ┌─ ▶️ 第1楽章                                            │  │
│  │  │  │    │    ├─ ▶️ 01_Opening.mp3    3:45  [▶️][☁️]           │  │
│  │  │  │    │    ├─ ▶️ 02_1st.mp3        5:30  [▶️][☁️]           │  │
│  │  │  │    │    ├─ ▶️ 03_2nd.mp3        4:15  [▶️][☁️]           │  │
│  │  │  │    │    ├─ ▶️ 04_3rd.mp3        6:10  [▶️][☁️]           │  │
│  │  │  │    │    └─ ▶️ 05_Finale.mp3     7:20  [▶️][☁️]           │  │
│  │  │  └───────────────────────────────────────────────────────────┘  │
│  │  │  [↩️ ダウンロード]  [📤 全て共有]  [🗑️ 削除]  [🔁 更新]            │  │
│  │  └───────────────────────────────────────────────────────────────┘  │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ◎ 団員メニュー                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  [演奏会情報] [練習スケジュール] [録音部屋]                            │ │
│  │  ※ 現在の曲リストは「録音部屋」メニューから遷移する構成               │ │
│  │                                                                       │
│  │  【お知らせ】                                                       │ │
│  │  ┌───────────────────────────────────────────────────────────────┐  │
│  │  │  ・ 2026-06-11: 集合時間は18:30です                                │  │
│  │  │  ・ 2026-06-12: スタジオ練習は第2ホールです                          │  │
│  │  │  ・ 2026-06-13: 楽譜は当日までに配布済み                             │  │
│  │  └───────────────────────────────────────────────────────────────┘  │
│  │                                                                       │
│  │  【演奏会情報】                                                     │ │
│  │  ┌───────────────────────────────────────────────────────────────┐  │
│  │  │  タイトル: 第45回定期演奏会                                      │  │
│  │  │  開催日: 2026年7月15日                                          │  │
│  │  │  開場時間: 18:00 / 開演時間: 19:00                             │  │
│  │  │  場所: コンサートホール                                          │  │
│  │  │  指揮者: ◎◎指揮者                                             │  │
│  │  │  [▶️ 演奏曲をみる]                                           │  │
│  │  └───────────────────────────────────────────────────────────────┘  │
│  │                                                                       │
│  │  【練習スケジュール】                                              │ │
│  │  ┌───────────────────────────────────────────────────────────────┐  │
│  │  │  練習日: 2026年6月11日                                         │  │
│  │  │  時間: 13:00 - 16:00                                          │  │
│  │  │  場所: 練習室A                                                 │  │
│  │  │  会場使用可能時間: 12:30 - 16:30                              │  │
│  │  │  練習曲: 第1楽章 / 第2楽章                                     │  │
│  │  │  備考: 指揮者を招いての全体練習                                │  │
│  │  └───────────────────────────────────────────────────────────────┘  │
│  │                                                                       │
│  │  【録音部屋】                                                       │ │
│  │  ┌───────────────────────────────────────────────────────────────┐  │
│  │  │  📋 曲一覧                                                       │  │
│  │  │  ┌─ ▶️ 2026-06-11                                              │  │
│  │  │  │    ┌─ ▶️ 第1楽章                                            │  │
│  │  │  │    │      [📥 この練習曲を一括ダウンロード]                  │  │
│  │  │  │    │    ├─ ▶️ 01_Opening.mp3    3:45  [▶️][☁️]           │  │
│  │  │  │    │    └─ ▶️ 02_1st.mp3        5:30  [▶️][☁️]           │  │
│  │  │  └───────────────────────────────────────────────────────────┘  │
│  │  └───────────────────────────────────────────────────────────────┘  │
│  └─────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.2 統合アップロードパネルの詳細設計

```
┌─────────────────────────────────────────────────────┐
│ 📁 録音アップロード                                 │
├─────────────────────────────────────────────────────┤
│                                                     │
│  練習日                                          │
│  ┌─────────────────────────────────────────────┐  │
│  │ 日付: [2026-06-11]                           │  │
│  └─────────────────────────────────────────────┘  │
│                                                     │
│  練習曲                                          │
│  ┌─────────────────────────────────────────────┐  │
│  │ 曲名: [第1楽章を入力してください]             │  │
│  │ ヒント: 半角/全角 文字列を使い、フォルダ名として保存 │  │
│  └─────────────────────────────────────────────┘  │
│                                                     │
│  現在の保存先                                    │
│  📂 /2026-06-11/第1楽章/                            │
│                                                     │
│  アップロード説明                                │
│  • 選択した「練習日」＋「練習曲」フォルダの下に格納      │
│  • WAV を MP3 に変換し、Google Drive に保存          │
│  • フォルダ構造: /練習日/練習曲/ の下に音声ファイル      │
│                                                     │
│  ┌─────────────────────────────────────────────┐  │
│  │ 📄 WAV ファイルをドラッグ&ドロップ            │  │
│  │     または [ファイルを選択] をクリック        │  │
│  └─────────────────────────────────────────────┘  │
│                                                     │
│  ⚙️ 変換設定                                    │
│  ┌─────────────────────────────────────────────┐  │
│  │ ビットレート: 192kbps / 320kbps を選択可能     │  │
│  │ □ メタデータ自動補完                           │  │
│  └─────────────────────────────────────────────┘  │
│                                                     │
│  [🔄 変換開始]  [🗑️ 全てクリア]  [☁️ 自動保存]     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 5.3 曲リストエリアの詳細設計

```
┌─────────────────────────────────────────────────────┐
│ 📋 曲一覧                                         │
├─────────────────────────────────────────────────────┤
│                                                     │
│  表示: [全て ▼]  並び順: [アップロード順 ▼]       │
│                                                     │
│  ┌─ ▶️ 2026-06-11 (3曲)                            │
│  │      [📥 日付内を一括ダウンロード]               │
│  │  ┌─ ▶️ 第1楽章 (5曲)                             │
│  │  │      [📥 この練習曲を一括ダウンロード]       │
│  │  │   ├─ ▶️ 01_Opening.mp3    3:45  [▶️][☁️]
│  │  │   ├─ ▶️ 02_1st.mp3        5:30  [▶️][☁️]
│  │  │   ├─ ▶️ 03_2nd.mp3        4:15  [▶️][☁️]
│  │  │   ├─ ▶️ 04_3rd.mp3        6:10  [▶️][☁️]
│  │  │   └─ ▶️ 05_Finale.mp3     7:20  [▶️][☁️]
│  │  └───────────────────────────────────────────
│  └─────────────────────────────────────────────────
│                                                     │
│  選択: ☐全て  ☑曲1  ☑曲2  ☐曲3  ☐曲4  ☐曲5     │
│                                                     │
│  一括操作:                                          │
│  [↩️ ダウンロード] [📤 Google Drive共有]             │
│  [🗑️ 削除] [🔁 フォルダ更新] [⚙️ 詳細設定]       │
│                                                     │
└─────────────────────────────────────────────────────┘
```

【曲の詳細表示】(クリックで展開)
┌──────────────────────────────────────────────┐
│ ▶️ Opening                                  │
├──────────────────────────────────────────────┤
│ ファイル情報                                  │
│ • ファイル名: 01_opening.wav                 │
│ • 形式: WAV / MP3                            │
│ • サイズ: 12.5MB / 3.2MB                     │
│ • ビットレート: 44.1kHz / 192kbps           │
│ • 作成日: 2026年6月11日 15:30               │
│                                              │

```
┌─────────────────────────────────────────────────────┐
│ 📋 曲一覧 - 2026年6月11日 / 第1楽章 (5曲)         │
├─────────────────────────────────────────────────────┤
│                                                     │
│  表示: [全て ▼]  並び順: [アップロード順 ▼]       │
│                                                     │
│ ┌──┬──────────────┬────────┬───────┬──────┬──────┐│
│ │№ │ 曲名         │ アーティスト│ 時間 │ビット│操作  ││
│ ├──┼──────────────┼────────┼───────┼──────┼──────┤│
│ │1 │▶️ Opening    │オケA団 │3:45 │192k │[▶️][☁️]││
│ │  │              │ ├ Vn1   │       │     │      ││
│ │  │              │ ├ Vn2   │       │     │      ││
│ │  │              │ └ Vc    │       │     │      ││
│ ├──┼──────────────┼────────┼───────┼──────┼──────┤│
│ │2 │⏸️ 1st Mov    │オケA団 │5:30 │192k │[▶️][☁️]││
│ │  │              │ ├ Vn1   │       │     │      ││
│ │  │              │ ├ Vn2   │       │     │      ││
│ │  │              │ └ Vc    │       │     │      ││
│ ├──┼──────────────┼────────┼───────┼──────┼──────┤│
│ │3 │ 2nd Mov     │オケA団 │4:15 │192k │[▶️][☁️]││
│ │4 │ 3rd Mov     │オケA団 │6:10 │320k │[▶️][☁️]││
│ │5 │ Finale      │オケA団 │7:20 │192k │[▶️][☁️]││
│ └──┴──────────────┴────────┴───────┴──────┴──────┘│
│                                                     │
│  選択: ☐全て  ☑曲1  ☑曲2  ☐曲3  ☐曲4  ☐曲5     │
│                                                     │
│  一括操作:                                          │
│  [↩️ ダウンロード] [📤 Google Drive共有]             │
│  [🗑️ 削除] [🔁 フォルダ更新] [⚙️ 詳細設定]       │
│                                                     │
└─────────────────────────────────────────────────────┘

【曲の詳細表示】(クリックで展開)
┌──────────────────────────────────────────────┐
│ ▶️ Opening                                  │
├──────────────────────────────────────────────┤
│ ファイル情報                                  │
│ • ファイル名: 01_opening.wav                 │
│ • 形式: WAV / MP3                            │
│ • サイズ: 12.5MB / 3.2MB                     │
│ • ビットレート: 44.1kHz / 192kbps           │
│ • 作成日: 2026年6月11日 15:30               │
│                                              │
│ メタデータ                                   │
│ • タイトル: Opening                          │
│ • アーティスト: オケA団                       │
│ • パート: 全パート                            │
│ • 期間: 0:00 - 3:45                          │
│                                              │
│ 再生プレビュー                                │
│ [▶️ プレビュー再生] ⏱️ 3:45                  │
│                                              │
│ 共有情報                                      │
│ • Google Drive: ✅ アップロード済み          │
│   🔗 share-link  [コピー] [削除]             │
│ • 共有先: user1@ex.com, user2@ex.com       │
│                                              │
│ [編集] [削除] [プロパティ] [キャンセル]      │
└──────────────────────────────────────────────┘
```

### 5.6 レスポンシブデザイン（モバイル）

```
┌─────────────────┐
│ 🎼 オケツール│ ≡│  ← ハンバーガーメニュー
├─────────────────┤
│                 │
│ 📁 フォルダ管理 │
│ 日付: [▼]曲名[▼]│
│ [+ 日付] [+ 曲] │
│                 │
│ 📁 アップロード  │
│ ┌─────────────┐ │
│ │ ドラッグ&  │ │
│ │ ドロップ    │ │
│ │             │ │
│ │[ファイル選択]│ │
│ └─────────────┘ │
│                 │
│ 📋 曲リスト    │
│ ┌─────────────┐ │
│ │1.Opening   │ │
│ │  3:45 192k │ │
│ │  [▶️][☁️]   │ │
│ │───────────  │ │
│ │2.1st Mov   │ │
│ │  5:30 192k │ │
│ │  [▶️][☁️]   │ │
│ └─────────────┘ │
│                 │
│ ▶️ Opening...   │
│ ├─────●────┤   │
│ [⏮️][▶️][⏭️] │
│                 │
└─────────────────┘
```

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>オーケストラ活動管理ツール</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css">
  <link rel="stylesheet" href="css/styles.css">
</head>
<body>
  <div id="app">
    <!-- ナビゲーションバー -->
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark">
      <div class="container-fluid">
        <a class="navbar-brand" href="#">🎼 オーケストラ活動管理ツール</a>
        <div class="navbar-right d-flex align-items-center gap-2">
          <div class="btn-group btn-group-sm" role="group" aria-label="画面切り替え">
            <button class="btn btn-outline-light active" id="admin-menu-btn" onclick="showAdminMenu()">管理者メニュー</button>
            <button class="btn btn-outline-light" id="member-menu-btn" onclick="showMemberMenu()">団員メニュー</button>
          </div>
          <button id="auth-btn" class="btn btn-primary" onclick="authenticate()">Google認証</button>
          <div id="user-info" style="display:none; color: white;">
            <img id="user-picture" src="" alt="avatar" width="32">
            <span id="user-name"></span>
          </div>
        </div>
      </div>
    </nav>

    <!-- メインコンテンツ -->
    <!-- 管理者メニュー: 現在の画面をすべて表示 -->
    <!-- 団員メニュー: 曲リストエリアのみ表示 -->
    <!-- 団員メニューではフォルダ管理とアップロードは非表示にし、曲リストのみを残す -->
    <div class="container-fluid mt-4">
      
      <!-- フォルダ管理パネル -->
      <div class="card mb-4" id="folder-panel">
        <div class="card-header bg-secondary text-white">
          <h5>📁 フォルダ管理</h5>
        </div>
        <div class="card-body">
          <div class="row mb-3">
            <div class="col-md-5">
              <label for="date-select">練習日:</label>
              <select id="date-select" class="form-select" onchange="updateFolderPath()">
                <option value="2026-06-11">2026年6月11日 (昨日)</option>
                <option value="2026-06-10">2026年6月10日</option>
                <option value="2026-06-09">2026年6月09日</option>
              </select>
              <button class="btn btn-sm btn-outline-primary mt-2" onclick="addNewDate()">➕ 新規練習日</button>
            </div>
            <div class="col-md-5">
              <label for="song-select">練習曲:</label>
              <select id="song-select" class="form-select" onchange="updateFolderPath()">
                <option value="1st">第1楽章</option>
                <option value="2nd">第2楽章</option>
                <option value="3rd">第3楽章</option>
                <option value="finale">フィナーレ</option>
              </select>
              <button class="btn btn-sm btn-outline-primary mt-2" onclick="addNewSong()">➕ 新規練習曲</button>
            </div>
            <div class="col-md-2">
              <label>&nbsp;</label>
              <button class="btn btn-primary w-100" onclick="refreshFolder()">🔁 更新</button>
            </div>
          </div>
          <div class="alert alert-info" id="folder-path-display">
            📂 フォルダ: /オーケストラ/2026年6月11日/第1楽章/<br>
            容量: 250MB / 1GB | ファイル数: 5曲
          </div>
        </div>
      </div>

      <!-- アップロードエリア -->
      <div class="card mb-4" id="upload-panel">
        <div class="card-header bg-primary text-white">
          <h5>📁 オーディオファイルをアップロード</h5>
        </div>
        <div class="card-body">
          <p class="text-muted">アップロード先: <strong id="upload-destination">2026年6月11日 / 第1楽章</strong></p>
          
          <div class="upload-area" id="upload-area" style="border: 2px dashed #999; padding: 40px; text-align: center; border-radius: 8px; background-color: #f8f9fa; cursor: pointer;">
            <p>📁 WAVファイルをドラッグ&ドロップ<br>または</p>
            <input type="file" id="file-input" accept=".wav" multiple hidden>
            <button class="btn btn-primary" onclick="document.getElementById('file-input').click()">
              ファイルを選択
            </button>
            <p class="small text-muted mt-2">対応フォーマット: WAV (16bit/44.1kHz) | 最大: 500MB</p>
          </div>

          <!-- 待機中のファイル一覧 -->
          <div class="mt-3" id="pending-files">
            <h6>📋 待機中のファイル <span id="pending-count">0</span>個</h6>
            <div id="file-list" style="max-height: 200px; overflow-y: auto;"></div>
          </div>

          <!-- 変換設定 -->
          <div class="mt-3">
            <h6>⚙️ 変換設定</h6>
            <div class="form-check">
              <input type="radio" class="form-check-input" name="bitrate" value="128" id="bitrate-128">
              <label class="form-check-label" for="bitrate-128">128 kbps (低品質)</label>
            </div>
            <div class="form-check">
              <input type="radio" class="form-check-input" name="bitrate" value="192" id="bitrate-192" checked>
              <label class="form-check-label" for="bitrate-192">192 kbps (推奨)</label>
            </div>
            <div class="form-check">
              <input type="radio" class="form-check-input" name="bitrate" value="320" id="bitrate-320">
              <label class="form-check-label" for="bitrate-320">320 kbps (高品質)</label>
            </div>
            <div class="form-check mt-2">
              <input type="checkbox" class="form-check-input" id="auto-metadata" checked>
              <label class="form-check-label" for="auto-metadata">メタデータ自動編集</label>
              <small class="d-block">アーティスト: オケA団 | パート: <select class="form-select form-select-sm" style="width: 150px; display: inline-block;"><option>全パート</option><option>Vn1</option><option>Vn2</option><option>Vc</option></select></small>
            </div>
          </div>

          <!-- 進捗表示 -->
          <div class="mt-3" id="progress-section" style="display:none;">
            <div class="progress">
              <div class="progress-bar" id="progress-bar" style="width: 0%;"></div>
            </div>
            <small class="text-muted" id="progress-text">進捗: 0%</small>
          </div>

          <!-- ボタン群 -->
          <div class="mt-3">
            <button class="btn btn-success" onclick="startConversion()">🔄 変換開始</button>
            <button class="btn btn-danger" onclick="clearFiles()">🗑️ 全てクリア</button>
            <button class="btn btn-outline-secondary" onclick="toggleAutoUpload()">
              ☁️ <span id="auto-upload-status">自動アップロード: OFF</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 曲リストエリア -->
      <div class="card mb-4" id="playlist-panel">
        <div class="card-header bg-success text-white">
          <h5>📋 曲一覧</h5>
        </div>
        <div class="card-body">
          <div class="row mb-3">
            <div class="col-md-6">
              <small>フォルダ内の曲: <strong id="song-count">0</strong>曲</small>
            </div>
            <div class="col-md-6 text-end">
              <select class="form-select form-select-sm" style="width: 180px; display: inline-block;">
                <option>アップロード順</option>
                <option>ファイル名順</option>
                <option>更新日時順</option>
              </select>
            </div>
          </div>

          <!-- 曲テーブル -->
          <div style="overflow-x: auto;">
            <table class="table table-hover table-sm">
              <thead class="table-light">
                <tr>
                  <th style="width: 30px;"><input type="checkbox" id="select-all" onchange="toggleSelectAll()"></th>
                  <th style="width: 40px;">№</th>
                  <th>曲名</th>
                  <th>時間</th>
                  <th style="width: 80px;">操作</th>
                </tr>
              </thead>
              <tbody id="song-list">
                <!-- 動的に曲が挿入される -->
              </tbody>
            </table>
          </div>

          <!-- 曲リストが空の場合 -->
          <div id="empty-list" class="alert alert-info">
            このフォルダにはまだ曲がありません。上のアップロードエリアからWAVファイルをアップロードしてください。
          </div>

          <!-- 一括操作ボタン -->
          <div class="mt-3">
            <button class="btn btn-outline-secondary btn-sm" onclick="downloadSelected()">↩️ ダウンロード</button>
            <button class="btn btn-outline-secondary btn-sm" onclick="shareSelected()">📤 Google Drive共有</button>
            <button class="btn btn-outline-danger btn-sm" onclick="deleteSelected()">🗑️ 削除</button>
            <button class="btn btn-outline-secondary btn-sm" onclick="refreshFolder()">🔁 フォルダ更新</button>
            <button class="btn btn-outline-secondary btn-sm" onclick="openSettings()">⚙️ 詳細設定</button>
          </div>
        </div>
      </div>

    </div>

    <!-- オーディオプレイヤーバー（常表示） -->
    <div id="player-bar" class="fixed-bottom bg-dark text-white p-3" style="display: none;">
      <div class="row align-items-center">
        <div class="col-md-3">
          <small>現在再生中: <strong id="now-playing">選択なし</strong></small>
        </div>
        <div class="col-md-6">
          <div class="controls mb-2">
            <button class="btn btn-sm btn-outline-light" onclick="playerPrev()">⏮️</button>
            <button class="btn btn-sm btn-outline-light" id="play-btn" onclick="playerToggle()">▶️</button>
            <button class="btn btn-sm btn-outline-light" onclick="playerNext()">⏭️</button>
            <button class="btn btn-sm btn-outline-light" onclick="playerStop()">⏹️</button>
          </div>
          <div class="d-flex align-items-center">
            <small id="current-time">0:00</small>
            <input type="range" id="progress-slider" class="form-range flex-grow-1 mx-2" min="0" max="100" value="0">
            <small id="duration-time">0:00</small>
          </div>
          <div class="d-flex align-items-center mt-1">
            <small>🔉</small>
            <input type="range" id="volume-slider" class="form-range" style="width: 100px; margin: 0 8px;" min="0" max="100" value="80">
            <small>🔊 <span id="volume-percent">80</span>%</small>
          </div>
        </div>
        <div class="col-md-3 text-end">
          <button class="btn btn-sm btn-outline-light" onclick="toggleShuffle()">🔀</button>
          <button class="btn btn-sm btn-outline-light" onclick="toggleRepeat()">🔁</button>
          <button class="btn btn-sm btn-outline-light" onclick="togglePlaylist()">📋</button>
        </div>
      </div>
      <audio id="audio-player" onended="onTrackEnded()"></audio>
    </div>

  </div>

  <!-- JavaScript -->
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
  <script src="js/api-client.js"></script>
  <script src="js/app.js"></script>
</body>
</html>
```

  <!-- JavaScript -->
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
  <script src="js/api-client.js"></script>
  <script src="js/app.js"></script>
</body>
</html>
```

---

### 5.7 HTML構造の詳細説明

メイン画面は3つのセクションで構成：

1. **フォルダ管理パネル**
   - 練習日と練習曲をドロップダウンで選択
   - 新規日付・曲の追加機能
   - 現在のフォルダパスを表示

2. **アップロードエリア**
   - ドラッグ&ドロップまたはファイル選択
   - 待機中のファイルリスト
   - 変換設定（ビットレート、メタデータ）
   - 進捗表示バー
   - 変換実行ボタン

3. **曲リストエリア**
   - フォルダ内の全曲を表形式で表示
   - 各曲の再生・共有・削除操作
   - 一括操作機能

---

## 5.9 管理者/団員メニュー切り替え

- **管理者メニュー**
  - `#admin-view` にフル画面を表示
  - フォルダ管理、録音アップロード、曲リストのすべてを含む
- **団員メニュー**
  - `#member-view` に曲リストエリアのみ表示
  - アップロードやフォルダ管理は非表示にして閲覧/再生重視
- ナビゲーションバー上部のボタンで切り替え
  - `showAdminMenu()` / `showMemberMenu()` を呼び出して表示を制御

---

### 5.8 CSS実装（メイン画面用）

```css
/* フォルダ・アップロードパネル */
.card {
  border: none;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  border-radius: 8px;
}

.card-header {
  border-radius: 8px 8px 0 0;
  font-weight: 600;
}

.upload-area {
  border: 2px dashed var(--border);
  border-radius: 8px;
  padding: 40px;
  text-align: center;
  background-color: rgba(25, 118, 210, 0.02);
  cursor: pointer;
  transition: all 0.3s ease;
}

.upload-area:hover {
  border-color: var(--primary);
  background-color: rgba(25, 118, 210, 0.08);
}

.upload-area.drag-over {
  border-color: var(--primary);
  background-color: rgba(25, 118, 210, 0.15);
  box-shadow: 0 0 8px rgba(25, 118, 210, 0.3);
}

/* 曲テーブル */
.table {
  margin-bottom: 0;
}

.table tbody tr:hover {
  background-color: #f5f5f5;
  cursor: pointer;
}

.table tbody tr.playing {
  background-color: rgba(76, 175, 80, 0.1);
  font-weight: 600;
}

/* オーディオプレイヤーバー */
.fixed-bottom {
  bottom: 0;
  left: 0;
  right: 0;
  border-top: 1px solid var(--border);
}

#player-bar .controls button {
  margin-right: 5px;
}

#player-bar .form-range {
  height: 4px;
}

/* フォルダ内容表示 */
#folder-path-display {
  background-color: #E3F2FD;
  border-left: 4px solid var(--primary);
}
```

---

### 5.9 JavaScript実装（メイン画面用）

```javascript
// メイン画面の初期化と管理

class OrchestraMainApp {
  constructor() {
    this.currentDate = '2026-06-11';
    this.currentSong = '1st';
    this.songs = [];
    this.selectedSongs = new Set();
    this.autoUpload = false;
    this.currentPlaying = null;
    this.init();
  }

  async init() {
    this.setupEventListeners();
    await this.loadFolder();
    this.checkAuthStatus();
  }

  setupEventListeners() {
    // フォルダ選択変更
    document.getElementById('date-select').addEventListener('change', () => this.updateFolderPath());
    document.getElementById('song-select').addEventListener('change', () => this.updateFolderPath());

    // ドラッグ&ドロップ
    const uploadArea = document.getElementById('upload-area');
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('drag-over');
    });

    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('drag-over');
    });

    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('drag-over');
      this.handleFilesDrop(e.dataTransfer.files);
    });

    // ファイル入力
    document.getElementById('file-input').addEventListener('change', (e) => {
      this.handleFilesDrop(e.target.files);
    });

    // 全選択
    document.getElementById('select-all').addEventListener('change', (e) => {
      this.toggleSelectAll(e.target.checked);
    });
  }

  async loadFolder() {
    try {
      const response = await apiClient.get(`/api/folder/${this.currentDate}/${this.currentSong}`);
      this.songs = response.songs || [];
      this.renderSongList();
    } catch (error) {
      console.error('フォルダ読み込みエラー:', error);
    }
  }

  updateFolderPath() {
    this.currentDate = document.getElementById('date-select').value;
    this.currentSong = document.getElementById('song-select').value;
    
    const dateDisplay = new Date(this.currentDate).toLocaleDateString('ja-JP');
    const songDisplay = document.querySelector(`#song-select option[value="${this.currentSong}"]`).textContent;
    
    document.getElementById('folder-path-display').innerHTML = `
      📂 フォルダ: /オーケストラ/${dateDisplay}/${songDisplay}/<br>
      容量: <span id="folder-size">0</span>MB / 1GB | ファイル数: <span id="folder-count">0</span>曲
    `;
    
    document.getElementById('upload-destination').textContent = `${dateDisplay} / ${songDisplay}`;
    
    this.loadFolder();
  }

  handleFilesDrop(fileList) {
    for (let file of fileList) {
      if (file.type === 'audio/wav' && file.size < 500 * 1024 * 1024) {
        this.addFileToQueue(file);
      }
    }
  }

  addFileToQueue(file) {
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.innerHTML = `
      <div>
        <strong>${file.name}</strong> (${this.formatFileSize(file.size)})
      </div>
      <button class="btn btn-sm btn-outline-danger" onclick="app.removeFileFromQueue('${file.name}')">削除</button>
    `;
    document.getElementById('file-list').appendChild(fileItem);
    
    document.getElementById('pending-count').textContent = document.querySelectorAll('.file-item').length;
  }

  renderSongList() {
    const tbody = document.getElementById('song-list');
    tbody.innerHTML = '';
    
    this.songs.forEach((song, index) => {
      const row = document.createElement('tr');
      row.className = this.currentPlaying?.id === song.id ? 'playing' : '';
      
      row.innerHTML = `
        <td><input type="checkbox" value="${song.id}" onchange="app.toggleSongSelection('${song.id}')"></td>
        <td>${index + 1}</td>
        <td><strong>${song.name}</strong></td>
        <td>${song.artist || 'オケA団'}</td>
        <td>${song.duration || '0:00'}</td>
        <td>${song.bitrate || '192k'}</td>
        <td>
          <button class="btn btn-sm btn-outline-primary" onclick="app.playSong('${song.id}')">▶️</button>
          <button class="btn btn-sm btn-outline-secondary" onclick="app.shareOne('${song.id}')">☁️</button>
        </td>
      `;
      
      tbody.appendChild(row);
    });

    const emptyList = document.getElementById('empty-list');
    if (this.songs.length === 0) {
      emptyList.style.display = 'block';
      document.getElementById('song-count').textContent = '0';
    } else {
      emptyList.style.display = 'none';
      document.getElementById('song-count').textContent = this.songs.length;
    }
  }

  playSong(songId) {
    const song = this.songs.find(s => s.id === songId);
    if (song) {
      this.currentPlaying = song;
      const audioPlayer = document.getElementById('audio-player');
      audioPlayer.src = `/api/player/file/${songId}`;
      audioPlayer.play();
      
      document.getElementById('player-bar').style.display = 'block';
      document.getElementById('now-playing').textContent = `${song.name} (${song.artist || 'オケA団'})`;
      
      this.renderSongList();
    }
  }

  toggleSelectAll(checked) {
    document.querySelectorAll('#song-list input[type="checkbox"]').forEach(checkbox => {
      checkbox.checked = checked;
      this.toggleSongSelection(checkbox.value);
    });
  }

  toggleSongSelection(songId) {
    if (this.selectedSongs.has(songId)) {
      this.selectedSongs.delete(songId);
    } else {
      this.selectedSongs.add(songId);
    }
  }

  async startConversion() {
    const bitrate = document.querySelector('input[name="bitrate"]:checked').value;
    const files = document.querySelectorAll('.file-item');
    
    if (files.length === 0) {
      alert('ファイルを選択してください');
      return;
    }

    for (let fileItem of files) {
      await this.convertFile(fileItem, bitrate);
    }
  }

  async convertFile(fileItem, bitrate) {
    const filename = fileItem.querySelector('strong').textContent;
    // API呼び出しで変換処理
    console.log(`変換開始: ${filename} (${bitrate}kbps)`);
  }

  formatFileSize(bytes) {
    const units = ['B', 'KB', 'MB'];
    let size = bytes;
    let unit = 0;
    
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit++;
    }
    
    return `${size.toFixed(2)}${units[unit]}`;
  }

  clearFiles() {
    document.getElementById('file-list').innerHTML = '';
    document.getElementById('file-input').value = '';
    document.getElementById('pending-count').textContent = '0';
  }
}

// グローバルインスタンス
const app = new OrchestraMainApp();
```

```
┌────────────────────────────────────────────────────────────────┐
│ 🎼 オーケストラ活動管理ツール          [Google認証] [👤 ユーザー] │
├────────────────────────────────────────────────────────────────┤
│ 🔄 変換  |  ▶️ 再生  |  ☁️ Drive共有                           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  【変換タブ】                                                  │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  📁 WAVファイルをドラッグ&ドロップ                     │ │
│  │      または [ファイルを選択] ボタンをクリック            │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  📋 ファイル一覧                                               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ ☐  sample1.wav      (2.5MB)        [削除]               │ │
│  │ ☐  sample2.wav      (3.1MB)        [削除]               │ │
│  │ ☑  sample3.wav      (4.0MB)        [削除]               │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ⚙️ 変換設定                                                   │
│  品質: [192kbps ▼]  (選択肢: 128kbps, 192kbps, 320kbps)      │
│  □ メタデータ編集有効                                          │
│                                                                │
│  進捗: 32% ████████░░░░░░░░░░░░░░ (処理中...)              │
│                                                                │
│  [🔄 変換開始]  [🗑️ クリア]  [☁️ Drive自動アップロード]     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 5.3 【変換タブ】詳細レイアウト

```
┌────────────────────────────────────────────────────────┐
│                   アップロードエリア                    │
│  ┌────────────────────────────────────────────────────┐│
│  │                                                    ││
│  │            📁 ドラッグ&ドロップ                   ││
│  │                                                    ││
│  │   WAVファイルをここにドラッグしてください        ││
│  │   または [ファイルを選択] をクリック              ││
│  │                                                    ││
│  │             [ファイルを選択]                      ││
│  │                                                    ││
│  └────────────────────────────────────────────────────┘│
│                                                        │
│  📋 選択ファイル一覧                                   │
│  ┌────────────────────────────────────────────────────┐│
│  │ ファイル名              サイズ     ステータス   操作 ││
│  ├────────────────────────────────────────────────────┤│
│  │ sample1.wav     2.5MB  ⏳ 待機中  [削除]      ││
│  │ sample2.wav     3.1MB  ⏳ 待機中  [削除]      ││
│  │ sample3.wav     4.0MB  🔄 処理中  [キャンセル] ││
│  │ sample4.wav     1.8MB  ✅ 完了   [再生]      ││
│  └────────────────────────────────────────────────────┘│
│                                                        │
│  ⚙️ 変換設定                                           │
│  ┌────────────────────────────────────────────────────┐│
│  │ ビットレート:                                      ││
│  │ ○ 128 kbps (低品質、ファイルサイズ小)             ││
│  │ ◉ 192 kbps (推奨、バランス型)                     ││
│  │ ○ 320 kbps (高品質、ファイルサイズ大)             ││
│  │                                                    ││
│  │ □ メタデータを編集する                            ││
│  │   タイトル: [________________]                    ││
│  │   アーティスト: [________________]                ││
│  │   パート: [ヴァイオリン第1▼]                      ││
│  └────────────────────────────────────────────────────┘│
│                                                        │
│  📊 変換進捗                                           │
│  ┌────────────────────────────────────────────────────┐│
│  │ 処理状況: sample3.wav を処理中...                 ││
│  │ ████████░░░░░░░░░░░░░░░░░░░░░  32%               ││
│  │ 経過時間: 1分23秒  /  推定残り時間: 2分45秒      ││
│  └────────────────────────────────────────────────────┘│
│                                                        │
│  [🔄 変換開始]  [🗑️ クリア全て]                      │
│  [☁️ 完了後Drive自動アップロード] (有効)             │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### 5.4 【再生タブ】詳細レイアウト

```
┌────────────────────────────────────────────────────┐
│               プレイヤー表示エリア                  │
│  ┌────────────────────────────────────────────────┐│
│  │                                                ││
│  │  ┌──────────────────────────────────────────┐ ││
│  │  │         🎵 アルバムアート        │ ││
│  │  │                            │ ││
│  │  │                            │ ││
│  │  └──────────────────────────────────────────┘ ││
│  │                                                ││
│  │  曲情報                                        ││
│  │  タイトル: オケA団 - 第1楽章                 ││
│  │  アーティスト: オケA団                        ││
│  │  ビットレート: 192kbps                       ││
│  │                                                ││
│  └────────────────────────────────────────────────┘│
│                                                    │
│  再生コントロール                                  │
│  [⏮️ 前]  [▶️ 再生]  [⏸️  一時停止]  [⏹️ 停止]   │
│                                                    │
│  タイムライン                                      │
│  0:00 ├──────────●────────────┤ 5:00             │
│       ドラッグして位置調整可能                      │
│                                                    │
│  音量調整                                          │
│  🔉 ├──────────●──────────┤ 🔊  80%             │
│                                                    │
│  📋 プレイリスト                                   │
│  ┌────────────────────────────────────────────────┐│
│  │ 現在再生: ▶️  sample1.mp3  [00:00 / 05:30]   ││
│  ├────────────────────────────────────────────────┤│
│  │ キュー内:                                      ││
│  │  1️⃣  sample2.mp3  [04:15] 📁 ローカル      ││
│  │  2️⃣  sample3.mp3  [03:45] ☁️ Google Drive  ││
│  │  3️⃣  sample4.mp3  [06:10] 📁 ローカル      ││
│  └────────────────────────────────────────────────┘│
│                                                    │
│  [➕ ファイル追加]  [🔀 シャッフル]  [🔁 リピート] │
│  [📥 ダウンロード]  [↗️ 共有]                      │
│                                                    │
└────────────────────────────────────────────────────┘
```

### 5.5 【Google Drive共有タブ】詳細レイアウト

```
┌────────────────────────────────────────────────────┐
│          認証・アップロード状態                    │
│  ┌────────────────────────────────────────────────┐│
│  │ Google Drive 認証状態:                         ││
│  │ ✅ 認証済み (ユーザー: user@example.com)      ││
│  │ [再認証]  [アクセス権限管理]  [ログアウト]     ││
│  └────────────────────────────────────────────────┘│
│                                                    │
│  📁 アップロード済みファイル                       │
│  ┌────────────────────────────────────────────────┐│
│  │ フォルダ: /オケツール/2026年6月/              ││
│  │ [📂 フォルダ管理]                             ││
│  ├────────────────────────────────────────────────┤│
│  │ ファイル名              更新日時       ビット   │  操作     ││
│  ├────────────────────────────────────────────────┤│
│  │ sample1.mp3  2026/06/11 15:30  192kbps        ││
│  │   👥 アクセス権限: 閲覧者 (user1@ex.com他)   ││
│  │   🔗 share-link  [コピー]  [権限変更]         ││
│  │   [削除]                                       ││
│  │                                                ││
│  │ sample2.mp3  2026/06/10 14:20  192kbps        ││
│  │   👥 アクセス権限: 編集者 (user2@ex.com)     ││
│  │   🔗 share-link  [コピー]  [権限変更]         ││
│  │   [削除]                                       ││
│  │                                                ││
│  │ sample3.mp3  2026/06/09 10:15  320kbps        ││
│  │   👥 アクセス権限: 共有リンク(公開)           ││
│  │   🔗 https://drive.google.com/...  [コピー]  ││
│  │   [権限変更]  [削除]                          ││
│  └────────────────────────────────────────────────┘│
│                                                    │
│  👥 団員に共有する                                 │
│  ┌────────────────────────────────────────────────┐│
│  │ メールアドレス: [user@example.com__________] ││
│  │ 権限:          [閲覧者 ▼]                     ││
│  │ メッセージ:    [メッセージを入力 (オプション)] ││
│  │ [► 共有リンクを送信]                          ││
│  │                                                ││
│  │ 共有履歴:                                      ││
│  │ • 2026/06/11 user1@example.com に共有        ││
│  │ • 2026/06/10 user2@example.com に共有        ││
│  │ • 2026/06/09 共有リンク公開                   ││
│  └────────────────────────────────────────────────┘│
│                                                    │
│  🔐 フォルダ権限設定                              │
│  ┌────────────────────────────────────────────────┐│
│  │ フォルダ: /オケツール/2026年6月/              ││
│  │ 現在の権限: 所有者 (変更不可)                 ││
│  │                                                ││
│  │ メンバー:                                      ││
│  │ • owner@example.com     👑 所有者             ││
│  │ • user1@example.com     👁️  閲覧者            ││
│  │ • user2@example.com     ✏️  編集者            ││
│  │                                                ││
│  │ [メンバー追加]  [権限変更]  [削除]             ││
│  └────────────────────────────────────────────────┘│
│                                                    │
└────────────────────────────────────────────────────┘
```

### 5.6 レスポンシブデザイン（モバイル）

```
┌─────────────────────┐
│ 🎼 オケツール  [≡]  │  ← ハンバーガーメニュー
├─────────────────────┤
│                     │
│  変換 | 再生 | Drive│  ← タブ（スクロール可能）
│                     │
│ ┌─────────────────┐ │
│ │  📁 ドラッグ&  │ │
│ │  ドロップ      │ │
│ │                 │ │
│ │ [ファイル選択]  │ │
│ └─────────────────┘ │
│                     │
│ 📋 ファイル一覧    │
│ ┌─────────────────┐ │
│ │sample1.wav      │ │
│ │2.5MB [削除]     │ │
│ │───────────────  │ │
│ │sample2.wav      │ │
│ │3.1MB [削除]     │ │
│ └─────────────────┘ │
│                     │
│ 品質: [192kbps ▼] │
│                     │
│ [変換開始]          │
│ [クリア]            │
│                     │
└─────────────────────┘
```

### 5.7 レスポンシブ対応仕様

- **デスクトップ (1024px〜)**: 全機能を複数列レイアウト
- **タブレット (768px〜 1023px)**: 2列レイアウト
- **モバイル (〜 767px)**: 1列レイアウト、タブはスクロール
- **ダークモード**: OS/ブラウザ設定に自動対応
- **タッチ対応**: ボタン最小サイズ 44x44px

---

## 6. UI/UXデザイン仕様

### 6.1 カラースキーム

```css
/* メインカラー */
--primary-color: #1976D2;        /* Google Blue */
--secondary-color: #FFA726;      /* Orange (アクセント) */
--success-color: #4CAF50;        /* Green */
--warning-color: #FFC107;        /* Amber */
--danger-color: #F44336;         /* Red */

/* ニュートラルカラー */
--dark-bg: #121212;              /* ダークモード背景 */
--light-bg: #FFFFFF;             /* ライトモード背景 */
--text-primary: #212121;         /* プライマリテキスト */
--text-secondary: #757575;       /* セカンダリテキスト */
--border-color: #E0E0E0;         /* ボーダー */

/* ステータスカラー */
--pending: #90CAF9;              /* 待機中 */
--processing: #42A5F5;           /* 処理中 */
--completed: #66BB6A;            /* 完了 */
--error: #EF5350;                /* エラー */
```

### 6.2 タイポグラフィ

```css
/* フォント */
body {
  font-family: 'Segoe UI', 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 16px;
  line-height: 1.5;
}

h1 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 16px;
}

h2 {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 12px;
}

h3 {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 8px;
}

p {
  font-size: 14px;
  color: var(--text-secondary);
}

.button, button {
  font-size: 14px;
  font-weight: 600;
}
```

### 6.3 スペーシング

```css
/* マージン・パディング */
--spacing-xs: 4px;
--spacing-sm: 8px;
--spacing-md: 16px;
--spacing-lg: 24px;
--spacing-xl: 32px;
--spacing-2xl: 48px;

/* 使用例 */
.panel {
  padding: var(--spacing-lg);      /* 16px */
  margin-bottom: var(--spacing-md); /* 16px */
}
```

### 6.4 ボタン設計

```
【プライマリボタン】 (メイン操作)
┌────────────────────┐
│  🔄 変換開始       │  ← 背景色: --primary-color
│                    │     文字色: 白
│                    │     幅: 100% 又は 200px
└────────────────────┘
ホバー時: 背景色を暗くする
クリック時: スケール 0.98

【セカンダリボタン】 (補助操作)
┌────────────────────┐
│  🗑️ クリア        │  ← 背景色: --light-bg
│                    │     文字色: --text-primary
│                    │     枠線: --border-color
└────────────────────┘

【デンジャーボタン】 (削除操作)
┌────────────────────┐
│  削除              │  ← 背景色: --danger-color
│                    │     文字色: 白
└────────────────────┘

【サクセスボタン】 (成功状態)
┌────────────────────┐
│  ✅ アップロード完了│  ← 背景色: --success-color
│                    │     文字色: 白
└────────────────────┘
```

### 6.5 フォーム要素

```
【テキスト入力】
┌──────────────────────────────────┐
│ メールアドレス                   │
│ [user@example.com_________]     │  ← ボーダー: 1px solid --border-color
│ ↓ フォーカス時                    │     背景色: --light-bg
│ [user@example.com_________]     │     ボーダーカラー: --primary-color
│                                  │

【セレクトボックス】
┌──────────────────────────────────┐
│ ビットレート                     │
│ [192 kbps ▼]                    │  ← クリック時にドロップダウン
│ Options:                         │
│  ○ 128 kbps                      │
│  ◉ 192 kbps (selected)           │
│  ○ 320 kbps                      │
└──────────────────────────────────┘

【チェックボックス】
☐ メタデータ編集有効  ← 未選択
☑ メタデータ編集有効  ← 選択状態

【ラジオボタン】
◯ ビットレート 128 kbps
◉ ビットレート 192 kbps  ← 選択状態
```

### 6.6 プログレスバー設計

```
【変換進捗】
────────────────────────────────────
処理状況: sample3.wav を処理中...
████████░░░░░░░░░░░░░░░░░░░░░  32%
経過時間: 1分23秒  推定残り時間: 2分45秒
────────────────────────────────────

【アニメーション】
- ████████░░░░░░░░░░░░░░ 50% (処理中はループアニメ)
- 色変更: グラデーション (青 → 緑 → オレンジ)
```

---

## 7. CSS・JavaScriptファイル構成

### 7.1 フロントエンドファイル構成

```
frontend/
├── index.html                  # メインHTMLファイル
│
├── css/
│   ├── styles.css              # メインスタイル
│   │   └── variables (カラー、サイズ)
│   │   └── navbar / tabs
│   │   └── panels (converter / player / drive)
│   │   └── forms (input / select / checkbox)
│   │   └── buttons
│   │   └── progress bars
│   │   └── utilities
│   │
│   ├── responsive.css          # レスポンシブ対応
│   │   └── モバイル対応 (@media max-width: 767px)
│   │   └── タブレット対応 (@media 768px - 1023px)
│   │   └── デスクトップ (@media min-width: 1024px)
│   │
│   └── themes.css              # ダークモード/テーマ
│       └── light-theme
│       └── dark-theme
│
├── js/
│   ├── app.js                  # メインアプリケーション
│   │   └── タブ切り替え
│   │   └── ナビゲーション
│   │   └── グローバル状態管理
│   │
│   ├── api-client.js           # API通信
│   │   └── fetch wrapper
│   │   └── エラーハンドリング
│   │   └── トークン管理
│   │
│   ├── converter.js            # 変換機能
│   │   └── ファイル選択
│   │   └── ドラッグ&ドロップ
│   │   └── 変換実行
│   │   └── 進捗表示
│   │
│   ├── player.js               # 再生機能
│   │   └── オーディオ制御
│   │   └── プレイリスト管理
│   │   └── タイムラインUI
│   │
│   ├── drive.js                # Drive連携
│   │   └── 認証フロー
│   │   └── ファイル一覧表示
│   │   └── 共有リンク生成
│   │
│   └── utils.js                # ユーティリティ
│       └── フォーマット (時間、ファイルサイズ)
│       └── ローカルストレージ
│       └── キャッシュ管理
│
└── assets/
    ├── icons/                  # SVGアイコン
    ├── images/                 # 画像ファイル
    └── fonts/                  # カスタムフォント (optional)
```

### 7.2 CSS実装例

```css
/* styles.css - メイン */

:root {
  /* カラー */
  --primary: #1976D2;
  --secondary: #FFA726;
  --success: #4CAF50;
  --danger: #F44336;
  --bg-light: #FFFFFF;
  --bg-dark: #121212;
  --text-primary: #212121;
  --text-secondary: #757575;
  --border: #E0E0E0;
  
  /* スペーシング */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
}

/* Navbar */
.navbar {
  background-color: var(--text-primary);
  padding: var(--spacing-md);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.navbar-brand {
  font-size: 24px;
  font-weight: 700;
  color: white;
}

/* Tabs */
.nav-tabs {
  border-bottom: 2px solid var(--border);
  padding: var(--spacing-md);
}

.nav-link {
  color: var(--text-secondary);
  padding: var(--spacing-sm) var(--spacing-md);
  border: none;
  border-bottom: 3px solid transparent;
  cursor: pointer;
  transition: all 0.3s ease;
}

.nav-link.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.nav-link:hover {
  color: var(--primary);
  background-color: rgba(25, 118, 210, 0.05);
}

/* Panels */
.panel {
  padding: var(--spacing-lg);
  background-color: var(--bg-light);
  border-radius: 8px;
  margin: var(--spacing-md);
}

/* Upload Area */
.upload-area {
  border: 2px dashed var(--border);
  border-radius: 8px;
  padding: var(--spacing-lg);
  text-align: center;
  background-color: rgba(25, 118, 210, 0.02);
  cursor: pointer;
  transition: all 0.3s ease;
}

.upload-area:hover {
  border-color: var(--primary);
  background-color: rgba(25, 118, 210, 0.08);
}

.upload-area.drag-over {
  border-color: var(--primary);
  background-color: rgba(25, 118, 210, 0.15);
  box-shadow: 0 0 8px rgba(25, 118, 210, 0.3);
}

/* Buttons */
.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary {
  background-color: var(--primary);
  color: white;
}

.btn-primary:hover {
  background-color: #1565C0;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.btn-primary:active {
  transform: scale(0.98);
}

.btn-secondary {
  background-color: white;
  color: var(--text-primary);
  border: 1px solid var(--border);
}

.btn-secondary:hover {
  background-color: #F5F5F5;
}

.btn-danger {
  background-color: var(--danger);
  color: white;
}

.btn-danger:hover {
  background-color: #D32F2F;
}

/* Forms */
input, select, textarea {
  width: 100%;
  padding: var(--spacing-sm);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 14px;
  transition: border-color 0.3s ease;
}

input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(25, 118, 210, 0.1);
}

/* Progress Bar */
.progress {
  background-color: #E0E0E0;
  border-radius: 4px;
  height: 8px;
  overflow: hidden;
}

.progress-bar {
  background: linear-gradient(90deg, #42A5F5, #66BB6A);
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.8; }
}

/* File List */
.file-list {
  margin: var(--spacing-lg) 0;
}

.file-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md);
  border: 1px solid var(--border);
  border-radius: 4px;
  margin-bottom: var(--spacing-sm);
  background-color: white;
  transition: all 0.2s ease;
}

.file-item:hover {
  background-color: #F5F5F5;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.file-item.completed {
  background-color: #E8F5E9;
  border-color: var(--success);
}

.file-item.error {
  background-color: #FFEBEE;
  border-color: var(--danger);
}
```

### 7.3 JavaScript実装例

```javascript
// app.js - メインアプリケーション

class OrchestraApp {
  constructor() {
    this.currentUser = null;
    this.files = [];
    this.selectedFiles = new Set();
    this.init();
  }

  async init() {
    // DOM要素の取得
    this.fileInput = document.getElementById('file-input');
    this.uploadArea = document.getElementById('upload-area');
    this.fileList = document.getElementById('file-list');
    this.convertBtn = document.querySelector('[onclick="startConversion()"]');

    // イベントリスナー登録
    this.setupEventListeners();
    
    // 初期化
    await this.checkAuthStatus();
  }

  setupEventListeners() {
    // ドラッグ&ドロップ
    this.uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.uploadArea.classList.add('drag-over');
    });

    this.uploadArea.addEventListener('dragleave', () => {
      this.uploadArea.classList.remove('drag-over');
    });

    this.uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      this.uploadArea.classList.remove('drag-over');
      this.handleFiles(e.dataTransfer.files);
    });

    // ファイル入力
    this.fileInput.addEventListener('change', (e) => {
      this.handleFiles(e.target.files);
    });
  }

  handleFiles(fileList) {
    for (let file of fileList) {
      if (file.type === 'audio/wav' && file.size < 500 * 1024 * 1024) {
        this.files.push(file);
        this.renderFileList();
      }
    }
  }

  renderFileList() {
    this.fileList.innerHTML = '';
    this.files.forEach((file, index) => {
      const fileItem = document.createElement('div');
      fileItem.className = 'file-item';
      fileItem.innerHTML = `
        <div>
          <input type="checkbox" onchange="app.toggleFileSelection(${index})">
          <span>${file.name} (${this.formatFileSize(file.size)})</span>
        </div>
        <button class="btn btn-sm btn-danger" onclick="app.removeFile(${index})">削除</button>
      `;
      this.fileList.appendChild(fileItem);
    });
  }

  async startConversion() {
    if (this.files.length === 0) return;
    
    const bitrate = document.getElementById('bitrate-select').value;
    const progressSection = document.getElementById('progress-section');
    progressSection.style.display = 'block';

    for (let file of this.files) {
      await this.convertFile(file, bitrate);
    }
  }

  async convertFile(file, bitrate) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('bitrate', bitrate);

    try {
      const response = await apiClient.post('/api/convert/start', formData);
      console.log('変換開始:', response);
      this.pollConversionStatus(response.job_id);
    } catch (error) {
      console.error('変換エラー:', error);
    }
  }

  async pollConversionStatus(jobId) {
    const maxAttempts = 300; // 30分
    let attempts = 0;

    while (attempts < maxAttempts) {
      const response = await apiClient.get(`/api/convert/${jobId}`);
      
      if (response.status === 'completed') {
        this.onConversionComplete(response);
        break;
      }

      if (response.status === 'error') {
        this.onConversionError(response);
        break;
      }

      this.updateProgressBar(response.progress);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
  }

  formatFileSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  removeFile(index) {
    this.files.splice(index, 1);
    this.renderFileList();
  }

  toggleFileSelection(index) {
    if (this.selectedFiles.has(index)) {
      this.selectedFiles.delete(index);
    } else {
      this.selectedFiles.add(index);
    }
  }

  async checkAuthStatus() {
    try {
      const response = await apiClient.get('/api/auth/user');
      this.currentUser = response;
      this.updateAuthUI();
    } catch {
      console.log('未認証ユーザー');
    }
  }

  updateAuthUI() {
    if (this.currentUser) {
      document.getElementById('auth-btn').style.display = 'none';
      document.getElementById('user-info').style.display = 'flex';
      document.getElementById('user-name').textContent = this.currentUser.name;
      document.getElementById('user-picture').src = this.currentUser.picture;
    }
  }
}

// グローバルインスタンス
const app = new OrchestraApp();
```

---

## 8. 実装フェーズ

### Phase 1: バックエンド基本機能 (Week 1-2)
- ✅ FastAPI プロジェクト初期化
- ✅ AudioConverter クラス実装
- ✅ REST API エンドポイント実装
- ✅ ファイルアップロード処理

### Phase 2: Google Drive 統合 (Week 3-4)
- ✅ OAuth2 認証実装
- ✅ GoogleDriveHandler 実装
- ✅ ファイルアップロード機能
- ✅ 共有リンク生成

### Phase 3: フロントエンド開発 (Week 5-6)
- ✅ HTML/CSS レイアウト
- ✅ JavaScript ファイル処理
- ✅ API 通信実装
- ✅ UI 改善・レスポンシブ対応

### Phase 4: デプロイ & Google Sites 統合 (Week 7)
- ✅ Google Cloud Run へのデプロイ
- ✅ Docker化
- ✅ Google Sites への埋め込み
- ✅ セキュリティ強化

---

## 9. デプロイ手順

### 9.1 Google Cloud Run へのデプロイ

```bash
# 1. Google Cloud SDK をインストール
gcloud init

# 2. Docker イメージをビルド
docker build -t gcr.io/YOUR_PROJECT/orchestra-tool:latest .

# 3. イメージをプッシュ
docker push gcr.io/YOUR_PROJECT/orchestra-tool:latest

# 4. Cloud Run へデプロイ
gcloud run deploy orchestra-tool \
  --image gcr.io/YOUR_PROJECT/orchestra-tool:latest \
  --platform managed \
  --region asia-northeast1 \
  --memory 2Gi \
  --timeout 3600 \
  --set-env-vars GOOGLE_CLIENT_ID=YOUR_ID,GOOGLE_CLIENT_SECRET=YOUR_SECRET
```

### 9.2 Google Sites への埋め込み

1. Google Sites でサイトを開く
2. 「その他オプション」→「カスタムHTML」
3. 以下を埋め込む:

```html
<iframe 
  src="https://orchestra-tool.cloud.run/"
  width="100%"
  height="900px"
  frameborder="0"
  allow="microphone"
  sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-top-navigation-by-user-activation"
></iframe>
```

---

## 10. セキュリティ考慮事項

- **HTTPS 強制**: すべての通信を暗号化
- **CORS 設定**: Google Sites 専用ドメインのみ許可
- **ファイル検証**: MIME タイプ、サイズ制限
- **トークン管理**: JWT トークンに有効期限設定
- **個人情報**: ログにメールアドレス、ファイル内容を含めない
- **サニタイズ**: ファイル名の悪意あるコマンド削除

---

## 11. 今後の拡張計画

- **マルチクラウド対応**: OneDrive / Dropbox 対応
- **AI 音声分析**: 楽器別音量バランス分析
- **リアルタイムコラボ**: 複数ユーザー同時編集
- **モバイルアプリ**: iOS / Android ネイティブアプリ
- **セキュアメッセージング**: 団員間暗号化通信

---

## 12. 参考資料

- [FastAPI ドキュメント](https://fastapi.tiangolo.com/)
- [Google Drive API](https://developers.google.com/drive)
- [Google Cloud Run](https://cloud.google.com/run)
- [librosa](https://librosa.org/)
- [pydub](https://github.com/jiaaro/pydub)
- [UV](https://docs.astral.sh/uv/)
