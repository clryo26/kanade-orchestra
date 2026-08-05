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
// Loaded on demand when the system-database tab is first opened.
var adminDatabaseViewerLoadPromise = null;
function ensureAdminDatabaseViewerLoaded() {
    if (typeof renderDatabaseView === 'function') {
        return Promise.resolve();
    }
    if (adminDatabaseViewerLoadPromise) {
        return adminDatabaseViewerLoadPromise;
    }
    adminDatabaseViewerLoadPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/static/js/modules/admin_system/database_viewer.js?v=20260701-2';
        script.async = true;
        script.addEventListener('load', function () {
            if (typeof renderDatabaseView === 'function') {
                resolve();
            } else {
                adminDatabaseViewerLoadPromise = null;
                reject(new Error('Admin database viewer loaded but renderDatabaseView is not defined'));
            }
        }, { once: true });
        script.addEventListener('error', function () {
            adminDatabaseViewerLoadPromise = null;
            reject(new Error('Admin database viewer script failed to load'));
        }, { once: true });
        document.head.appendChild(script);
    });
    return adminDatabaseViewerLoadPromise;
}

// ===== 環境管理 =====
// Environment management moved to modules/admin_system/environment_management.js.
// Loaded on demand when the system panel is opened by a system admin.
var adminEnvironmentManagementLoadPromise = null;
function ensureAdminEnvironmentManagementLoaded() {
    if (typeof refreshSystemEnvironmentMenuVisibility === 'function' &&
            typeof renderSystemEnvironmentManagement === 'function') {
        return Promise.resolve();
    }
    if (adminEnvironmentManagementLoadPromise) {
        return adminEnvironmentManagementLoadPromise;
    }
    adminEnvironmentManagementLoadPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/static/js/modules/admin_system/environment_management.js?v=20260707-1';
        script.async = true;
        script.addEventListener('load', function () {
            if (typeof refreshSystemEnvironmentMenuVisibility === 'function' &&
                    typeof renderSystemEnvironmentManagement === 'function') {
                resolve();
            } else {
                adminEnvironmentManagementLoadPromise = null;
                reject(new Error('Admin environment management loaded but required functions are not defined'));
            }
        }, { once: true });
        script.addEventListener('error', function () {
            adminEnvironmentManagementLoadPromise = null;
            reject(new Error('Admin environment management script failed to load'));
        }, { once: true });
        document.head.appendChild(script);
    });
    return adminEnvironmentManagementLoadPromise;
}

// ===== 管理API =====
// Admin settings API moved to modules/admin_system/api.js.
// Loaded on demand when the admin or system panel is opened.
var adminSystemApiLoadPromise = null;

function _adminSystemApiReady() {
    return typeof deleteAuthDevice === 'function' &&
        typeof movePartSetting === 'function' &&
        typeof savePartSetting === 'function' &&
        typeof deletePartSetting === 'function' &&
        typeof saveVenueSetting === 'function' &&
        typeof deleteVenueSetting === 'function' &&
        typeof saveFlyerDistributionSetting === 'function' &&
        typeof deleteFlyerDistributionSetting === 'function' &&
        typeof deleteSelectedFlyerDistributionSetting === 'function' &&
        typeof saveOrgSetting === 'function' &&
        typeof saveConnectionSetting === 'function';
}

function ensureAdminSystemApiLoaded() {
    if (_adminSystemApiReady()) {
        return Promise.resolve();
    }
    if (adminSystemApiLoadPromise) {
        return adminSystemApiLoadPromise;
    }
    adminSystemApiLoadPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/static/js/modules/admin_system/api.js?v=20260701-2';
        script.async = true;
        script.addEventListener('load', function () {
            if (_adminSystemApiReady()) {
                resolve();
            } else {
                adminSystemApiLoadPromise = null;
                reject(new Error('Admin system API loaded but required functions are not defined'));
            }
        }, { once: true });
        script.addEventListener('error', function () {
            adminSystemApiLoadPromise = null;
            reject(new Error('Admin system API script failed to load'));
        }, { once: true });
        document.head.appendChild(script);
    });
    return adminSystemApiLoadPromise;
}

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
