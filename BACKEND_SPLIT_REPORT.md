# Backend split report

## 実施内容

`src/backend/app_core.py` の肥大化を抑えるため、リスクの低い領域から分割しました。

### 追加ファイル

- `src/backend/models/schemas.py`
  - FastAPI/Pydantic のリクエスト・レスポンスモデルを集約
  - `Performance`, `Schedule`, `Announcement`, `Member` などを移動

- `src/backend/services/memory_cache.py`
  - JSONコレクション用のインメモリキャッシュ `MemoryCache` を移動

- `src/backend/services/security_service.py`
  - パスワードハッシュ・検証処理を移動
  - `hash_password`, `verify_password`, `is_hashed_password`

### 変更ファイル

- `src/backend/app_core.py`
  - 上記3領域を外部モジュールから import する形へ変更
  - 既存API URL、JSON構造、GCS連携、Cloud Run起動方式は変更なし

## 方針

今回の分割は、動作影響を最小化するために以下を守っています。

- API URLは変更しない
- JSONファイル構造は変更しない
- フロントエンドの呼び出し先は変更しない
- 既存router構成は維持
- `app_core.py` から参照される名前は引き続き同じ名前で利用可能

## 確認内容

- Python構文チェック実施済み
  - `python3 -m py_compile src/backend/**/*.py`

ローカル環境では `google-cloud-storage` 等の依存ライブラリが未導入のため、実アプリ起動確認は依存関係をインストールした環境で実施してください。

## 次に分割するとよい領域

1. GCS・ファイル処理
   - `recording_file_bytes`
   - `sheet_file_bytes`
   - `stream_storage_blob`
   - `convert_path_to_mp3`

2. JSON/DBアクセス
   - `load_json_data`
   - `save_json_data`
   - `db_load_json_data`
   - `db_replace_collection`

3. bootstrap/system API
   - `/api/bootstrap*`
   - `/api/system/*`
   - `/api/maintenance/*`

今回の変更で、次の段階のRepository化・DB移行に入りやすくなっています。
