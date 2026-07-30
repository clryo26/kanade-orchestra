ALTER TABLE events
    ADD COLUMN IF NOT EXISTS created_by_member_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_events_created_by_member_id ON events(created_by_member_id);
