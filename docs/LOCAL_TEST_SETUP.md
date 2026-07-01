# LOCAL_TEST_SETUP

最終更新: 2026-07-01

## 目的

ZIP展開後に会社PC/個人PCで同じ手順でテスト実行できるようにする。

## 前提

- OS: Windows 11
- Python: uv 管理
- Node.js: npm 実行可能
- 作業ディレクトリ: リポジトリルート

## 初期セットアップ（ZIP展開後）

1. ZIP を展開する
2. `.env.example` を参考に `.env` を作成する（`.env` は共有しない）
3. Python依存を入れる

```bash
uv sync
```

4. Node依存を入れる

```bash
npm install
```

## テスト実行

補足:

- `uv sync` だけだと dev 依存が外れ、`pytest` が未導入になる場合がある。
- その場合は先に `uv sync --extra dev` を実行する。

### Backend

```bash
pytest
```

### Frontend

```bash
npm run test:frontend
```

### E2E (Playwright)

```bash
npx playwright install chromium
npm run test:e2e
```

ブラウザインストールが難しい環境では、以下を最低限実施する。

```bash
python -m compileall -q src/backend tests
pytest
npm run check:frontend:syntax
npm run test:frontend
```

## 推奨追加確認

```bash
npm run check:frontend:syntax
python -m compileall -q src/backend tests
```

## 典型エラーと対処

### `ModuleNotFoundError: No module named 'psycopg'`

- 原因: Python依存未導入
- 対処: `uv sync` を先に実行

### `No module named pytest`

- 原因: `uv sync` 後に dev 依存が未導入
- 対処: `uv sync --extra dev` を再実行してから `pytest`

### `vitest: command not found` または `Cannot find module 'vitest'`

- 原因: Node依存未導入
- 対処: `npm install` を先に実行

### `UnicodeDecodeError`（Windows環境）

- 原因: 文字コード設定不足
- 対処: `PYTHONUTF8=1` を設定してから Python コマンドを実行

## 会社PC向けメモ

- 社内プロキシー環境では依存取得に時間がかかる場合がある
- 先に `uv sync` と `npm install` を完了してからテストに進む
- ネットワーク制限時は、まず `compileall` と `check:frontend:syntax` を実行して構文健全性を確認する
