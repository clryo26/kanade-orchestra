-- JST remediation S11/S16 (spec R05-A/R05-B/R06/R06-A): file operations and
-- confirmed asset references for desired-piece reference scores and common
-- images (member photo, performance flyer, organization icon).
--
-- Expand only: new tables and indexes. Existing tables/columns are not
-- altered, so the previous application revision keeps working unchanged.
-- The confirmed reference of an owner row is the single 'active' asset per
-- (organization, kind, owner) enforced by a partial unique index (a dedicated
-- reference table instead of new columns on business tables).

CREATE TABLE IF NOT EXISTS portal_file_operations (
    organization_id TEXT NOT NULL,
    actor_key TEXT NOT NULL,
    operation_id UUID NOT NULL,
    kind TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('POST', 'PUT', 'DELETE')),
    target_id BIGINT NULL,
    view_scope TEXT NOT NULL DEFAULT 'owner' CHECK (view_scope IN ('owner', 'admin')),
    request_hash TEXT NOT NULL,
    hash_version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL CHECK (state IN ('processing', 'succeeded', 'rejected')),
    attempt_id UUID NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL,
    result_status INTEGER NULL,
    result_body JSONB NULL,
    result_expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, actor_key, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_file_operations_state_lease
    ON portal_file_operations (organization_id, state, lease_until);

CREATE INDEX IF NOT EXISTS idx_portal_file_operations_result_expiry
    ON portal_file_operations (organization_id, result_expires_at)
    WHERE result_body IS NOT NULL;

CREATE TABLE IF NOT EXISTS portal_file_assets (
    asset_id UUID PRIMARY KEY,
    organization_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
        'desired_piece_reference_score', 'member_photo', 'performance_flyer', 'org_icon'
    )),
    owner_id BIGINT NULL,
    actor_key TEXT NOT NULL,
    operation_id UUID NOT NULL,
    attempt_id UUID NOT NULL,
    object_name TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('gcs', 'local')),
    filename TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL,
    byte_size BIGINT NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    storage_generation BIGINT NULL,
    state TEXT NOT NULL CHECK (state IN ('staged', 'active', 'retired', 'delete_pending', 'deleted')),
    legacy BOOLEAN NOT NULL DEFAULT FALSE,
    legacy_evidence JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    activated_at TIMESTAMPTZ NULL,
    retired_at TIMESTAMPTZ NULL,
    deleted_at TIMESTAMPTZ NULL,
    last_checked_at TIMESTAMPTZ NULL,
    next_attempt_at TIMESTAMPTZ NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT NULL,
    UNIQUE (organization_id, asset_id),
    FOREIGN KEY (organization_id, actor_key, operation_id)
        REFERENCES portal_file_operations (organization_id, actor_key, operation_id)
);

-- Idempotent for local instances where the unreleased 022 was already tested.
-- A reader extends this under the same row lock used by cleanup, then commits
-- before storage I/O; retirement does not clear it.
ALTER TABLE portal_file_assets
    ADD COLUMN IF NOT EXISTS read_protected_until TIMESTAMPTZ NULL;

-- One confirmed (delivered) asset per owner and kind.
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_file_assets_active_owner
    ON portal_file_assets (organization_id, kind, owner_id)
    WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_portal_file_assets_owner
    ON portal_file_assets (organization_id, kind, owner_id, state);

CREATE INDEX IF NOT EXISTS idx_portal_file_assets_reconcile
    ON portal_file_assets (organization_id, state, next_attempt_at);
