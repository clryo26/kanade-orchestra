// DOMContentLoaded bootstrap split from common_helpers.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await window.portalRuntimeContext.dbCache.init();
    } catch (error) {
        console.warn('IndexedDB initialization failed:', error);
    }
    try {
        setDefaultDates();
        setupPortalHome();
        setupMemberManagerTabs();
        bindNavigation();
        bindUpload();
        bindForms();
        bindDownloadConfirmations();
        updateSavePath();
        loadCloudRunRevision();
    } catch (initError) {
        console.error('Portal initialization error:', initError);
    }
    try {
        if (await isPortalAuthenticated()) {
            await enterPortal();
        } else {
            showPortalLogin();
            loadPartSettingsForLogin();
        }
    } catch (authError) {
        console.error('Portal auth/login error:', authError);
        try { showPortalLogin(); } catch {}
    }
});