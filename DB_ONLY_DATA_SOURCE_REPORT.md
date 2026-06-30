# DB Only Data Source Report

## 変更目的

JSONファイルとDBの併用状態を解消し、通常運用ではDBを唯一のデータ参照・更新先にする。

## 主な変更

- `load_json_data()` は通常時、ローカルJSONを読まないよう変更。
- `save_json_data()` は通常時、ローカルJSONへ書き込まないよう変更。
- `DATA_BACKEND=db` を標準とし、DB未設定時はエラーにするよう変更。
- `LOCAL_JSON_FALLBACK_ENABLED=true` または `DATA_BACKEND=local` の時だけ、緊急ローカル開発用としてJSONを利用可能。
- 専用DBテーブルがあるコレクションは既存のDBテーブルを利用。
- 専用DBテーブルが未実装のコレクションは `portal_json_collections` のJSONBに保存。
- `.dockerignore` / `.gitignore` で `src/data/*.json` を除外し、Cloud RunへローカルJSONが混入しにくいよう変更。
- `.env.example` にDB必須設定を追加。

## 追加テーブル

```sql
CREATE TABLE IF NOT EXISTS portal_json_collections (
    collection_name TEXT PRIMARY KEY,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## 本番環境で必要な環境変数

```env
DATA_BACKEND=db
DB_REQUIRED=true
DB_URL=postgresql://...
```

または

```env
DATA_BACKEND=db
DB_REQUIRED=true
DB_HOST=...
DB_NAME=...
DB_USER=...
DB_PASSWORD=...
DB_SSLMODE=require
```

## 注意

`DATA_BACKEND=local` は緊急ローカル開発専用。Cloud Runでは使用しないこと。
