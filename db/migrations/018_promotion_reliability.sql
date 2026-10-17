-- Additive only. Existing promotions are reset separately under maintenance.
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS image_asset_id UUID;

DO $$
DECLARE seq_name TEXT; current_value BIGINT; max_id BIGINT;
BEGIN
    seq_name := pg_get_serial_sequence('promotions', 'id');
    IF seq_name IS NULL THEN
        CREATE SEQUENCE IF NOT EXISTS promotion_id_seq;
        ALTER SEQUENCE promotion_id_seq OWNED BY promotions.id;
        ALTER TABLE promotions ALTER COLUMN id SET DEFAULT nextval('promotion_id_seq');
        seq_name := 'promotion_id_seq';
    END IF;
    EXECUTE format('SELECT last_value FROM %s', seq_name) INTO current_value;
    SELECT COALESCE(MAX(id), 0) INTO max_id FROM promotions;
    PERFORM setval(seq_name, GREATEST(current_value, max_id, 1), true);
END $$;

CREATE TABLE promotion_operations (
    organization_id TEXT NOT NULL, actor_key TEXT NOT NULL, operation_id UUID NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('POST','PUT','DELETE')), target_id BIGINT,
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    state TEXT NOT NULL CHECK (state IN ('processing','succeeded','rejected')),
    attempt_id UUID NOT NULL, lease_until TIMESTAMPTZ NOT NULL,
    result_status SMALLINT, result_body JSONB, error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, actor_key, operation_id),
    CHECK ((state = 'processing' AND result_status IS NULL AND result_body IS NULL)
        OR (state <> 'processing' AND result_status IS NOT NULL AND result_body IS NOT NULL))
);
CREATE INDEX promotion_operations_lease ON promotion_operations(state, lease_until);

CREATE TABLE promotion_image_assets (
    asset_id UUID PRIMARY KEY, organization_id TEXT NOT NULL, promotion_id BIGINT,
    operation_id UUID NOT NULL, actor_key TEXT NOT NULL, attempt_id UUID NOT NULL,
    object_name TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL,
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0), sha256 TEXT NOT NULL,
    storage_generation BIGINT,
    state TEXT NOT NULL CHECK (state IN ('staged','active','retired','delete_pending','deleted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), retired_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0), last_error_code TEXT,
    UNIQUE (organization_id, asset_id),
    FOREIGN KEY (organization_id, actor_key, operation_id)
        REFERENCES promotion_operations(organization_id, actor_key, operation_id)
);
ALTER TABLE promotions ADD CONSTRAINT promotion_image_same_org
    FOREIGN KEY (organization_id, image_asset_id)
    REFERENCES promotion_image_assets(organization_id, asset_id);
CREATE INDEX promotion_images_cleanup ON promotion_image_assets(state, next_attempt_at);
CREATE INDEX promotion_images_reconcile ON promotion_image_assets(state, last_checked_at);
CREATE INDEX promotions_list_order ON promotions(organization_id, created_at DESC, id DESC);

CREATE TABLE promotion_reset_runs (
    run_id UUID PRIMARY KEY, environment_id TEXT NOT NULL, organization_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared','db_deleted','cleaning','completed')),
    manifest_hash TEXT NOT NULL, item_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    db_deleted_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX promotion_reset_active ON promotion_reset_runs(environment_id, organization_id)
    WHERE state <> 'completed';
CREATE TABLE promotion_reset_items (
    item_id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES promotion_reset_runs(run_id),
    promotion_id BIGINT, kind TEXT NOT NULL CHECK (kind IN ('promotion','object')),
    object_name TEXT, storage_generation BIGINT, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','deleted','missing','needs_review')),
    retry_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ, last_error_code TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (run_id, kind, fingerprint)
);
