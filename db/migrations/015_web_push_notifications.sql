-- Additive migration. Apply explicitly with scripts/migrate_db.py, never at startup.
CREATE TABLE IF NOT EXISTS notification_preferences (
    organization_id TEXT NOT NULL,
    member_id BIGINT NOT NULL,
    preferences JSONB NOT NULL DEFAULT '{"notices":true,"schedules":true,"recordings":true,"piece_infos":true,"sheets":true,"events":true,"maintenance":true,"improvements":true}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, member_id)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    member_id BIGINT NOT NULL,
    device_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_owner ON push_subscriptions (organization_id, member_id, device_id);
CREATE TABLE IF NOT EXISTS notification_events (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_notification_events_pending ON notification_events (organization_id, created_at) WHERE NOT completed;
CREATE TABLE IF NOT EXISTS notification_deliveries (
    event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('sending','sent','retry','failed','unknown','invalid')),
    attempts INTEGER NOT NULL DEFAULT 1,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    http_status INTEGER,
    PRIMARY KEY (event_id, subscription_id)
);
