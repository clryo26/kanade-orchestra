# Backend Import / Comment Cleanup Report

## 対応内容

### 1. `from ..app_core import *` の撤廃

以下のルーターからワイルドカード import を撤廃し、必要な依存だけを明示 import に変更しました。

- `src/backend/routers/albums.py`
- `src/backend/routers/recordings.py`
- `src/backend/routers/scores.py`

これにより、どの関数・定数・型に依存しているかがファイル先頭で分かるようになりました。

### 2. Cloud Storageストリーミング処理の共通化

`recordings.py` 内にあった Cloud Storage のRange再生・ダウンロード処理を以下へ分離しました。

- `src/backend/services/blob_streaming_service.py`

`recordings.py` と `scores.py` はこの共通サービスを参照します。

### 3. 文字化けコメントの整理

バックエンドPythonファイル内の文字化けコメントを削除・整理しました。

また、判別できる文字化け文字列は以下のように復元しました。

- `一般`
- `本番タイムテーブル.xlsx`
- `セッティング` / `設営` / `舞台`
- `司会` / `司会者` / `チケット`
- `あなたのGCSバケット名`
- ETagチェックのdocstring

## 確認内容

- Python構文チェック: `compileall` 実行済み
- `from ..app_core import *`: 残存なし
- バックエンドPythonファイル内の明確な文字化けコメント: 残存なし

## 注意点

この修正は構造整理が目的です。API仕様、画面仕様、JSON構造は変更していません。

ローカル環境では `google-cloud-storage` が未導入の場合、アプリ全体のimport確認は失敗することがあります。Cloud Run / 開発環境では依存関係をインストールした状態で確認してください。
