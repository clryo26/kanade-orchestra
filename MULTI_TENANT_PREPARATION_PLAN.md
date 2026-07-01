# Multi-Tenant Preparation Plan

最終更新: 2026-07-01

## 1. 目的

単一団体前提の現行構成を壊さず、将来のマルチテナント（複数オーケストラ共存）に備える。

対象:
- 長期運用（監査・バックアップ・障害切り分け）
- 機能拡張（tenant-aware service/repository）
- データ分離（organization_id）

## 2. 非機能要件（準備段階）

- 既存 API path は変更しない
- 既存 UI は変更しない
- 既存 DB スキーマの破壊的変更は行わない
- デフォルト tenant は `default` を使用し、非対応クライアントでも動作継続

## 3. ターゲット設計

### 3.1 Tenant Context

- リクエストヘッダ:
  - `X-Organization-Id`（推奨）
  - `X-Tenant-Id`（後方互換）
- 未指定時: `default`
- FastAPI `request.state.tenant_context` に格納

### 3.2 organization_id 追加対象（優先）

- members
- auth_devices
- performances
- performance_pieces
- schedules
- announcements
- events
- absences
- event_responses
- payments
- castings
- piece_infos
- practice_instructions
- desired_pieces
- promotions
- albums
- album_photos
- sheet_library
- drive_files
- recording_metadata
- date_adjustments
- date_adjustment_candidates
- date_adjustment_responses
- part_settings
- venue_settings
- org_settings
- sns_settings
- connection_settings
- access_logs

## 4. 段階移行計画

### Phase 0: 設計・ガード（実施済み/進行中）

- tenant context middleware を追加（非破壊）
- dependency で tenant context 取得関数を提供
- CI/ローカルで profile 前提を固定

### Phase 1: DB 非破壊拡張

1. 各対象テーブルへ `organization_id TEXT NOT NULL DEFAULT 'default'` を追加
2. 主要検索カラムに複合indexを追加

例:
```sql
ALTER TABLE members ADD COLUMN IF NOT EXISTS organization_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_members_org_id_id ON members(organization_id, id);
```

### Phase 2: Repository tenant-aware 化

- 全 repository read/write に `organization_id` 条件を導入
- upsert/delete/lookup を tenant スコープ内に限定
- 監査ログに organization_id を記録

### Phase 3: Auth/Permission tenant対応

- auth_devices と members の照合に organization_id を導入
- role permission を organization スコープで評価

### Phase 4: File path tenant prefix

- GCS object path を `org/{organization_id}/...` 形式へ移行
- 既存オブジェクトは fallback 読み取りを維持

## 5. 移行リスクと対策

- リスク: tenant 条件漏れによるデータ越境
  - 対策: repository 契約テストで tenant 隔離を必須化
- リスク: 既存クライアント互換破壊
  - 対策: organization_id 未指定時 default tenant を使用
- リスク: 既存ファイル参照切れ
  - 対策: tenant prefix 未適用オブジェクトの互換読み取りを維持

## 6. 受け入れ基準

- tenant 未指定クライアントで既存機能が全て動作する
- tenant 指定時に read/write が organization_id で完全分離される
- repository 契約テストで cross-tenant 参照が失敗する
- 主要CRUDとbootstrapの回帰テストが通る

## 7. 初期実装タスク（短期）

1. migration 雛形作成（organization_id + index）
2. repository 契約テスト追加（tenant 隔離前提）
3. auth/service/repository の organization_id 引数受け渡し整備
4. access_logs に organization_id 追加
5. GCS path tenant prefix 導入（読み取り互換維持）
