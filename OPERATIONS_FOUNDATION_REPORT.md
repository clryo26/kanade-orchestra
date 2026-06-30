# DB運用基盤改善レポート

## 実装内容

以下を一括で追加しました。

1. DBマイグレーション管理
2. バックアップ／リストア機能
3. 監査ログ
4. 権限管理の土台
5. パフォーマンス改善（DBインデックス・キャッシュ・ページング）

## 追加ファイル

- `db/migrations/001_schema_migrations.sql`
- `db/migrations/002_operations_foundation.sql`
- `db/migrations/003_performance_indexes.sql`
- `scripts/migrate_db.py`
- `scripts/backup_db.py`
- `scripts/restore_db.py`
- `db/backup/README.md`
- `src/backend/services/audit_service.py`
- `OPERATIONS_FOUNDATION_REPORT.md`

## 追加API

システム管理者のみ利用できます。

- `GET /api/system/database/migrations`
- `GET /api/system/audit-logs`
- `GET /api/system/role-permissions`
- `PUT /api/system/role-permissions`
- `POST /api/system/cache/clear`

## マイグレーション実行

Cloud SQL Auth Proxy または Cloud Shell 等、DBへ接続できる環境で実行します。

```bash
python scripts/migrate_db.py
```

必要な環境変数:

- `DB_URL`

または

- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`

## バックアップ

```bash
python scripts/backup_db.py
```

`pg_dump` が必要です。

## リストア

```bash
python scripts/restore_db.py db/backups/oke_portal_YYYYMMDD_HHMMSS.dump
```

`pg_restore` が必要です。

## 監査ログ

`AUDIT_LOG_ENABLED=true` の場合、`POST` / `PUT` / `PATCH` / `DELETE` のAPI呼び出しを `audit_logs` に記録します。

保存内容:

- 操作端末ID
- 団員ID/団員名
- 権限
- HTTPメソッド
- パス
- ステータスコード
- 対象推定
- User-Agent
- IPアドレス
- 作成日時

## 権限管理

`role_permissions` テーブルを追加しました。

初期ロール:

- システム管理者
- 管理者
- 会計
- インペク
- パートリーダー
- 録音係
- 楽譜係
- 団員

現時点では既存の権限判定と互換を維持しつつ、今後ロールベース権限管理へ移行しやすい土台として追加しています。

## パフォーマンス改善

以下のような検索・一覧表示に効くインデックスを追加しました。

- 演奏会日付
- 練習日
- 団員名/パート
- 欠席連絡
- イベント回答
- 支払い状況
- 録音日/曲名
- 楽譜ライブラリ演奏会ID
- 監査ログ

また、`POST /api/system/cache/clear` でメモリキャッシュを手動クリアできます。

## 運用上の注意

本番DBに対して実行する前に、必ずバックアップを取得してください。

```bash
python scripts/backup_db.py
python scripts/migrate_db.py
```

既に適用済みのマイグレーションSQLは編集しないでください。変更が必要な場合は、新しい番号のSQLを追加してください。
