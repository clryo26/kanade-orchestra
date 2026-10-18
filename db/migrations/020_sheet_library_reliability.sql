-- Sheet library reliability (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md).
-- Additive only: existing sheets, categories (performance/piece/part) and
-- their view/download URLs are kept. Whole-list saves are replaced by row
-- operations in the application; this file adds the state they need.

ALTER TABLE sheet_library ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE sheet_library ADD COLUMN IF NOT EXISTS file_id UUID;
ALTER TABLE sheet_library ADD COLUMN IF NOT EXISTS storage_generation BIGINT;
ALTER TABLE sheet_library ADD COLUMN IF NOT EXISTS sha256 TEXT;

-- IDs are assigned by the database only (no application next_id()).
DO $$
DECLARE seq_name TEXT; current_value BIGINT; max_id BIGINT;
BEGIN
    seq_name := pg_get_serial_sequence('sheet_library', 'id');
    IF seq_name IS NULL THEN
        CREATE SEQUENCE IF NOT EXISTS sheet_library_id_seq;
        ALTER SEQUENCE sheet_library_id_seq OWNED BY sheet_library.id;
        ALTER TABLE sheet_library ALTER COLUMN id SET DEFAULT nextval('sheet_library_id_seq');
        seq_name := 'sheet_library_id_seq';
    END IF;
    EXECUTE format('SELECT last_value FROM %s', seq_name) INTO current_value;
    SELECT COALESCE(MAX(id), 0) INTO max_id FROM sheet_library;
    PERFORM setval(seq_name, GREATEST(current_value, max_id, 1), true);
END $$;

-- Every existing row gets a stable file identity (the stored object itself is
-- not touched). Two legacy rows may point at the same object; deletion checks
-- references by object/path, never by row alone.
UPDATE sheet_library SET file_id = gen_random_uuid() WHERE file_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sheet_library_file_id ON sheet_library(file_id);
CREATE INDEX IF NOT EXISTS sheet_library_org_list ON sheet_library(organization_id, performance_id, piece, id);

-- One list update number per organization, raised in the same transaction as
-- every committed change of sheet_library (readers compare it, not caches).
CREATE TABLE sheet_library_state (
    organization_id TEXT PRIMARY KEY,
    list_version BIGINT NOT NULL CHECK (list_version >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO sheet_library_state (organization_id, list_version)
SELECT DISTINCT organization_id, 1 FROM sheet_library
ON CONFLICT (organization_id) DO NOTHING;

-- Idempotent operations (upload / part / bulk part / delete). A resend with
-- the same key returns the stored result; a different request under the same
-- key is a conflict. Only the attempt holding the lease may finish it.
CREATE TABLE sheet_operations (
    organization_id TEXT NOT NULL,
    actor_key TEXT NOT NULL,
    operation_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('upload','part','bulk_part','delete')),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    state TEXT NOT NULL CHECK (state IN ('processing','succeeded','rejected')),
    attempt_id UUID NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL,
    result_status SMALLINT,
    result_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, actor_key, operation_id),
    CHECK ((state = 'processing' AND result_status IS NULL AND result_body IS NULL)
        OR (state <> 'processing' AND result_status IS NOT NULL AND result_body IS NOT NULL))
);
CREATE INDEX sheet_operations_lease ON sheet_operations(state, lease_until);
CREATE INDEX sheet_operations_age ON sheet_operations(updated_at);

-- Stored files with their lifecycle. A file is published (active) only after
-- its upload was confirmed; retired/staged files are deleted by the cleanup
-- only after the grace period, without leases and without any reference.
CREATE TABLE sheet_files (
    file_id UUID PRIMARY KEY,
    organization_id TEXT NOT NULL,
    sheet_id BIGINT,
    actor_key TEXT,
    operation_id UUID,
    attempt_id UUID,
    source TEXT NOT NULL CHECK (source IN ('google_cloud_storage','local')),
    object_name TEXT NOT NULL,
    byte_size BIGINT CHECK (byte_size IS NULL OR byte_size >= 0),
    sha256 TEXT,
    storage_generation BIGINT,
    legacy BOOLEAN NOT NULL DEFAULT FALSE,
    state TEXT NOT NULL CHECK (state IN ('staged','active','retired','delete_pending','deleted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    retired_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    last_error_code TEXT
);
-- Legacy rows may share an object; new files never do.
CREATE UNIQUE INDEX sheet_files_new_object ON sheet_files(source, object_name) WHERE NOT legacy;
CREATE INDEX sheet_files_cleanup ON sheet_files(state, next_attempt_at);
CREATE INDEX sheet_files_object ON sheet_files(organization_id, object_name);

INSERT INTO sheet_files (file_id, organization_id, sheet_id, source, object_name, byte_size, legacy, state)
SELECT s.file_id, s.organization_id, s.id,
       CASE WHEN s.source = 'google_cloud_storage' THEN 'google_cloud_storage' ELSE 'local' END,
       CASE WHEN s.source = 'google_cloud_storage' THEN COALESCE(s.object_name, '') ELSE COALESCE(s.path, '') END,
       s.size_bytes, TRUE, 'active'
FROM sheet_library s
WHERE (s.source = 'google_cloud_storage' AND COALESCE(s.object_name, '') <> '')
   OR (s.source <> 'google_cloud_storage' AND COALESCE(s.path, '') <> '')
ON CONFLICT (file_id) DO NOTHING;

-- Protection of files in use (ZIP building). A lease has an expiry and is
-- renewed by the live holder; the cleanup never deletes a file with a lease
-- that has not expired.
CREATE TABLE sheet_file_leases (
    lease_id UUID PRIMARY KEY,
    organization_id TEXT NOT NULL,
    file_id UUID NOT NULL REFERENCES sheet_files(file_id),
    holder TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (file_id, holder)
);
CREATE INDEX sheet_file_leases_live ON sheet_file_leases(file_id, expires_at);

-- ZIP jobs: the content is fixed at creation (file IDs, generations, names,
-- sizes). Building runs in bounded steps that may end inside a file; each
-- committed step is recorded, so a step that died is simply repeated. Only
-- the attempt holding the claim (attempt_id, lease_until) may commit. A ready
-- ZIP is kept until expires_at.
CREATE TABLE sheet_zip_jobs (
    job_id UUID PRIMARY KEY,
    organization_id TEXT NOT NULL,
    actor_key TEXT NOT NULL,
    performance_id TEXT NOT NULL,
    piece TEXT NOT NULL DEFAULT '',
    part TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    list_version BIGINT NOT NULL,
    allow_partial BOOLEAN NOT NULL DEFAULT FALSE,
    manifest JSONB NOT NULL,
    missing JSONB NOT NULL DEFAULT '[]'::jsonb,
    file_count INTEGER NOT NULL CHECK (file_count >= 0),
    total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0),
    done_count INTEGER NOT NULL DEFAULT 0 CHECK (done_count >= 0),
    written_bytes BIGINT NOT NULL DEFAULT 0 CHECK (written_bytes >= 0),
    parts JSONB NOT NULL DEFAULT '[]'::jsonb,
    entries JSONB NOT NULL DEFAULT '[]'::jsonb,
    state TEXT NOT NULL CHECK (state IN ('building','ready','incomplete','failed','cancelled','expired')),
    attempt_id UUID,
    lease_until TIMESTAMPTZ,
    object_name TEXT,
    zip_bytes BIGINT,
    zip_sha256 TEXT,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    ready_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    cleaned_at TIMESTAMPTZ
);
CREATE INDEX sheet_zip_jobs_cleanup ON sheet_zip_jobs(state, expires_at);
CREATE INDEX sheet_zip_jobs_actor ON sheet_zip_jobs(organization_id, actor_key, created_at DESC);

-- Short-lived download tickets for the save paths that cannot send the
-- device header (navigation fallback). Only the SHA-256 of the ticket is
-- stored; each use re-checks the device and the organization.
CREATE TABLE sheet_download_tickets (
    ticket_hash TEXT PRIMARY KEY CHECK (length(ticket_hash) = 64),
    organization_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('file','zip')),
    target_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sheet_download_tickets_expiry ON sheet_download_tickets(expires_at);
