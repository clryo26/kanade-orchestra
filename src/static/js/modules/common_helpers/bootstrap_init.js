// DOMContentLoaded bootstrap split from common_helpers.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

var PORTAL_RESUME_SYNC_MAX_AGE_MS = 60 * 1000;
var portalResumeSyncInFlight = false;
var portalWasOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

if (window.__KANADE_BOOTSTRAP_INIT_BOUND__) {
    // Avoid duplicate listeners when legacy compatibility loaders re-inject scripts.
    // This prevents repeated initialization loops after PWA resume/update.
} else {
    window.__KANADE_BOOTSTRAP_INIT_BOUND__ = true;

// 認証確認から起動処理を実行する。再試行時も同じ関数を呼ぶ。
async function _runAuthAndStart() {
    try {
        const authResult = await isPortalAuthenticated();
        if (authResult.status === 'authenticated') {
            if (window.portalStartup) window.portalStartup.setMessage('データを読み込んでいます..');
            await enterPortal();
            // enterPortal成功時にportalStartup.ready()が呼ばれる
        } else if (authResult.status === 'unauthenticated') {
            showPortalLogin();
            loadPartSettingsForLogin();
            if (window.portalStartup) window.portalStartup.ready();
        } else {
            // unavailable: 通信不可のためログイン画面へ移行
            console.warn('[bootstrap_init] auth unavailable:', authResult.error);
            if (window.portalStartup) {
                window.portalStartup.showRetry({
                    message: '通信に時間がかかっています。もう一度試行してください。',
                    retry: _runAuthAndStart,
                });
            }
        }
    } catch (e) {
        console.error('[bootstrap_init] startup error:', e);
        if (window.portalStartup) {
            window.portalStartup.showRetry({
                message: (e && e.message) ? e.message : 'データの読み込みに失敗しました。もう一度試行してください。',
                retry: _runAuthAndStart,
            });
        } else {
            try {
                showPortalLogin();
            } catch (showLoginError) {
                console.warn('[bootstrap_init] failed to show login view after startup error:', showLoginError);
            }
        }
    }
}

// セッション復帰時の再認証・状態対応
async function syncPortalSessionOnResume() {
    if (portalResumeSyncInFlight) return;
    if (document.visibilityState === 'hidden') return;
    if (localStorage.getItem(window.portalRuntimeContext.PORTAL_AUTH_KEY) !== 'true') return;

    const now = Date.now();
    const authIsFresh =
        appState.portalAuthVerified === true &&
        appState.lastPortalSessionVerifiedAt > 0 &&
        now - appState.lastPortalSessionVerifiedAt < PORTAL_RESUME_SYNC_MAX_AGE_MS;
    const essentialDataIsFresh =
        appState.essentialDataLoaded === true &&
        appState.lastEssentialDataLoadedAt > 0 &&
        now - appState.lastEssentialDataLoadedAt < PORTAL_RESUME_SYNC_MAX_AGE_MS;

    if (authIsFresh && essentialDataIsFresh) return;

    portalResumeSyncInFlight = true;
    try {
        const authResult = authIsFresh
            ? { status: 'authenticated', device: null, error: null }
            : await isPortalAuthenticated({ forceVerify: true });

        if (authResult.status === 'authenticated') {
            if (appState.portalAuthVerified && !essentialDataIsFresh) {
                await loadEssentialData();
                appState.essentialDataLoaded = true;
            }
        } else if (authResult.status === 'unauthenticated') {
            showAlert('ログイン期限が切れました。もう一度ログインしてください。', 'warning');
            showPortalLogin();
        } else {
            showAlert('通信が不安定です。しばらくしてから再試行してください。', 'warning');
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

    // Phase 2計測: DOM解析完了
    if (window.portalStartup) window.portalStartup.mark('DOM_INTERACTIVE');

    if (window.portalStartup) window.portalStartup.setMessage('起動しています..');

    // Phase 2計測: IndexedDB初期化開始
    if (window.portalStartup) window.portalStartup.mark('IDB_START');
    try {
        await window.portalRuntimeContext.dbCache.init();
    } catch (error) {
        console.warn('IndexedDB initialization failed:', error);
    } finally {
        // Phase 2計測: IndexedDB初期化完了・失敗
        if (window.portalStartup) window.portalStartup.mark('IDB_END');
    }

    // Phase 2計測: UI初期化開始
    if (window.portalStartup) window.portalStartup.mark('UI_BIND_START');

    // UI初期設定に失敗した場合は再読み込み導線を表示して停止する
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
        if (window.portalStartup) {
            window.portalStartup.showReload('起動処理が正常に完了できませんでした。ページを再度読み込みしてください。');
        }
        return;
    } finally {
        // Phase 2計測: UI初期化完了
        if (window.portalStartup) window.portalStartup.mark('UI_BIND_END');
    }

    if (window.portalStartup) window.portalStartup.setMessage('認証を確認しています..');

    // Phase 2計測: 認証処理開始
    if (window.portalStartup) window.portalStartup.mark('AUTH_START');
    await _runAuthAndStart();
    // Phase 2計測: 認証処理完了(AUTH_END は isPortalAuthenticated内で記録)

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            syncPortalSessionOnResume();
        }
    });
    window.addEventListener('offline', () => {
        portalWasOffline = true;
    });
    window.addEventListener('online', () => {
        if (!portalWasOffline) return;
        portalWasOffline = false;
        syncPortalSessionOnResume();
    });
});
}