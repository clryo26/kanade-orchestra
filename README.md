# オーケストラ活動管理ツール

オーケストラの団員向けWebアプリケーション。管理者がWAV形式の音声ファイルをMP3形式に変換して、Google Cloud Storageを経由で共有・再生できます。

## Version 5.1 安定化方針

- データソースは DB Only（PostgreSQL）を標準とする
- 本番フロントエンドは `src/static/js/main.js` を利用する
- `src/static/js/app.js` はテスト互換のためにのみ保持し、新規機能は追加しない
- `src/static/js/app.js` へ新規実装禁止
- CI 成功コミットのみデプロイ可能とする
- Cloud Run 起動互換（`src.backend.main:app`）を維持する

## Frontend Phase3 方針

- 巨大だった `src/static/js/app.js` は互換ローダー化し、本番ロジックは保持しない
- 本番フロント処理は `src/static/js/main.js` と `src/static/js/modules/` / `src/static/js/utils/` / `src/static/js/store/` に集約する
- pure helper は `src/static/js/frontend_testable_logic.js` を正とし、Vitest で直接検証する
- `src/static/js/main.js` は runtime context 存在確認を行う最小ブリッジとして維持する

## appState 移行方針（Phase4）

- 正式な共有状態名は `window.portalAppState` とする
- `window.appState` は互換 alias としてのみ維持する
- 新規コードは `window.getAppState()` または `window.portalRuntimeContext.appState` 経由で参照する
- 新規実装で `window.appState` へ直接アクセスする実装を追加しない

## Phase5 分割状況（2026-07-01）

- `src/static/js/modules/date_piece_promotion.js` は薄い互換ローダー化し、
  `modules/date_piece_promotion/state.js` / `api.js` / `render.js` へ責務を追加分割した
- `src/static/js/modules/admin_system.js` は薄い互換ローダー化し、
  `modules/admin_system/render.js` / `api.js` / `database_viewer.js` / `diagnostics.js` へ責務を追加分割した
- `src/backend/app_core.py` は互換面維持を優先して段階的に薄化し、現在は 500 行近傍（513 行）

## Phase6 分割状況（2026-07-01）

- `src/static/js/modules/navigation.js` は薄い互換ローダー化し、
  `modules/navigation/helpers.js` / `tabs.js` / `menu.js` / `routes.js` / `events.js` へ責務を追加分割した
- `src/static/js/modules/members.js` は薄い互換ローダー化し、
  `modules/members/helpers.js` / `form.js` / `api.js` / `render.js` / `events.js` へ責務を追加分割した
- `src/static/js/modules/practice_casting.js` は薄い互換ローダー化し、
  `modules/practice_casting/helpers.js` / `api.js` / `render.js` / `events.js` へ責務を追加分割した
- `src/static/js/frontend_testable_logic.js` は互換集約レイヤー化し、
  `src/static/js/testable/` 配下へ pure helper を分離した
- `src/backend/app_core.py` は 503 行まで薄化したが、400 行以下は安全優先で未実施

## Phase7 品質保証・本番準備（2026-07-01）

- Playwright E2E 基盤を追加（`playwright.config.js`, `tests/e2e/*`）
- 主要導線の smoke テストを追加（トップ表示、ログイン、団員/管理メニュー遷移）
- CI は軽量テストを `ci.yml`、E2E を `e2e.yml` に分離
- 本番前チェックリストを追加（`docs/PRODUCTION_RELEASE_CHECKLIST.md`）
- 追加分割候補の棚卸しを作成（`docs/PHASE7_REFACTORING_CANDIDATES.md`）
- 社内プロキシ環境向けに E2E 実行時のローカル通信プロキシ除外と Playwright ダウンロード設定を整備

## ローカルテスト手順

- 詳細手順: [docs/LOCAL_TEST_SETUP.md](docs/LOCAL_TEST_SETUP.md)
- 最短手順:

```bash
uv sync
npm install
pytest
npm run test:frontend
npx playwright install chromium
npm run test:e2e
```

社内プロキシ環境で Playwright ブラウザ取得が失敗する場合の例:

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED='0'
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
$env:NO_PROXY='127.0.0.1,localhost'
$env:no_proxy='127.0.0.1,localhost'
npx playwright install chromium
npm run test:e2e
```

## 共有ZIP

- 共有用ソースZIP作成手順: [docs/SOURCE_SHARE_ZIP.md](docs/SOURCE_SHARE_ZIP.md)
- 共有ZIPには `.env.example` を含め、`.env` / `.env.local` は含めない
- ローカル依存セットアップ手順: [docs/LOCAL_TEST_SETUP.md](docs/LOCAL_TEST_SETUP.md)
- Phase5 分割レポート: [docs/PHASE5_REFACTORING_REPORT.md](docs/PHASE5_REFACTORING_REPORT.md)
- Phase6 分割レポート: [docs/PHASE6_REFACTORING_REPORT.md](docs/PHASE6_REFACTORING_REPORT.md)
- Phase7 QA/本番準備レポート: [docs/PHASE7_QA_AND_RELEASE_REPORT.md](docs/PHASE7_QA_AND_RELEASE_REPORT.md)

## 🎵 主な機能

### 管理者機能
- **📤 録音管理**: WAV/MP3ファイルをMP3に変換（128/192/320kbps）
- **🎭 演奏会情報管理**: 演奏会の詳細情報と演奏曲を登録・管理
- **📅 スケジュール管理**: 練習スケジュールを作成・編集・削除
- **📢 お知らせ管理**: 団員向けのお知らせを配信

### 団員機能
- **📢 お知らせ**: 管理者が配信したお知らせを確認
- **🎭 演奏会情報**: 登録された演奏会の詳細を確認
- **📅 練習スケジュール**: 今後の練習予定を確認
- **🎵 録音部屋**: 日付・曲ごとに階層化された音声ファイルを再生・ダウンロード

## 🛠️ 技術スタック

| レイヤー | 技術 |
|---------|------|
| **フロントエンド** | HTML5, CSS3, Bootstrap 5, Vanilla JavaScript |
| **バックエンド** | FastAPI (Python 3.10+) |
| **音声処理** | pydub, librosa |
| **クラウドストレージ** | Google Cloud Storage |
| **認証** | Google OAuth 2.0 |
| **デプロイ** | Google Cloud Run (Docker) |
| **パッケージ管理** | UV |

## 📋 システム要件

- Python 3.10以上
- Windows 11（開発環境）
- ffmpeg（音声変換用）
- UV（パッケージマネージャー）

## 🚀 セットアップ手順

### 1. UVのインストール（Windows 11 PowerShell）

```powershell
$ProgressPreference = 'SilentlyContinue'
irm https://astral.sh/uv/install.ps1 | iex
```

### 2. プロジェクトの依存関係をインストール

```bash
cd c:\Users\owner\Desktop\オケツール
uv sync
```

### 2.1 テスト実行前のセットアップ（推奨）

```bash
# 開発・テスト依存（pytest / ruff / psycopg など）
uv sync --extra dev
```

`psycopg` 未導入のまま DB モードのテストを実行すると、
DB 接続関連で失敗します。`uv sync --extra dev` を先に実行してください。

### 3. ffmpegのインストール（オプション）

```bash
# winget経由でインストール
winget install ffmpeg

# またはchocolatey経由
choco install ffmpeg
```

### 4. バックエンドサーバーの起動

```bash
uv run python src/backend/main.py
```

または

```bash
uv run uvicorn src.backend.main:app --host 0.0.0.0 --port 8080 --reload
```

### 5. ブラウザでアクセス

```
http://localhost:8080
```

## 📁 プロジェクト構造

```
オケツール/
├── DESIGN_WEB.md           # 設計書
├── AGENTS.md               # エージェント設定
├── pyproject.toml          # プロジェクト設定（UV）
├── README.md               # このファイル
└── src/
    ├── index.html          # メインHTMLファイル
    ├── static/
    │   ├── css/
    │   │   └── style.css   # スタイルシート
    │   └── js/
    │       ├── main.js     # 本番JavaScriptエントリポイント
    │       └── app.js      # deprecated（テスト互換のみ）
    ├── backend/
    │   ├── main.py         # FastAPPサーバー
    │   └── requirements.txt # 依存パッケージ
    ├── uploads/            # アップロードファイル保存先
    └── data/               # DB Only移行に伴い本番では未使用
```

## 📡 APIエンドポイント

### 演奏会情報

| メソッド | エンドポイント | 説明 |
|---------|--------------|------|
| GET | `/api/performances` | 全演奏会を取得 |
| POST | `/api/performances` | 新規演奏会を作成 |
| GET | `/api/performances/{id}` | 特定の演奏会を取得 |
| PUT | `/api/performances/{id}` | 演奏会を更新 |
| DELETE | `/api/performances/{id}` | 演奏会を削除 |

### スケジュール

| メソッド | エンドポイント | 説明 |
|---------|--------------|------|
| GET | `/api/schedules` | 全スケジュールを取得 |
| POST | `/api/schedules` | 新規スケジュールを作成 |
| GET | `/api/schedules/{id}` | 特定のスケジュールを取得 |
| PUT | `/api/schedules/{id}` | スケジュールを更新 |
| DELETE | `/api/schedules/{id}` | スケジュールを削除 |

### お知らせ

| メソッド | エンドポイント | 説明 |
|---------|--------------|------|
| GET | `/api/announcements` | 全お知らせを取得 |
| POST | `/api/announcements` | 新規お知らせを作成 |
| GET | `/api/announcements/{id}` | 特定のお知らせを取得 |
| PUT | `/api/announcements/{id}` | お知らせを更新 |
| DELETE | `/api/announcements/{id}` | お知らせを削除 |

### ファイル変換

| メソッド | エンドポイント | 説明 |
|---------|--------------|------|
| POST | `/api/convert` | 音声ファイルを変換 |

### Google Cloud Storage連携

| メソッド | エンドポイント | 説明 |
|---------|--------------|------|
| POST | `/api/drive/upload` | Google Cloud Storageにアップロード |
| GET | `/api/drive/files` | Cloud Storage上のファイル一覧を取得 |

## 🔐 Google認証設定（今後の実装）

1. [Google Cloud Console](https://console.cloud.google.com) でプロジェクトを作成
2. OAuth 2.0認証情報（クライアントID、クライアントシークレット）を取得
3. `.env` ファイルに認証情報を設定

```
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:8080/auth/callback
```

## 🧪 テスト実行

```bash
# テストの実行
uv run pytest

# カバレッジ付きでテスト
uv run pytest --cov=src/backend
```

## 📝 コード品質管理

```bash
# コードの自動フォーマット
uv run black src/

# リント（問題検出）
uv run ruff check src/

# 型チェック
uv run mypy src/
```

## 🧭 コメント規約（関数・変数）

可読性を維持するため、以下の規約を全ファイルで適用します。

### 関数コメント
- 各関数の直前に「何をする関数か」を1〜2行で記載する
- 必要に応じて「副作用（状態更新、保存、通信）」を1行追加する
- 実装手順の逐次説明ではなく、責務と入出力の意図を書く

例:

```js
// 団員タブを表示し、必要に応じて表示用データを再描画する。
// 副作用: 画面表示状態と localStorage のロール情報を更新する。
async function showMemberTab(tabName, shouldRender = true) {
  ...
}
```

### 変数コメント
- 共有状態（例: appState）や意味が推測しにくい変数には用途コメントを付ける
- フラグ変数は「何が true/false なのか」を明記する
- 配列・辞書は「何の一覧/何をキーにしたマップか」を明記する

例:

```js
// 録音一覧のロード完了フラグ。
recordingsLoaded: false,
```

### 運用ルール
- 新規追加する関数は、原則コメント付きで追加する
- 既存関数を大きく変更した場合は、コメントも同時に更新する
- コメントと実装が矛盾した場合は、実装変更時にコメントを必ず追随させる

## 🐳 Docker対応デプロイ

```dockerfile
# Dockerfile例（実装予定）
FROM python:3.10-slim

WORKDIR /app

COPY pyproject.toml ./
COPY src/ ./src/

RUN pip install uv && uv sync

CMD ["uv", "run", "python", "src/backend/main.py"]
```

## 🚢 Google Cloud Runへのデプロイ（実装予定）

```bash
# イメージのビルド
gcloud builds submit --tag gcr.io/PROJECT_ID/orchestra-tool

# Cloud Runへのデプロイ
gcloud run deploy orchestra-tool \
  --image gcr.io/PROJECT_ID/orchestra-tool \
  --platform managed \
  --region asia-northeast2
```

## 📚 開発ドキュメント

詳細な設計書は [DESIGN_WEB.md](DESIGN_WEB.md) を参照してください。

- セクション1：プロジェクト概要と要件
- セクション2：技術スタック
- セクション3：アーキテクチャ
- セクション4：バックエンド API仕様
- セクション5：フロントエンド設計

## 🤝 貢献

バグ報告や機能提案は、プロジェクトのissueで受け付けています。

## 📄 ライセンス

MIT License

## 👥 チーム

- Orchestra Development Team

## 📧 お問い合わせ

質問や提案がある場合は、プロジェクトマネージャーまでお問い合わせください。

---

**最終更新**: 2026-06-12
**バージョン**: 1.0.0
