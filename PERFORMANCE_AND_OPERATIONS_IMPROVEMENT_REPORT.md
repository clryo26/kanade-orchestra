# 長期運用向け 軽量化・効率化レポート

## 実施内容

### 1. Docker build context の軽量化
`.dockerignore` を追加し、Cloud Build に不要な以下を送らないようにしました。

- `.venv/`
- `node_modules/`
- `.git/`
- Python / Node のキャッシュ
- ローカルアップロードファイル
- `.env`

これにより、Cloud Build の転送量・ビルド時間・誤混入リスクを下げます。

### 2. Git管理対象の整理
`.gitignore` を追加し、秘密情報・キャッシュ・ローカル生成物をGitに入れないようにしました。

### 3. Dockerfile の安定化
- `uv.lock` をコピーして `uv sync --frozen` を使用
- 起動時は `uv run` を挟まず `.venv/bin/uvicorn` を直接実行
- `DEBIAN_FRONTEND=noninteractive` を設定し、ビルドログの対話警告を抑制
- `sample/` をイメージへコピーし、Excel系機能の実行時欠落を防止

### 4. フロントエンド構文チェックの保守性改善
長い `node --check ...` の列挙をやめ、`scripts/check_frontend_syntax.mjs` で `src/static/js` 配下のJSを自動チェックするようにしました。

### 5. ローカル起動時のPORT対応
`python src/backend/main.py` 実行時も `PORT` 環境変数を読むようにしました。

### 6. 起動時プリロードの調整機能
Cloud Runのコールドスタート対策として、以下の環境変数を追加しました。

- `STARTUP_PRELOAD_ENABLED=false` で起動時プリロードを停止
- `STARTUP_PRELOAD_COLLECTIONS=performances,schedules` のようにプリロード対象を指定

通常運用では既定値のままで動作します。データ量が増えてコールドスタートが遅い場合に調整してください。

## 次におすすめする改善

1. Repository層を本格導入し、JSON/DBアクセスを完全に集約
2. `app_core.py` のデータアクセス処理を `repositories/` と `services/` へ分離
3. 録音・楽譜・アルバムのメタデータをDBへ移行
4. 管理者操作の監査ログをDB化
5. Cloud Runの最小インスタンス設定を検討
