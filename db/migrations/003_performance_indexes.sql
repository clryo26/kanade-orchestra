DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='performances' AND column_name='date') THEN
        CREATE INDEX IF NOT EXISTS idx_performances_date ON performances(date);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='schedules' AND column_name='date') THEN
        CREATE INDEX IF NOT EXISTS idx_schedules_date ON schedules(date);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='schedules' AND column_name='performance_id') THEN
        CREATE INDEX IF NOT EXISTS idx_schedules_performance_id ON schedules(performance_id);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='members' AND column_name='part') THEN
        CREATE INDEX IF NOT EXISTS idx_members_part ON members(part);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='members' AND column_name='name') THEN
        CREATE INDEX IF NOT EXISTS idx_members_name ON members(name);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='absences' AND column_name='schedule_id') THEN
        CREATE INDEX IF NOT EXISTS idx_absences_schedule_id ON absences(schedule_id);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='absences' AND column_name='member_id') THEN
        CREATE INDEX IF NOT EXISTS idx_absences_member_id ON absences(member_id);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='event_responses' AND column_name='event_id') THEN
        CREATE INDEX IF NOT EXISTS idx_event_responses_event_id ON event_responses(event_id);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='member_id') THEN
        CREATE INDEX IF NOT EXISTS idx_payments_member_id ON payments(member_id);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='drive_files' AND column_name='practice_date') THEN
        CREATE INDEX IF NOT EXISTS idx_drive_files_practice_date ON drive_files(practice_date DESC);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='drive_files' AND column_name='piece') THEN
        CREATE INDEX IF NOT EXISTS idx_drive_files_piece ON drive_files(piece);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='recording_metadata' AND column_name='practice_date') THEN
        CREATE INDEX IF NOT EXISTS idx_recording_metadata_practice_date ON recording_metadata(practice_date DESC);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sheet_library' AND column_name='performance_id') THEN
        CREATE INDEX IF NOT EXISTS idx_sheet_library_performance_id ON sheet_library(performance_id);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='portal_json_collections' AND column_name='collection_name') THEN
        CREATE INDEX IF NOT EXISTS idx_portal_json_collections_name_updated ON portal_json_collections(collection_name, updated_at DESC);
    END IF;
END $$;
