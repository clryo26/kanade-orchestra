// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

// Auth-device / access-log / revision diagnostics moved to
// modules/admin_system/render.js and modules/admin_system/diagnostics.js.

// Part helper functions moved to modules/admin_system/helpers.js.

async function ensurePartSettingsMigrated() {
    if ((appState.partSettings || []).length) return;
    const names = partMigrationNames();
    if (!names.length) return;
    for (const [index, name] of names.entries()) {
        await saveExtra('part_settings', { name, display_order: index + 1 });
    }
    await loadExtraData(['partSettings']);
}

// Part settings render/API moved to
// modules/admin_system/render.js and modules/admin_system/api.js.

// ===== DB 閲覧 =====
// Database viewer moved to modules/admin_system/database_viewer.js.

// Venue render/API moved to modules/admin_system/render.js and modules/admin_system/api.js.

// Organization helper functions moved to modules/admin_system/helpers.js.

// Organization render helpers moved to modules/admin_system/render.js.

// Cloud Run revision helpers moved to modules/admin_system/diagnostics.js.

// Organization forms render/API moved to modules/admin_system/render.js and modules/admin_system/api.js.

// currentSnsSetting moved to feature module.

// renderSnsManagement moved to feature module.

// clearSnsSettingForm moved to feature module.

// saveSnsSetting moved to feature module.

// Connection helper function moved to modules/admin_system/helpers.js.

// Connection settings render/API moved to modules/admin_system/render.js and modules/admin_system/api.js.

// renderSnsView moved to feature module.
