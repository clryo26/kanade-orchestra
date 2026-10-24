-- PERF-R15: inert ledger foundation only. Apply transactionally as a separate
-- DDL owner after backup; no app grants, photo bindings, guard/GC triggers or GCS I/O.
-- Do not seed an environment/bucket from another environment's backup.
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.album_asset_gc_control (
    singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
    environment_uuid uuid NOT NULL,
    bucket text NOT NULL CHECK (length(btrim(bucket)) > 0),
    guard_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (environment_uuid, bucket),
    -- A later reviewed migration may remove this only with the actual guards.
    CONSTRAINT album_gc_foundation_guard_disabled CHECK (NOT guard_enabled)
);

CREATE TABLE public.album_storage_assets (
    asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    environment_uuid uuid NOT NULL,
    bucket text NOT NULL,
    object_name text NOT NULL CHECK (length(btrim(object_name)) > 0),
    generation numeric(20, 0) NOT NULL CHECK (generation > 0),
    kind text NOT NULL CHECK (kind IN ('original', 'thumbnail')),
    parent_asset_id uuid,
    -- A composite FK enforces an original parent in the same environment/bucket
    -- without a mutable app-supplied parent kind or an additional trigger.
    parent_kind text GENERATED ALWAYS AS
        (CASE WHEN parent_asset_id IS NOT NULL THEN 'original'::text END) STORED,
    state text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'deleting', 'deleted', 'held')),
    claim_token uuid,
    claim_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (environment_uuid, bucket, object_name, generation),
    UNIQUE (asset_id, environment_uuid, bucket, kind),
    FOREIGN KEY (environment_uuid, bucket)
        REFERENCES public.album_asset_gc_control(environment_uuid, bucket),
    FOREIGN KEY (parent_asset_id, environment_uuid, bucket, parent_kind)
        REFERENCES public.album_storage_assets(asset_id, environment_uuid, bucket, kind),
    CHECK ((kind = 'original' AND parent_asset_id IS NULL)
        OR (kind = 'thumbnail' AND parent_asset_id IS NOT NULL)),
    CHECK (parent_asset_id IS NULL OR parent_asset_id <> asset_id),
    CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
    CHECK (state <> 'deleting' OR claim_token IS NOT NULL)
);
CREATE INDEX album_storage_assets_parent ON public.album_storage_assets(parent_asset_id)
    WHERE parent_asset_id IS NOT NULL;

CREATE TABLE public.album_asset_gc_candidates (
    candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid NOT NULL REFERENCES public.album_storage_assets(asset_id),
    logical_removed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    -- Set only when a later worker first observes a committed candidate. Never
    -- derive the seven-day grace from a timestamp recorded before COMMIT.
    first_observed_at timestamptz,
    not_before timestamptz,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'cancelled', 'done', 'held')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz,
    reason_code text CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK ((first_observed_at IS NULL) = (not_before IS NULL)),
    CHECK (first_observed_at IS NULL OR first_observed_at >= logical_removed_at),
    -- Hours, not calendar days: retain a full 168 hours even across DST.
    CHECK (not_before IS NULL OR not_before >= first_observed_at + interval '168 hours')
);
CREATE UNIQUE INDEX album_asset_gc_one_open_candidate
    ON public.album_asset_gc_candidates(asset_id) WHERE status IN ('pending', 'held');
CREATE INDEX album_asset_gc_due ON public.album_asset_gc_candidates(not_before, next_attempt_at)
    WHERE status = 'pending' AND not_before IS NOT NULL;

CREATE TABLE public.album_asset_read_leases (
    lease_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid NOT NULL REFERENCES public.album_storage_assets(asset_id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    renewed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT statement_timestamp() + interval '300 seconds',
    CHECK (renewed_at >= created_at),
    CHECK (expires_at > renewed_at AND expires_at <= renewed_at + interval '300 seconds')
);
CREATE INDEX album_asset_read_leases_active
    ON public.album_asset_read_leases(asset_id, expires_at);

-- Do not guess deployment role names or grant permissions to the app. The DDL
-- owner must be distinct from it; owners/superusers cannot be restricted by ACL.
REVOKE ALL ON public.album_asset_gc_control, public.album_storage_assets,
    public.album_asset_gc_candidates, public.album_asset_read_leases FROM PUBLIC;

-- ALTER DEFAULT PRIVILEGES may grant directly to an app role. PUBLIC's revoke
-- is not enough in that case. Refuse rather than guessing deployment roles or
-- silently rewriting their privileges. Owner membership still needs preflight.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
        CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
        WHERE c.oid IN ('public.album_asset_gc_control'::regclass,
            'public.album_storage_assets'::regclass,
            'public.album_asset_gc_candidates'::regclass,
            'public.album_asset_read_leases'::regclass)
          AND a.grantee <> c.relowner
    ) THEN
        RAISE EXCEPTION 'Album ledger requires owner-only ACLs; review default privileges';
    END IF;
END $$;
