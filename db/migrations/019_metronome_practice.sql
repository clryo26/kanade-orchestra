-- Metronome practice history (summaries only; docs/METRONOME_DATA_API_DESIGN.md 7).
-- Individual observations (onset times, per-beat errors), calibration values,
-- audio and PCM are never stored here: event_count is fixed to 0 and a
-- session keeps at most 256 summary groups in one upload part.
-- The owner is the existing tuner_owners row (shared personal identity with
-- member_birth / revocation). The metronome keeps its own history epoch, so
-- deleting metronome history never deletes tuner history and vice versa.
-- Owner revocation (member deleted / id reused) removes all metronome data
-- through the trigger below; the owner row itself stays (017 behaviour).
-- Additive only: no existing table, function or trigger of 017 is changed.
-- Applied by scripts/migrate_db.py through the normal release procedure
-- (never at application start-up). Not part of the production -> test sync.

CREATE TABLE IF NOT EXISTS metronome_preferences (
    owner_id UUID PRIMARY KEY REFERENCES tuner_owners (id) ON DELETE CASCADE,
    history_epoch BIGINT NOT NULL DEFAULT 1 CHECK (history_epoch > 0),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    consent_revision BIGINT NOT NULL DEFAULT 1 CHECK (consent_revision > 0),
    account_consent BOOLEAN NOT NULL DEFAULT FALSE,
    consent_version TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metronome_sessions (
    owner_id UUID NOT NULL REFERENCES tuner_owners (id) ON DELETE CASCADE,
    session_uuid UUID NOT NULL,
    history_epoch BIGINT NOT NULL CHECK (history_epoch > 0),
    attempt_uuid UUID NOT NULL,
    program_uuid UUID NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('uploading', 'complete', 'incomplete')),
    started_at TIMESTAMPTZ NOT NULL,
    duration_ms BIGINT NOT NULL CHECK (duration_ms BETWEEN 0 AND 1800000),
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count = 0), -- raw observations are local only
    target_count INTEGER NOT NULL CHECK (target_count BETWEEN 0 AND 28800),
    valid_count INTEGER NOT NULL CHECK (valid_count BETWEEN 0 AND target_count),
    local_detail_count INTEGER NOT NULL CHECK (local_detail_count BETWEEN 0 AND 36000),
    extra_detail_count INTEGER NOT NULL CHECK (extra_detail_count BETWEEN 0 AND 7200),
    extra_total BIGINT NOT NULL CHECK (extra_total >= extra_detail_count),
    group_count INTEGER NOT NULL CHECK (group_count BETWEEN 0 AND 256),
    condition_key TEXT NOT NULL,
    versions JSONB NOT NULL CHECK (jsonb_typeof(versions) = 'object'),
    score_summary JSONB NOT NULL CHECK (jsonb_typeof(score_summary) = 'object'),
    summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
    content_hash TEXT NOT NULL,
    finalized_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, session_uuid)
);

CREATE INDEX IF NOT EXISTS idx_metronome_sessions_started
    ON metronome_sessions (owner_id, started_at DESC, session_uuid);

CREATE INDEX IF NOT EXISTS idx_metronome_sessions_condition
    ON metronome_sessions (owner_id, condition_key, started_at DESC, session_uuid);

CREATE TABLE IF NOT EXISTS metronome_summary_groups (
    owner_id UUID NOT NULL,
    session_uuid UUID NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
    condition_key TEXT NOT NULL,
    layer_key TEXT NOT NULL,
    beat_position_key TEXT NOT NULL,
    target_count INTEGER NOT NULL CHECK (target_count BETWEEN 0 AND 28800),
    valid_count INTEGER NOT NULL CHECK (valid_count BETWEEN 0 AND target_count),
    extra_total BIGINT NOT NULL CHECK (extra_total >= 0),
    stats JSONB NOT NULL CHECK (jsonb_typeof(stats) = 'object'),
    quality JSONB NOT NULL CHECK (jsonb_typeof(quality) = 'object'),
    PRIMARY KEY (owner_id, session_uuid, ordinal),
    UNIQUE (owner_id, session_uuid, condition_key, layer_key, beat_position_key),
    FOREIGN KEY (owner_id, session_uuid) REFERENCES metronome_sessions (owner_id, session_uuid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_metronome_groups_condition
    ON metronome_summary_groups (owner_id, condition_key, session_uuid);

CREATE TABLE IF NOT EXISTS metronome_upload_parts (
    owner_id UUID NOT NULL,
    session_uuid UUID NOT NULL,
    part_index INTEGER NOT NULL CHECK (part_index = 0),
    payload_hash TEXT NOT NULL,
    groups JSONB NOT NULL CHECK (jsonb_typeof(groups) = 'array' AND jsonb_array_length(groups) <= 256),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (owner_id, session_uuid, part_index),
    FOREIGN KEY (owner_id, session_uuid) REFERENCES metronome_sessions (owner_id, session_uuid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_metronome_parts_expiry
    ON metronome_upload_parts (expires_at);

CREATE TABLE IF NOT EXISTS metronome_presets (
    owner_id UUID NOT NULL REFERENCES tuner_owners (id) ON DELETE CASCADE,
    preset_uuid UUID NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    kind TEXT NOT NULL CHECK (kind IN ('basic', 'advanced', 'score')),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, preset_uuid, revision)
);

CREATE TABLE IF NOT EXISTS metronome_tombstones (
    owner_id UUID NOT NULL REFERENCES tuner_owners (id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('session', 'preset')),
    entity_uuid UUID NOT NULL,
    history_epoch BIGINT NOT NULL CHECK (history_epoch > 0),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, entity_type, entity_uuid)
);

CREATE TABLE IF NOT EXISTS metronome_operations (
    owner_id UUID NOT NULL REFERENCES tuner_owners (id) ON DELETE CASCADE,
    operation_uuid UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('delete-history', 'delete-session', 'delete-preset')),
    request_hash TEXT NOT NULL,
    response JSONB NOT NULL CHECK (jsonb_typeof(response) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, operation_uuid)
);

-- Owner revoked (member deleted / numeric id reused): every metronome row
-- of that owner is removed in the same transaction as the revocation.
CREATE OR REPLACE FUNCTION metronome_revoke_owner_data() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
        DELETE FROM metronome_sessions WHERE owner_id = NEW.id;
        DELETE FROM metronome_presets WHERE owner_id = NEW.id;
        DELETE FROM metronome_preferences WHERE owner_id = NEW.id;
        DELETE FROM metronome_tombstones WHERE owner_id = NEW.id;
        DELETE FROM metronome_operations WHERE owner_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_metronome_owner_revoked ON tuner_owners;
CREATE TRIGGER trg_metronome_owner_revoked
    AFTER UPDATE OF revoked_at ON tuner_owners
    FOR EACH ROW EXECUTE FUNCTION metronome_revoke_owner_data();
