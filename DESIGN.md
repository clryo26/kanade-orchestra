# オーケストラ音声共有ツール 設計書

## プロジェクト概要

オーケストラの団員向けに、Webブラウザから WAV形式の音声ファイルを MP3形式に変換し、Google Driveを経由で共有・再生できるWebアプリケーション。Google Sites内に埋め込み可能で、リハーサル音声やパート別録音などを効率的に共有・再生するための統合Webツール。

---

## 1. 機能要件

### 1.1 コア機能
- **WAVファイル読み込み**: ローカルディレクトリ又はドラッグ&ドロップでのファイル選択
- **MP3変換**: WAV → MP3 (品質設定可能)
- **再生機能**: 変換したMP3ファイルの再生・停止・一時停止
- **バッチ処理**: 複数ファイルの一括変換
- **ファイル管理**: 変換済みファイルの表示・削除・エクスポート

### 1.2 拡張機能
- **品質設定**: ビットレート選択 (128kbps / 192kbps / 320kbps)
- **メタデータ編集**: タイトル・アーティスト・アルバム情報の設定
- **プレイリスト作成**: 複数曲の管理と再生順序設定
- **進捗表示**: 変換進捗のリアルタイム表示
- **キャッシング**: 既に変換したファイルの再利用

### 1.3 Google Drive統合機能
- **自動アップロード**: 変換完了後のMP3ファイルを自動でGoogleドライブに保存
- **共有リンク生成**: ワンクリックで共有可能なリンクを生成
- **アクセス管理**: 団員ごとのアクセス権限設定
- **共有履歴管理**: アップロードしたファイルの一覧表示と管理
- **オフラインアクセス**: キャッシュされたファイルのオフライン再生
- **同期機能**: Googleドライブ内のファイルをローカルに同期

---

## 2. 技術スタック

### 2.1 環境
- **OS**: Windows11 / Linux / macOS（マルチプラットフォーム対応）
- **Python**: 3.10+
- **パッケージマネージャー**: UV
- **ホスティング**: Google Cloud Run / Google Apps Script / Heroku
- **フロントエンド**: HTML5 / CSS3 / JavaScript (Vanilla / Vue.js)

### 2.2 主要ライブラリ

#### バックエンド
| 用途 | ライブラリ | バージョン |
|------|----------|----------|
| Webフレームワーク | FastAPI | latest |
| WAV読み込み | librosa / scipy | latest |
| MP3エンコード | pydub | latest |
| Google Drive API | google-api-python-client | latest |
| CORS対応 | fastapi-cors | latest |
| ログ管理 | loguru | latest |
| テスト | pytest / pytest-asyncio | latest |

#### フロントエンド
| 用途 | ライブラリ/フレームワーク | 用途 |
|------|----------|----------|
| UI フレームワーク | Vue.js 3 | リアクティブなUI |
| HTTPクライアント | axios | API通信 |
| 音声再生 | HTML5 Audio API | MP3再生 |
| UI コンポーネント | Bootstrap 5 | スタイリング |

---

## 3. アーキテクチャ設計

### 3.1 全体構成（Webアプリケーション）

```
┌─────────────────────────────────────────────────────────────┐
│                    Google Sites                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  <iframe src="https://app.example.com">              │ │
│  │    オーケストラ音声共有ツール Web版                  │ │
│  │  </iframe>                                            │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
           ↓ (HTTPS通信)
┌─────────────────────────────────────────────────────────────┐
│               Google Cloud Run (バックエンド)              │
│  FastAPI Webサーバー + 音声処理エンジン                    │
└─────────────────────────────────────────────────────────────┘
           ↓ (REST API)
┌─────────────────────────────────────────────────────────────┐
│             ブラウザ上のフロントエンド                     │
│  HTML5 / CSS3 / JavaScript (Vue.js 3)                      │
└─────────────────────────────────────────────────────────────┘
           ↓ (OAuth 認可)
┌─────────────────────────────────────────────────────────────┐
│              Google Drive / Google Cloud                    │
│  ファイルストレージ & 認証サービス                        │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 バックエンドアーキテクチャ

```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py                 # FastAPI アプリ初期化
│   ├── config.py               # 設定管理
│   │
│   ├── routes/                 # API エンドポイント
│   │   ├── converter.py         # /api/convert
│   │   ├── player.py            # /api/player
│   │   ├── drive.py             # /api/drive
│   │   └── auth.py              # /api/auth
│   │
│   ├── core/                   # ビジネスロジック
│   │   ├── audio_converter.py
│   │   ├── file_handler.py
│   │   └── metadata_handler.py
│   │
│   ├── cloud/                  # クラウド統合
│   │   ├── google_drive_handler.py
│   │   ├── auth_manager.py
│   │   └── sync_manager.py
│   │
│   └── utils/
│       ├── logger.py
│       └── validators.py
│
├── tests/
├── pyproject.toml
└── Dockerfile
```

---

## 4. モジュール設計

### 4.1 FastAPI メインアプリケーション
```python
# app/main.py
from fastapi import FastAPI
from fastapi.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.routes import converter, player, drive, auth

app = FastAPI(title="Orchestra Audio Tool")

# CORS設定（Google Sites埋め込み対応）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://sites.google.com", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ルート登録
app.include_router(converter.router, prefix="/api/convert")
app.include_router(player.router, prefix="/api/player")
app.include_router(drive.router, prefix="/api/drive")
app.include_router(auth.router, prefix="/api/auth")

# フロントエンドの静的ファイル提供
app.mount("/static", StaticFiles(directory="frontend/static"), name="static")
```

### 4.2 API エンドポイント設計
```python
# app/routes/converter.py
@router.post("/start")
async def start_conversion(file: UploadFile) -> Dict:
    """WAV → MP3 変換を開始"""
    # ファイル検証 → 変換処理 → Google Drive へアップロード
    pass

@router.get("/{job_id}")
async def get_conversion_status(job_id: str) -> Dict:
    """変換進捗を取得"""
    pass

# app/routes/drive.py
@router.post("/upload")
async def upload_to_drive(file_path: str) -> Dict:
    """ファイルを Google Drive にアップロード"""
    pass

@router.post("/share/{file_id}")
async def create_share_link(file_id: str) -> Dict:
    """共有リンクを生成"""
    pass
```

### 4.3 audio_converter.py
```python
class AudioConverter:
    def __init__(self, bitrate: int = 192):
        self.bitrate = bitrate
    
    async def convert_wav_to_mp3(self, input_path: str, output_path: str) -> bool:
        """WAV → MP3 非同期変換"""
        pass
    
    def validate_wav_file(self, file_path: str) -> bool:
        """WAVファイルのバリデーション"""
        pass
```

---

## 5. UI設計

### 5.1 メインウィンドウレイアウト
```
┌─────────────────────────────────────────────┐
│  オーケストラ音声共有ツール v1.0           │
├─────────────────────────────────────────────┤
│ [ファイル] [編集] [ヘルプ]                 │
├─────────────────────────────────────────────┤
│                                             │
│ ┌──────────────────────────────────────┐   │
│ │ 変換パネル                            │   │
│ │ [ファイル選択] [+追加]  [一括変換] │   │
│ │ ┌────────────────────────────────┐  │   │
│ │ │ ファイル一覧                   │  │   │
│ │ │ - sample1.wav (変換予定)      │  │   │
│ │ │ - sample2.wav (変換予定)      │  │   │
│ │ └────────────────────────────────┘  │   │
│ │ 品質: [192kbps ▼]                   │   │
│ │ ┌════════════════════════════════┐  │   │
│ │ │進捗: ████████░░ 60%           │  │   │
│ │ └════════════════════════════════┘  │   │
│ └──────────────────────────────────────┘   │
│                                             │
│ ┌──────────────────────────────────────┐   │
│ │ 再生パネル                            │   │
│ │ ┌────────────────────────────────┐  │   │
│ │ │ 現在再生中: sample1.mp3        │  │   │
│ │ │ アーティスト: オケA団           │  │   │
│ │ └────────────────────────────────┘  │   │
│ │ [◀] [▶ 再生] [⏸ 一時停止] [⏹ 停止] │   │
│ │ ┌════════════════════════════════┐  │   │
│ │ │██████████░░░░░░░░░░ 2:30/5:00 │  │   │
│ │ └════════════════════════════════┘  │   │
│ │ 音量: [━━━━━━━━━━━━━━] 80%         │   │
│ └──────────────────────────────────────┘   │
│                                             │
│ ┌──────────────────────────────────────┐   │
│ │ ファイル管理パネル                    │   │
│ │ ┌────────────────────────────────┐  │   │
│ │ │ 変換済みファイル                │  │   │
│ │ │ ✓ sample1.mp3 (2.5MB)         │  │   │
│ │ │ ✓ sample2.mp3 (3.1MB)         │  │   │
│ │ └────────────────────────────────┘  │   │
│ │ [削除] [エクスポート] [プレイリスト] │   │
│ └──────────────────────────────────────┘   │
│                                             ││ ┌──────────────────────────────────────┐   │
│ │ Google Drive共有パネル                │   │
│ │ ┌────────────────────────────────┐  │   │
│ │ │ 認証状態: ✓ ログイン済み        │  │   │
│ │ │ 共有フォルダ: オケツール/2024年 │  │   │
│ │ └────────────────────────────────┘  │   │
│ │ [Googleドライブで認証] [設定]      │   │
│ │ ┌────────────────────────────────┐  │   │
│ │ │ アップロード済みファイル        │  │   │
│ │ │ ✓ sample1.mp3 (2024/6/11)    │  │   │
│ │ │ ✓ sample2.mp3 (2024/6/10)    │  │   │
│ │ └────────────────────────────────┘  │   │
│ │ [コピー] [リンク生成] [権限設定]    │   │
│ └──────────────────────────────────────┘   │
│                                             │└─────────────────────────────────────────────┘
```

---

## 6. 実装フェーズ

### Phase 1: 基本機能 (Week 1-2)
- ✅ プロジェクト初期化 (UV設定)
- ✅ AudioConverterクラス実装
- ✅ AudioPlayerクラス実装
- ✅ 基本GUI (PyQt6)

### Phase 2: 機能拡張 (Week 3-4)
- ✅ FileHandlerクラス実装
- ✅ MetadataHandler実装
- ✅ バッチ処理機能
- ✅ ユニットテスト

### Phase 3: ポーランド & 最適化 (Week 5)
- ✅ UIの改善
- ✅ エラーハンドリング強化
- ✅ パフォーマンス最適化
- ✅ ドキュメント整備

### Phase 4: Google Drive統合 (Week 6-7)
- ✅ OAuth2認証実装
- ✅ GoogleDriveHandlerクラス実装
- ✅ ファイルアップロード機能
- ✅ 共有リンク生成機能
- ✅ アクセス権限管理
- ✅ 同期機能の実装
- ✅ 統合テスト

---

## 7. 依存関係管理 (UV)

### pyproject.toml
```toml
[project]
name = "orchestra-audio-tool"
version = "1.0.0"
description = "オーケストラ音声共有ツール"
requires-python = ">=3.10"

[project.dependencies]
librosa = "^0.10.0"
pydub = "^0.25.1"
PyQt6 = "^6.5.0"
pygame = "^2.2.0"
loguru = "^0.7.0"
pyyaml = "^6.0"
google-auth = "^2.25.0"
google-auth-oauthlib = "^1.1.0"
google-auth-httplib2 = "^0.2.0"
google-api-python-client = "^2.100.0"
requests = "^2.31.0"

[project.optional-dependencies]
dev = [
    "pytest = ^7.4.0",
    "pytest-cov = ^4.1.0",
    "black = ^23.7.0",
    "ruff = ^0.0.280",
]
```

---

## 8. デプロイ & 配布

### Windows11用実行ファイル化
```powershell
# PyInstallerでEXE化
uv run pyinstaller --onefile --icon=icon.ico main.py

# 配布パッケージ作成
uv build
```

---

## 9. セキュリティ & 考慮事項

- **ファイルアクセス**: ユーザーが選択したディレクトリのみアクセス
- **一時ファイル**: 変換完了後の一時ファイルは自動削除
- **メモリ管理**: 大容量ファイル処理時のストリーミング対応
- **ログ**: 個人情報を含まないログ記録

### Google Drive認証セキュリティ
- **OAuth2フロー**: ユーザーが直接Googleにログインし、アプリケーションへの限定的なアクセス権を付与
- **トークン管理**: リフレッシュトークンをセキュアに保存（OS標準の認証情報ストレージを利用）
- **権限の最小化**: 必要最小限のスコープ（drive.file）のみを要求
- **クライアントシークレット**: 設定ファイルには含めず、環境変数又は外部設定で管理
- **暗号化**: ローカルの認証情報キャッシュは暗号化して保存
- **アクセス権限監視**: 共有リンクの作成時に、明示的なユーザー承認を要求
- **監査ログ**: Google Driveへのすべてのアクセスをローカルログに記録

---

## 10. テスト戦略

### ユニットテスト
- AudioConverter: WAV形式のバリデーション、変換精度
- AudioPlayer: 再生制御、ボリューム管理
- FileHandler: ファイル操作の正確性

### 統合テスト
- 複数ファイルの一括処理
- GUI操作とのタイミング

### 動作確認環境
- Windows11 22H2以降
- Python 3.10 / 3.11 / 3.12

---

## 11. 今後の拡張計画

- **クラウド対応の拡張**: OneDrive / Dropbox / AWS S3対応
- **マルチプラットフォーム対応**: macOS、Linux対応
- **Web版の構築**: Flask / FastAPI でWebアプリケーション化
- **自動バックアップ機能**: 定期的なクラウドバックアップ
- **オーケストラ団管理システム連携**: 団員情報との自動同期
- **AI音声分析**: 楽器別の音量調整、品質改善提案
- **リアルタイムコラボレーション**: 複数ユーザーの同時編集
- **モバイルアプリ**: iOS / Android対応アプリ
- **セキュアメッセージング**: 暗号化された団員間通信

---

## 12. Google Drive統合の詳細フロー

### 初期セットアップ
1. Google Cloud Consoleでプロジェクト作成
2. OAuth 2.0 クライアントID（デスクトップアプリケーション）を取得
3. `credentials.json` をアプリケーションディレクトリに配置
4. アプリケーション起動時にユーザーに認証を促す

### ファイルアップロードフロー
1. MP3変換完了
2. 自動的に Google Drive 対象フォルダにアップロード
3. アップロード完了時に共有リンクを生成
4. 共有リンクをクリップボードにコピー（またはメール送信）

### 権限管理フロー
1. 共有リンク生成時に、アクセス権限を設定（閲覧者／編集者）
2. 特定の団員のメールアドレスを入力して権限付与
3. リンク有効期限の設定（オプション）

---

## 参考資料

- [librosa ドキュメント](https://librosa.org/)
- [pydub ドキュメント](https://github.com/jiaaro/pydub)
- [PyQt6 ドキュメント](https://www.riverbankcomputing.com/static/Docs/PyQt6/)
- [Google Drive API ドキュメント](https://developers.google.com/drive/api/guides/about-sdk)
- [Google Auth ライブラリ](https://google-auth.readthedocs.io/)
- [UV ドキュメント](https://docs.astral.sh/uv/)
