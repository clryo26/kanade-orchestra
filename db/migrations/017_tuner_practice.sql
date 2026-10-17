-- Tuner practice history (summaries only; no audio, no pitch series).
-- Owners are separate from the numeric member id: a member id can be reused
-- after a member is deleted, so every owner also records the member's
-- immutable creation time (member_birth) and is revoked when that member row
-- is deleted or a new row with the same id is inserted.
-- Applied by scripts/migrate_db.py through the normal release procedure
-- (never at application start-up).

CREATE TABLE IF NOT EXISTS tuner_owners (
    id UUID PRIMARY KEY,
    organization_id TEXT NOT NULL DEFAULT 'default',
    member_id BIGINT NOT NULL,
    member_birth TIMESTAMPTZ NOT NULL,
    history_epoch INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ NULL,
    revoked_reason TEXT NOT NULL DEFAULT '',
    CONSTRAINT chk_tuner_owners_epoch CHECK (history_epoch >= 1)
);

-- One active owner per organisation and member id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tuner_owners_active_member
    ON tuner_owners (organization_id, member_id)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tuner_owners_org_id
    ON tuner_owners (organization_id);

CREATE TABLE IF NOT EXISTS tuner_preferences (
    owner_id UUID PRIMARY KEY REFERENCES tuner_owners (id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    consent_version TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_tuner_preferences_revision CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS tuner_instruments (
    owner_id UUID NOT NULL REFERENCES tuner_owners (id) ON DELETE CASCADE,
    instrument_uuid UUID NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL,
    PRIMARY KEY (owner_id, instrument_uuid),
    CONSTRAINT chk_tuner_instruments_revision CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS tuner_presets (
    owner_id UUID NOT NULL REFERENCES tuner_owners (id) ON DELETE CASCADE,
    preset_uuid UUID NOT NULL,
    revision INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL,
    PRIMARY KEY (owner_id, preset_uuid, revision),
    CONSTRAINT chk_tuner_presets_kind CHECK (kind IN ('temperament', 'sound', 'exercise', 'analysis')),
    CONSTRAINT chk_tuner_presets_revision CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS tuner_sessions (
    owner_id UUID NOT NULL REFERENCES tuner_owners (id) ON DELETE CASCADE,
    session_uuid UUID NOT NULL,
    history_epoch INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'uploading',
    condition_key TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    instrument_uuid UUID NULL,
    started_at TIMESTAMPTZ NOT NULL,
    duration_ms BIGINT NOT NULL DEFAULT 0,
    versions JSONB NOT NULL DEFAULT '{}'::jsonb,
    conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    instrument_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    target_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    event_count INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    client_operation_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finalized_at TIMESTAMPTZ NULL,
    PRIMARY KEY (owner_id, session_uuid),
    CONSTRAINT chk_tuner_sessions_status CHECK (status IN ('uploading', 'complete')),
    CONSTRAINT chk_tuner_sessions_counts CHECK (event_count >= 0 AND event_count <= 10000 AND duration_ms >= 0 AND duration_ms <= 7200000)
);

CREATE INDEX IF NOT EXISTS idx_tuner_sessions_owner_started
    ON tuner_sessions (owner_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tuner_sessions_owner_condition_started
    ON tuner_sessions (owner_id, condition_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tuner_sessions_owner_instrument_started
    ON tuner_sessions (owner_id, instrument_uuid, started_at DESC);

CREATE TABLE IF NOT EXISTS tuner_upload_parts (
    owner_id UUID NOT NULL,
    session_uuid UUID NOT NULL,
    part_index INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    events JSONB NOT NULL DEFAULT '[]'::jsonb,
    event_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (owner_id, session_uuid, part_index),
    FOREIGN KEY (owner_id, session_uuid) REFERENCES tuner_sessions (owner_id, session_uuid) ON DELETE CASCADE,
    CONSTRAINT chk_tuner_upload_parts_index CHECK (part_index >= 0 AND part_index < 100),
    CONSTRAINT chk_tuner_upload_parts_count CHECK (event_count >= 0 AND event_count <= 500)
);

CREATE TABLE IF NOT EXISTS tuner_note_events (
    owner_id UUID NOT NULL,
    session_uuid UUID NOT NULL,
    event_uuid UUID NOT NULL,
    ordinal INTEGER NOT NULL,
    start_ms BIGINT NOT NULL,
    end_ms BIGINT NOT NULL,
    target JSONB NOT NULL DEFAULT '{}'::jsonb,
    stats JSONB NOT NULL DEFAULT '{}'::jsonb,
    quality JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (owner_id, session_uuid, event_uuid),
    FOREIGN KEY (owner_id, session_uuid) REFERENCES tuner_sessions (owner_id, session_uuid) ON DELETE CASCADE,
    CONSTRAINT chk_tuner_note_events_times CHECK (start_ms >= 0 AND end_ms >= start_ms)
);

CREATE INDEX IF NOT EXISTS idx_tuner_note_events_session_ordinal
    ON tuner_note_events (owner_id, session_uuid, ordinal);

-- Identifiers of deleted entities (no content): a delayed upload of the same
-- id is refused instead of bringing the history back.
CREATE TABLE IF NOT EXISTS tuner_tombstones (
    owner_id UUID NOT NULL REFERENCES tuner_owners (id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_uuid UUID NOT NULL,
    history_epoch INTEGER NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, entity_type, entity_uuid),
    CONSTRAINT chk_tuner_tombstones_type CHECK (entity_type IN ('session', 'instrument', 'preset'))
);

-- Revokes the active owner of a member id and deletes its practice data
-- (tombstones stay with the revoked owner; nothing can be resolved to it).
CREATE OR REPLACE FUNCTION tuner_revoke_member_owner(p_organization_id TEXT, p_member_id BIGINT, p_reason TEXT)
RETURNS VOID AS $$
DECLARE
    revoked UUID;
BEGIN
    FOR revoked IN
        UPDATE tuner_owners
           SET revoked_at = NOW(), revoked_reason = p_reason
         WHERE organization_id = p_organization_id
           AND member_id = p_member_id
           AND revoked_at IS NULL
        RETURNING id
    LOOP
        DELETE FROM tuner_sessions WHERE owner_id = revoked;
        DELETE FROM tuner_instruments WHERE owner_id = revoked;
        DELETE FROM tuner_presets WHERE owner_id = revoked;
        DELETE FROM tuner_preferences WHERE owner_id = revoked;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION tuner_members_owner_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM tuner_revoke_member_owner(COALESCE(OLD.organization_id, 'default'), OLD.id, 'member-deleted');
        RETURN OLD;
    END IF;
    -- A real INSERT (not an upsert of an existing row) with a member id that
    -- still has an active owner means the id is being reused.
    PERFORM tuner_revoke_member_owner(COALESCE(NEW.organization_id, 'default'), NEW.id, 'member-id-reused');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'members'
    ) THEN
        DROP TRIGGER IF EXISTS trg_tuner_members_owner_guard_delete ON members;
        CREATE TRIGGER trg_tuner_members_owner_guard_delete
            AFTER DELETE ON members
            FOR EACH ROW EXECUTE FUNCTION tuner_members_owner_guard();
        DROP TRIGGER IF EXISTS trg_tuner_members_owner_guard_insert ON members;
        CREATE TRIGGER trg_tuner_members_owner_guard_insert
            AFTER INSERT ON members
            FOR EACH ROW EXECUTE FUNCTION tuner_members_owner_guard();
    END IF;
END;
$$;
