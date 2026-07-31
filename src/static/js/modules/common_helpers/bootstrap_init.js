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

// 認証確認から起動�E琁E��実行する。�E試行時も同じ関数を呼ぶ、E
async function _runAuthAndStart() {
    try {
        const authResult = await isPortalAuthenticated();
        if (authResult.status === 'authenticated') {
            if (window.portalStartup) window.portalStartup.setMessage('チE�Eタを読み込んでぁE��ぁE..');
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
            try { showPortalLogin(); } catch (_) {}
        }
    }
}

// セチE��ョン復帰時�E再認証�E�E状態対応！E
async function syncPortalSessionOnResume() {
    if (portalResumeSyncInFlight) return;
    if (document.visibilityState === 'hidden') return;
    if (localStorage.getItem(window.portalRuntimeContext.PORTAL_AUTH_KEY) !== 'true') return;
    portalResumeSyncInFlight = true;
    try {
        const authResult = await isPortalAuthenticated();
        if (authResult.status === 'authenticated') {
            if (appState.portalAuthVerified) {
                await loadEssentialData();
                appState.essentialDataLoaded = true;
            }
        } else if (authResult.status === 'unauthenticated') {
            showAlert('ログイン期限が切れました。もう一度ログインしてください。', 'warning');
            showPortalLogin();
        } else {
            // unavailable: 現在の画面を維持し、ローカル認証状態を削除しない
            showAlert('通信が不安定です。しばらくしてから再試行してください。', 'warning');
        }
    } catch {
        showAlert('通信が�E断されました。�E接続してぁE��ぁE.. [再試行]', 'warning');
    } finally {
        portalResumeSyncInFlight = false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    if (window.__KANADE_BOOTSTRAP_INIT_DONE__) {
        return;
    }
    window.__KANADE_BOOTSTRAP_INIT_DONE__ = true;

    // Phase 2計測: DOM解析完亁E
    if (window.portalStartup) window.portalStartup.mark('DOM_INTERACTIVE');

    if (window.portalStartup) window.portalStartup.setMessage('起動してぁE��ぁE..');

    // Phase 2計測: IndexedDB初期化開姁E
    if (window.portalStartup) window.portalStartup.mark('IDB_START');
    try {
        await window.portalRuntimeContext.dbCache.init();
    } catch (error) {
        console.warn('IndexedDB initialization failed:', error);
    } finally {
        // Phase 2計測: IndexedDB初期化完亁E�E失敁E
        if (window.portalStartup) window.portalStartup.mark('IDB_END');
    }

    // Phase 2計測: UI初期化開姁E
    if (window.portalStartup) window.portalStartup.mark('UI_BIND_START');

    // UI初期設定に失敗した場合�E再読み込み導線を表示して停止する
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
    window.addEventListener('online', () => {
        syncPortalSessionOnResume();
    });
});
}