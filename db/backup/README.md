# DBバックアップ／リストア手順

## 事前準備

`pg_dump` / `pg_restore` が使える環境で実行してください。
Cloud SQLを使う場合は、Cloud SQL Auth Proxy または Cloud Shell からの実行を推奨します。

## バックアップ

```bash
python scripts/backup_db.py
```

環境変数:

- `DB_URL` または `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD`
- `DB_BACKUP_DIR` 任意。未指定時は `db/backups/`

## リストア

```bash
python scripts/restore_db.py db/backups/oke_portal_YYYYMMDD_HHMMSS.dump
```

リストアは既存オブジェクトを削除して復元します。必ず本番DBでは事前確認してください。
