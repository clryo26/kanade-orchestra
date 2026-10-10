-- Presentation only: no changes to role permissions or existing feature tables.
CREATE TABLE IF NOT EXISTS menu_visibility_settings (
    organization_id TEXT NOT NULL DEFAULT 'default',
    menu_key TEXT NOT NULL,
    visible BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, menu_key),
    CONSTRAINT chk_menu_visibility_key CHECK (length(trim(menu_key)) > 0)
);
