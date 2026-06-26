-- JSON->PostgreSQL migration count check
-- Usage:
--   psql -d <db> -f db/post_migration_count_check.sql
-- Compare this result with the migration script output:
--   "Migration row counts" and "Reconciliation (JSON rows vs DB table rows)"

SELECT 'performances' AS table_name, COUNT(*) AS row_count FROM performances
UNION ALL SELECT 'performance_pieces', COUNT(*) FROM performance_pieces
UNION ALL SELECT 'schedules', COUNT(*) FROM schedules
UNION ALL SELECT 'announcements', COUNT(*) FROM announcements
UNION ALL SELECT 'events', COUNT(*) FROM events
UNION ALL SELECT 'members', COUNT(*) FROM members
UNION ALL SELECT 'auth_devices', COUNT(*) FROM auth_devices
UNION ALL SELECT 'absences', COUNT(*) FROM absences
UNION ALL SELECT 'event_responses', COUNT(*) FROM event_responses
UNION ALL SELECT 'date_adjustments', COUNT(*) FROM date_adjustments
UNION ALL SELECT 'date_adjustment_candidates', COUNT(*) FROM date_adjustment_candidates
UNION ALL SELECT 'date_adjustment_responses', COUNT(*) FROM date_adjustment_responses
UNION ALL SELECT 'piece_infos', COUNT(*) FROM piece_infos
UNION ALL SELECT 'practice_instructions', COUNT(*) FROM practice_instructions
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'payment_performance_fees', COUNT(*) FROM payment_performance_fees
UNION ALL SELECT 'castings', COUNT(*) FROM castings
UNION ALL SELECT 'casting_members', COUNT(*) FROM casting_members
UNION ALL SELECT 'casting_extras', COUNT(*) FROM casting_extras
UNION ALL SELECT 'desired_pieces', COUNT(*) FROM desired_pieces
UNION ALL SELECT 'desired_piece_votes', COUNT(*) FROM desired_piece_votes
UNION ALL SELECT 'promotions', COUNT(*) FROM promotions
UNION ALL SELECT 'albums', COUNT(*) FROM albums
UNION ALL SELECT 'album_photos', COUNT(*) FROM album_photos
UNION ALL SELECT 'part_settings', COUNT(*) FROM part_settings
UNION ALL SELECT 'venue_settings', COUNT(*) FROM venue_settings
UNION ALL SELECT 'org_settings', COUNT(*) FROM org_settings
UNION ALL SELECT 'sns_settings', COUNT(*) FROM sns_settings
UNION ALL SELECT 'connection_settings', COUNT(*) FROM connection_settings
UNION ALL SELECT 'drive_files', COUNT(*) FROM drive_files
UNION ALL SELECT 'recording_metadata', COUNT(*) FROM recording_metadata
UNION ALL SELECT 'sheet_library', COUNT(*) FROM sheet_library
ORDER BY table_name;
