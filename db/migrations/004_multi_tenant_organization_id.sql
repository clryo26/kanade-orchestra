DO $$
DECLARE
    target_table TEXT;
BEGIN
    FOREACH target_table IN ARRAY ARRAY[
        'members',
        'auth_devices',
        'performances',
        'performance_pieces',
        'schedules',
        'announcements',
        'events',
        'absences',
        'event_responses',
        'payments',
        'payment_performance_fees',
        'castings',
        'casting_members',
        'casting_extras',
        'performance_day_infos',
        'piece_infos',
        'practice_instructions',
        'desired_pieces',
        'desired_piece_votes',
        'promotions',
        'albums',
        'album_photos',
        'sheet_library',
        'drive_files',
        'recording_metadata',
        'date_adjustments',
        'date_adjustment_candidates',
        'date_adjustment_responses',
        'part_settings',
        'venue_settings',
        'org_settings',
        'sns_settings',
        'connection_settings',
        'access_logs'
    ]
    LOOP
        IF EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = target_table
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I ADD COLUMN IF NOT EXISTS organization_id TEXT NOT NULL DEFAULT ''default''',
                target_table
            );

            EXECUTE format(
                'CREATE INDEX IF NOT EXISTS %I ON %I (organization_id)',
                'idx_' || target_table || '_org_id',
                target_table
            );

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = target_table
                  AND column_name = 'id'
            ) THEN
                EXECUTE format(
                    'CREATE INDEX IF NOT EXISTS %I ON %I (organization_id, id)',
                    'idx_' || target_table || '_org_id_id',
                    target_table
                );
            ELSIF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = target_table
                  AND column_name = 'payment_id'
            ) AND EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = target_table
                  AND column_name = 'performance_id'
            ) THEN
                EXECUTE format(
                    'CREATE INDEX IF NOT EXISTS %I ON %I (organization_id, payment_id, performance_id)',
                    'idx_' || target_table || '_org_payment_performance',
                    target_table
                );
            END IF;
        END IF;
    END LOOP;
END $$;
