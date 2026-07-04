// DOMContentLoaded bootstrap split from common_helpers.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

var portalResumeSyncInFlight = false;

if (window.__KANADE_BOOTSTRAP_INIT_BOUND__) {
    // Avoid duplicate listeners when legacy compatibility loaders re-inject scripts.
    // This prevents repeated initialization loops after PWA resume/update.
} else {
    window.__KANADE_BOOTSTRAP_INIT_BOUND__ = true;

async function syncPortalSessionOnResume() {
    if (portalResumeSyncInFlight) return;
    if (document.visibilityState === 'hidden') return;
    if (localStorage.getItem(window.portalRuntimeContext.PORTAL_AUTH_KEY) !== 'true') return;
    portalResumeSyncInFlight = true;
    try {
        const authenticated = await isPortalAuthenticated();
        if (!authenticated) {
            showAlert('ログイン期限が切れました。再ログインしてください。', 'warning');
            showPortalLogin();
            return;
        }
        if (appState.portalAuthVerified) {
            await loadEssentialData();
            appState.essentialDataLoaded = true;
        }
    } catch {
        showAlert('通信が切断されました。再接続しています... [再試行]', 'warning');
    } finally {
        portalResumeSyncInFlight = false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    if (window.__KANADE_BOOTSTRAP_INIT_DONE__) {
        return;
    }
    window.__KANADE_BOOTSTRAP_INIT_DONE__ = true;
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

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            syncPortalSessionOnResume();
        }
    });
    window.addEventListener('online', () => {
        syncPortalSessionOnResume();
    });
});
}