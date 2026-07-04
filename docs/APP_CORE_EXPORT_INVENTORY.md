# app_core Export Inventory

- Total exports discovered: 80
- Files importing app_core in src/: 2
- Referenced from backend source tree: 5
- Not referenced from backend source tree: 75

## Files Importing app_core

- src/backend/core/compat_gateway.py
- src/backend/main.py

## Referenced Exports

- app: src/backend/core/compat_gateway.py
- load_json_data: src/backend/core/compat_gateway.py
- run_db_startup_self_check: src/backend/core/compat_gateway.py
- save_json_data: src/backend/core/compat_gateway.py
- seed_cloud_data_from_local: src/backend/core/compat_gateway.py

## Candidate Unreferenced Exports

- assert_db_ready
- assert_extra_collection_permission
- build_timetable_workbook_bytes
- check_etag
- cloud_recording_metadata
- cloud_run_revision
- collection_items
- convert_path_to_mp3
- data_file
- db_child_rows_for_collection
- db_collection_rows_for_save
- db_configured
- db_connection_string
- db_data_enabled
- db_delete_collection_children
- db_expected
- db_fetch_all
- db_fill_missing_ids
- db_insert_rows
- db_item_value
- db_json_value
- db_load_generic_json_collection
- db_load_json_data
- db_next_id
- db_replace_collection
- db_row_to_json
- db_row_tuple
- db_save_generic_json_collection
- db_upsert_rows
- db_write_value
- device_auth_record
- ensure_db_expected_is_ready
- ensure_db_schema_compatibility
- ensure_expected_updated_at
- env_flag_enabled
- find_item
- fk_int
- forget_drive_file
- get_audio_duration_seconds
- has_connection_setting
- legacy_connection_setting_from_env
- list_auth_devices
- load_local_json_data
- local_json_fallback_enabled
- local_recording_metadata
- local_recording_path
- logger
- mask_db_value
- model_dump
- next_id
- next_updated_at
- normalize_extra_payload
- normalized_timeline_rows
- parse_db_date
- parse_db_month
- parse_db_time
- parse_db_timestamp
- parse_extra_upsert_request
- performance_day_info_for_performance
- prepare_member_payload
- public_member_list
- public_member_payload
- read_json_body
- recording_file_bytes
- recording_metadata_map
- recording_payload
- remember_drive_file
- remember_recording_duration
- require_admin_device
- require_device
- require_recording_manager_device
- require_sheet_manager_device
- require_system_admin_device
- seed_connection_settings_from_legacy_env
- sheet_payload

## Notes

- This report only scans references inside src/.
- Reference detection uses static import/attribute patterns and may miss dynamic getattr-style access.
- Symbols listed as unreferenced may still be required by external scripts or runtime monkeypatch usage.
- Use this list as a review queue, not as direct delete instructions.