// Navigation route/tab transitions split from modules/navigation.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

// ===== 本番情報イベント =====
// Performance day events moved to modules/performance_day/events.js.
// Loaded on demand when the admin panel is opened.
var performanceDayEventsLoadPromise = null;

function _performanceDayEventsReady() {
    return typeof selectPerformanceDayInfo === 'function' &&
        typeof clearPerformanceDayInfoForm === 'function' &&
        typeof savePerformanceDayInfo === 'function' &&
        typeof exportPerformanceDayInfoExcel === 'function' &&
        typeof deletePerformanceDayInfo === 'function';
}

function ensurePerformanceDayEventsLoaded() {
    if (_performanceDayEventsReady()) {
        return Promise.resolve();
    }
    if (performanceDayEventsLoadPromise) {
        return performanceDayEventsLoadPromise;
    }
    performanceDayEventsLoadPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/static/js/modules/performance_day/events.js?v=20260701-1';
        script.async = true;
        script.addEventListener('load', function () {
            if (_performanceDayEventsReady()) {
                resolve();
            } else {
                performanceDayEventsLoadPromise = null;
                reject(new Error('Performance day events loaded but required functions are not defined'));
            }
        }, { once: true });
        script.addEventListener('error', function () {
            performanceDayEventsLoadPromise = null;
            reject(new Error('Performance day events script failed to load'));
        }, { once: true });
        document.head.appendChild(script);
    });
    return performanceDayEventsLoadPromise;
}

// ===== 乗り番・練習指示API =====
// Practice casting API moved to modules/practice_casting/api.js.
// Loaded on demand when the admin panel is opened.
var practiceCastingApiLoadPromise = null;

function _practiceCastingApiReady() {
    return typeof savePracticeInstructionAdmin === 'function' &&
        typeof deletePracticeInstructionAdmin === 'function' &&
        typeof saveCasting === 'function' &&
        typeof deleteCasting === 'function';
}

function ensurePracticeCastingApiLoaded() {
    if (_practiceCastingApiReady()) {
        return Promise.resolve();
    }
    if (practiceCastingApiLoadPromise) {
        return practiceCastingApiLoadPromise;
    }
    practiceCastingApiLoadPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/static/js/modules/practice_casting/api.js?v=20260701-1';
        script.async = true;
        script.addEventListener('load', function () {
            if (_practiceCastingApiReady()) {
                resolve();
            } else {
                practiceCastingApiLoadPromise = null;
                reject(new Error('Practice casting API loaded but required functions are not defined'));
            }
        }, { once: true });
        script.addEventListener('error', function () {
            practiceCastingApiLoadPromise = null;
            reject(new Error('Practice casting API script failed to load'));
        }, { once: true });
        document.head.appendChild(script);
    });
    return practiceCastingApiLoadPromise;
}

// ===== アルバム =====
// Albums moved to modules/albums.js.
// Loaded on demand when member-album tab is clicked.
var albumsLoadPromise = null;

function _albumsReady() {
    return typeof renderAlbumView === 'function' &&
        typeof openAlbumPhotoViewer === 'function' &&
        typeof closeAlbumPhotoViewer === 'function' &&
        typeof createAlbumEvent === 'function' &&
        typeof deleteAlbumEvent === 'function' &&
        typeof uploadAlbumPhotos === 'function' &&
        typeof deleteAlbumPhoto === 'function';
}

var improvementSuggestionsLoadPromise = null;
var notificationSettingsLoadPromise = null;

function ensureNotificationsLoaded() {
    if (window.PortalNotifications) return Promise.resolve();
    if (!notificationSettingsLoadPromise) {
        notificationSettingsLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/static/js/modules/notifications/settings.js?v=20261008-1';
            script.onload = () => window.PortalNotifications ? resolve() : reject(new Error('Notification module unavailable'));
            script.onerror = () => reject(new Error('Notification module failed to load'));
            document.head.appendChild(script);
        }).catch((error) => { notificationSettingsLoadPromise = null; throw error; });
    }
    return notificationSettingsLoadPromise;
}

function _improvementSuggestionsReady() {
    return typeof window.showImprovementSuggestions === 'function' &&
        typeof window.loadImprovementSuggestions === 'function';
}

function ensureImprovementSuggestionsLoaded() {
    if (_improvementSuggestionsReady()) {
        return Promise.resolve();
    }
    if (improvementSuggestionsLoadPromise) {
        return improvementSuggestionsLoadPromise;
    }

    improvementSuggestionsLoadPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/static/js/modules/improvement_suggestions.js?v=20261019-jst1';
        script.async = true;

        script.addEventListener('load', function () {
            if (_improvementSuggestionsReady()) {
                resolve();
                return;
            }
            improvementSuggestionsLoadPromise = null;
            reject(new Error('Improvement suggestion functions are unavailable'));
        }, { once: true });

        script.addEventListener('error', function () {
            improvementSuggestionsLoadPromise = null;
            reject(new Error('Improvement suggestion script failed to load'));
        }, { once: true });

        document.head.appendChild(script);
    });

    return improvementSuggestionsLoadPromise;
}

async function requestImprovementSuggestions() {
    try {
        await ensureImprovementSuggestionsLoaded();
        await window.showImprovementSuggestions();
    } catch (err) {
        console.warn('[improvement-suggestions] load failed', err);
        if (typeof showAlert === 'function') {
            showAlert(
                '\u6539\u5584\u6848\u6a5f\u80fd\u306e\u8aad\u8fbc\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u518d\u5ea6\u958b\u3044\u3066\u304f\u3060\u3055\u3044\u3002',
                'warning'
            );
        }
    }
}

function ensureAlbumsLoaded() {
    if (_albumsReady()) {
        return Promise.resolve();
    }
    if (albumsLoadPromise) {
        return albumsLoadPromise;
    }
    albumsLoadPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/static/js/modules/albums.js?v=20261020-thumbnails2';
        script.async = true;
        script.addEventListener('load', function () {
            if (_albumsReady()) {
                resolve();
            } else {
                albumsLoadPromise = null;
                reject(new Error('Albums script loaded but required functions are not defined'));
            }
        }, { once: true });
        script.addEventListener('error', function () {
            albumsLoadPromise = null;
            reject(new Error('Albums script failed to load'));
        }, { once: true });
        document.head.appendChild(script);
    });
    return albumsLoadPromise;
}

var memberFeatureLoadPromises = {};
// Lazy assets must use the same deployment revision as this entry script.
// Fixed v= URLs alone can otherwise mix an old form with a new API after release.
var memberFeatureRevision = (typeof document !== 'undefined' && document.currentScript?.src || '').match(/[?&]rev=([^&]+)/)?.[1] || '';
var memberFeatureScripts = {
    absence: ['/static/js/modules/absences.js?v=20260630-6'],
    // Recording DL uses the sheet library's save dialog (same PC/smartphone rules).
    recording: [
        '/static/js/modules/scores/sheet_api.js?v=20261018-1',
        '/static/js/modules/scores/save_dialog.js?v=20261019-dl2',
        '/static/js/modules/recordings.js?v=20261019-dl1',
    ],
    // The sheet library loads its own viewer (no other screen has to be
    // opened first). scores.js stays last and defines nothing.
    sheet: [
        '/static/js/modules/practice_casting/helpers.js?v=20260701-1',
        '/static/js/modules/scores/sheet_api.js?v=20261018-1',
        '/static/js/modules/scores/pdf_viewer.js?v=20261018-1',
        '/static/js/modules/scores/helpers.js?v=20261018-1',
        '/static/js/modules/scores/render.js?v=20261018-1',
        '/static/js/modules/scores/sync.js?v=20261019-dl1',
        '/static/js/modules/scores/save_dialog.js?v=20261019-dl2',
        '/static/js/modules/scores/upload_batch.js?v=20261018-1',
        '/static/js/modules/scores/events.js?v=20261018-1',
        '/static/js/modules/scores.js?v=20261018-1',
    ],
    // Reference scores use the same viewer and save dialog.
    datePiecePromotion: [
        '/static/js/modules/scores/sheet_api.js?v=20261018-1',
        '/static/js/modules/scores/pdf_viewer.js?v=20261018-1',
        '/static/js/modules/scores/save_dialog.js?v=20261019-dl2',
        '/static/js/modules/date_piece_promotion/helpers.js?v=20261019-jst1',
        '/static/js/modules/date_piece_promotion/validation.js?v=20260701-3',
        '/static/js/modules/date_piece_promotion/events.js?v=20260701-3',
        '/static/js/modules/date_piece_promotion/state.js?v=20260701-2',
        '/static/js/modules/date_piece_promotion/api.js?v=20261019-jst1',
        '/static/js/modules/date_piece_promotion/render_piece_practice.js?v=20260701-1',
        '/static/js/modules/date_piece_promotion/render_desired_promotion.js?v=20261019-jst1',
        '/static/js/modules/date_piece_promotion/render.js?v=20260701-3',
        '/static/js/modules/date_piece_promotion.js?v=20260630-6',
    ],
    practiceCasting: [
        '/static/js/modules/practice_casting/helpers.js?v=20260701-1',
        '/static/js/modules/practice_casting/render.js?v=20260701-1',
        '/static/js/modules/practice_casting/events.js?v=20260701-1',
        '/static/js/modules/practice_casting.js?v=20260701-1',
    ],
    performanceDay: [
        '/static/js/modules/performance_day/helpers.js?v=20260701-1',
        '/static/js/modules/performance_day/render.js?v=20260701-1',
    ],
    concertRecord: ['/static/js/modules/concert_record.js?v=20260808-1'],
};
var memberFeaturePreloadScheduled = false;

function ensureMemberFeatureLoaded(featureName) {
    if (memberFeatureLoadPromises[featureName]) return memberFeatureLoadPromises[featureName];
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return Promise.resolve();
    const scripts = memberFeatureScripts[featureName] || [];
    memberFeatureLoadPromises[featureName] = scripts.reduce(
        (promise, scriptPath) => promise.then(() => new Promise((resolve, reject) => {
            if (document.querySelector(`script[src*="${scriptPath.split('?')[0]}"]`)) {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = scriptPath + (memberFeatureRevision ? `&rev=${memberFeatureRevision}` : '');
            script.async = true;
            script.addEventListener('load', resolve, { once: true });
            script.addEventListener('error', () => reject(new Error(`Failed to load ${scriptPath}`)), { once: true });
            document.head.appendChild(script);
        })),
        Promise.resolve()
    ).then(() => {
        if (featureName === 'practiceCasting' && typeof bindCastingAdminEvents === 'function') {
            bindCastingAdminEvents();
        }
    }).catch((error) => {
        memberFeatureLoadPromises[featureName] = null;
        throw error;
    });
    return memberFeatureLoadPromises[featureName];
}

function scheduleLikelyMemberFeaturePreload() {
    if (memberFeaturePreloadScheduled) return;
    memberFeaturePreloadScheduled = true;

    const preloadOrder = ['recording', 'sheet', 'datePiecePromotion'];
    const runPreload = () => {
        preloadOrder.reduce(
            (p, featureName) => p.then(() => ensureMemberFeatureLoaded(featureName)).catch(() => {}),
            Promise.resolve()
        ).catch(() => {});
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(runPreload, { timeout: 2500 });
        return;
    }

    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        window.setTimeout(runPreload, 1000);
        return;
    }

    runPreload();
}

function ensureFeatureForMemberTab(tabName) {
    if (tabName === 'member-schedule' || tabName === 'member-absence') return ensureMemberFeatureLoaded('absence');
    if (tabName === 'member-recording') return ensureMemberFeatureLoaded('recording');
    if (tabName === 'member-album') return ensureAlbumsLoaded();
    if (tabName === 'member-sheet' || tabName === 'sheet-admin') return ensureMemberFeatureLoaded('sheet');
    if (['member-date-adjustment', 'member-piece-info', 'member-desired-piece', 'member-promotion'].includes(tabName)) {
        return ensureMemberFeatureLoaded('datePiecePromotion');
    }
    if (['member-casting', 'casting-admin', 'member-practice-instruction', 'practice-instruction-admin'].includes(tabName)) {
        return ensureMemberFeatureLoaded('practiceCasting');
    }
    if (['member-performance-day', 'performance-day-admin'].includes(tabName)) {
        return ensureMemberFeatureLoaded('performanceDay');
    }
    if (['member-concert-record', 'concert-record-admin'].includes(tabName)) {
        return ensureMemberFeatureLoaded('concertRecord');
    }
    return Promise.resolve();
}

function requestAdminPanel() {
    return (async () => {
        const authResult = await isPortalAuthenticated();
        if (authResult.status === 'unavailable') {
            showAlert('通信が不安定なため確認できません。しばらくしてから再試行してください。', 'warning');
            return;
        }
        if (authResult.status !== 'authenticated') {
            showPortalLogin();
            return;
        }
        if (!canAccessAdmin()) {
            showAlert('管理者権限がありません', 'warning');
            return;
        }
        await ensureAdminSystemModuleLoaded();
        try {
            await ensureAdminSystemApiLoaded();
        } catch (err) {
            console.warn('[管理API] スクリプトのロードに失敗しました', err);
            showAlert('管理機能の読込に失敗しました。再度開いてください。', 'warning');
            return;
        }
        try {
            await ensurePerformanceDayEventsLoaded();
        } catch (err) {
            console.warn('[本番情報] スクリプトのロードに失敗しました', err);
            showAlert('本番情報の管理機能を読み込めませんでした。再度開いてください。', 'warning');
            return;
        }
        try {
            await ensurePracticeCastingApiLoaded();
        } catch (err) {
            console.warn('[乗り番API] スクリプトのロードに失敗しました', err);
            showAlert('乗り番・練習指示の管理機能を読み込めませんでした。再度開いてください。', 'warning');
            return;
        }
        showAdminPanel(appState.currentUserPermission === 'システム管理者' ? 'system-admin' : 'admin');
    })();
}

var adminSystemModuleLoadPromise = null;
function ensureAdminSystemModuleLoaded() {
    if (typeof ensureAdminSystemApiLoaded === 'function') return Promise.resolve();
    if (adminSystemModuleLoadPromise) return adminSystemModuleLoadPromise;
    adminSystemModuleLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/static/js/modules/admin_system.js?v=20260630-6';
        script.async = true;
        script.addEventListener('load', () => {
            if (typeof ensureAdminSystemApiLoaded === 'function') resolve();
            else reject(new Error('Admin system module loaded without its loader'));
        }, { once: true });
        script.addEventListener('error', () => reject(new Error('Admin system module failed to load')), { once: true });
        document.head.appendChild(script);
    });
    return adminSystemModuleLoadPromise;
}

// ===== チューナー =====
// The tuner (modules/tuner/) owns the microphone. Every path that hides the
// system panel or switches tabs releases it through the launcher; leave() is
// synchronous and idempotent, so calling it on unrelated transitions is safe.
// Navigation sequence: every screen change (tab switch, panel change, history
// restore, logout via the tuner exit) advances it. A tuner history restore
// that awaited auth/module loading only switches screens if no newer
// navigation happened meanwhile, so it can never overwrite a later choice.
var portalNavigationSequence = 0;
function nextPortalNavigation() {
    portalNavigationSequence += 1;
    return portalNavigationSequence;
}
function isLatestPortalNavigation(ticket) {
    return ticket === portalNavigationSequence;
}
window.invalidatePortalNavigation = nextPortalNavigation;

function leavePortalTuner(reason) {
    nextPortalNavigation();
    // portalTunerLeave (laboratory module) also cancels a tap that is still
    // waiting for the launcher to load.
    if (typeof window.portalTunerLeave === 'function') window.portalTunerLeave(reason);
    else if (window.PortalTunerLauncher) window.PortalTunerLauncher.leave(reason);
}

// The metronome shares the laboratory exit (portalTunerLeave releases it
// too); only switching to the tuner tab has to release it explicitly.
function leavePortalMetronome(reason) {
    if (typeof window.portalMetronomeLeave === 'function') window.portalMetronomeLeave(reason);
    else if (window.PortalMetronomeLauncher) window.PortalMetronomeLauncher.leave(reason);
}

function enterPortalMetronomeTab() {
    if (typeof window.portalMetronomeEnter === 'function') window.portalMetronomeEnter();
}

function enterPortalTunerTab() {
    const host = $('systemTunerHost');
    if (window.PortalTunerLauncher && host) void window.PortalTunerLauncher.enter(host);
}

// The launcher is loaded by the laboratory module (improvement_suggestions.js).
// Preloading fetches code only: no AudioContext and no microphone.
function preloadPortalTuner() {
    let loading;
    if (window.PortalTunerLauncher) loading = Promise.resolve(window.PortalTunerLauncher);
    else if (typeof window.ensurePortalTunerLauncherLoaded === 'function') loading = window.ensurePortalTunerLauncherLoaded();
    else return Promise.resolve(false);
    return loading.then((launcher) => launcher.preload()).catch(() => false);
}

// History restore of the tuner tab: auth/permission first, then the
// laboratory module that creates the tab DOM, then the tuner body. This is
// not a user tap, so the tuner may end in "tap to resume" instead of measuring.
async function preparePortalTunerHistoryRestore(ticket, tabId) {
    const authResult = await isPortalAuthenticated();
    if (!isLatestPortalNavigation(ticket)) return false;
    if (authResult.status === 'unavailable') {
        showAlert('通信が不安定なため確認できません。しばらくしてから再試行してください。', 'warning');
        return false;
    }
    if (authResult.status !== 'authenticated') {
        showPortalLogin();
        return false;
    }
    if (!canAccessSystemAdmin()) {
        showAlert('システム管理者権限がありません', 'warning');
        return false;
    }
    try {
        await ensureImprovementSuggestionsLoaded();
    } catch (err) {
        if (!isLatestPortalNavigation(ticket)) return false;
        console.warn('[improvement-suggestions] load failed', err);
        showAlert('実験室の読込に失敗しました。再度開いてください。', 'warning');
        return false;
    }
    if (!isLatestPortalNavigation(ticket)) return false;
    await preloadPortalTuner();
    // Re-checked after the waits: a newer navigation, logout or lost rights wins.
    return isLatestPortalNavigation(ticket) && appState.portalAuthVerified === true &&
        canAccessSystemAdmin() && Boolean($(tabId || 'system-tunerTab'));
}

function showAdminPanel(role = 'admin') {
    leavePortalTuner('admin-panel');
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
    $('adminPanel').hidden = false;
    if ($('improvementSuggestionPanel')) $('improvementSuggestionPanel').hidden = true;
    updateOtherEnvironmentLink();
    $('memberPanel').hidden = true;
    if ($('systemPanel')) $('systemPanel').hidden = true;
    localStorage.setItem('userRole', role);
    switchTab('adminPanel', 'performance');
    window.scrollTo({ top: 0, behavior: 'auto' });
}

function showSystemPanel() {
    leavePortalTuner('system-panel');
    return (async () => {
        const authResult = await isPortalAuthenticated();
        if (authResult.status === 'unavailable') {
            showAlert('通信が不安定なため確認できません。しばらくしてから再試行してください。', 'warning');
            return;
        }
        if (authResult.status !== 'authenticated') {
            showPortalLogin();
            return;
        }
        if (!canAccessSystemAdmin()) {
            showAlert('システム管理者権限がありません', 'warning');
            return;
        }
        await ensureAdminSystemModuleLoaded();
        try {
            await ensureAdminSystemApiLoaded();
        } catch (err) {
            console.warn('[管理API] スクリプトのロードに失敗しました', err);
            showAlert('管理機能の読込に失敗しました。再度開いてください。', 'warning');
            return;
        }
        try {
            await ensureImprovementSuggestionsLoaded();
        } catch (err) {
            console.warn('[improvement-suggestions] load failed', err);
            showAlert(
                '\u6539\u5584\u6848\u7ba1\u7406\u6a5f\u80fd\u306e\u8aad\u8fbc\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u518d\u5ea6\u958b\u3044\u3066\u304f\u3060\u3055\u3044\u3002',
                'warning'
            );
            return;
        }
        if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
        $('memberPanel').hidden = true;
        $('adminPanel').hidden = true;
        if ($('improvementSuggestionPanel')) $('improvementSuggestionPanel').hidden = true;
        $('systemPanel').hidden = false;
        localStorage.setItem('userRole', 'system-admin');
        const initialTabTicket = portalNavigationSequence;
        await ensurePartSettingsMigrated();
        await loadAuthManagement();
        await ensureAdminEnvironmentManagementLoaded()
            .then(function () { return refreshSystemEnvironmentMenuVisibility(); })
            .catch(function (err) { console.warn('[\u74b0\u5883\u7ba1\u7406] \u30b9\u30af\u30ea\u30d7\u30c8\u306e\u30ed\u30fc\u30c9\u306b\u5931\u6557\u3057\u307e\u3057\u305f', err); });
        if (!(appState.connectionSettings || []).length) {
            await loadExtraData(['connectionSettings']);
        }
        renderOrgManagement();
        renderSnsManagement();
        renderConnectionSettingsManagement();
        renderPartManagement();
        // The panel is already interactive while these loads run. A later
        // tab choice must win over this delayed default selection.
        if (!isLatestPortalNavigation(initialTabTicket)) return;
        switchTab('systemPanel', 'system-auth');
        window.scrollTo({ top: 0, behavior: 'auto' });
    })();
}

function showMemberPanel(shouldRender = true) {
    return showMemberTab('member-home', shouldRender);
}

function showMemberTab(tabName, shouldRender = true) {
    leavePortalTuner('member-panel');
    return (async () => {
        const authResult = await isPortalAuthenticated();
        if (authResult.status === 'unavailable') {
            showAlert('通信が不安定なため確認できません。しばらくしてから再試行してください。', 'warning');
            return;
        }
        if (authResult.status !== 'authenticated') {
            showPortalLogin();
            return;
        }
        if (isExtraRestrictedMemberTab(tabName)) {
            tabName = 'member-home';
        }
        if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
        $('memberPanel').hidden = false;
        if ($('improvementSuggestionPanel')) $('improvementSuggestionPanel').hidden = true;
        $('adminPanel').hidden = true;
        if ($('systemPanel')) $('systemPanel').hidden = true;
        localStorage.setItem('userRole', 'member');
        updateManagerNavigationVisibility();
        if (shouldRender) renderMemberViews();
        switchTab('memberPanel', tabName, shouldRender);
    })();
}

function updateMemberTabHistory(tabName) {
    const normalizedTabName = String(tabName || '');
    if (!normalizedTabName) return;
    const currentTab = String(appState.currentMemberTab || '');
    if (currentTab && currentTab !== normalizedTabName) {
        appState.previousMemberTab = currentTab;
    }
    appState.currentMemberTab = normalizedTabName;
}

function makePortalHistoryState(panelId, tabName) {
    return {
        portalNavigation: true,
        panelId: String(panelId || ''),
        tabName: String(tabName || ''),
    };
}

function updatePortalBrowserHistory(panelId, tabName, historyMode = 'push') {
    if (historyMode === 'skip' || !window.history) return;
    if (typeof window.history.replaceState !== 'function' || typeof window.history.pushState !== 'function') return;

    const nextState = makePortalHistoryState(panelId, tabName);
    const currentState = window.history.state;
    if (
        currentState &&
        currentState.portalNavigation === true &&
        currentState.panelId === nextState.panelId &&
        currentState.tabName === nextState.tabName
    ) {
        return;
    }

    if (!currentState || currentState.portalNavigation !== true) {
        window.history.replaceState(nextState, '');
        return;
    }

    window.history.pushState(nextState, '');
}

async function restorePortalHistoryState(state) {
    if (!state || state.portalNavigation !== true) return;

    const panelId = String(state.panelId || '');
    const tabName = String(state.tabName || '');
    if (!tabName || !['memberPanel', 'adminPanel', 'systemPanel'].includes(panelId)) return;

    if (panelId === 'systemPanel' && (tabName === 'system-tuner' || tabName === 'system-metronome')) {
        // Laboratory screens: auth and the laboratory module first (it creates the tab).
        leavePortalTuner('history');
        const ticket = nextPortalNavigation();
        if (!(await preparePortalTunerHistoryRestore(ticket, `${tabName}Tab`))) return;
        if (!isLatestPortalNavigation(ticket)) return;
    } else {
        leavePortalTuner('history');
    }

    if ($('portalLoginPanel')) $('portalLoginPanel').hidden = true;
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
    if ($('improvementSuggestionPanel')) $('improvementSuggestionPanel').hidden = true;

    const memberPanel = $('memberPanel');
    const adminPanel = $('adminPanel');
    const systemPanel = $('systemPanel');
    if (memberPanel) memberPanel.hidden = panelId !== 'memberPanel';
    if (adminPanel) adminPanel.hidden = panelId !== 'adminPanel';
    if (systemPanel) systemPanel.hidden = panelId !== 'systemPanel';

    if (panelId === 'memberPanel') {
        localStorage.setItem('userRole', 'member');
        updateManagerNavigationVisibility();
    } else if (panelId === 'adminPanel') {
        localStorage.setItem(
            'userRole',
            appState.currentUserPermission === 'システム管理者' ? 'system-admin' : 'admin'
        );
    } else {
        localStorage.setItem('userRole', 'system-admin');
    }

    await switchTab(panelId, tabName, true, 'skip');
}

if (typeof window.addEventListener === 'function') {
    window.addEventListener('popstate', (event) => restorePortalHistoryState(event.state));
}

async function switchTab(panelId, tabName, renderOnShow = true, historyMode = 'push') {
    if (panelId === 'memberPanel' && isExtraRestrictedMemberTab(tabName)) {
        tabName = 'member-home';
    }
    const panel = $(panelId);
    if (!panel) return;
    nextPortalNavigation();
    const isTunerTab = panelId === 'systemPanel' && tabName === 'system-tuner';
    const isMetronomeTab = panelId === 'systemPanel' && tabName === 'system-metronome';
    if (!isTunerTab) leavePortalTuner('tab');
    else leavePortalMetronome('tab');
    if (panelId === 'memberPanel') {
        updateMemberTabHistory(tabName);
    }
    updatePortalBrowserHistory(panelId, tabName, historyMode);
    const toolbar = panel.querySelector('.toolbar');
    if (toolbar && panelId === 'memberPanel') {
        toolbar.hidden = tabName === 'member-home';
    }
    panel.querySelectorAll('.tab-content').forEach((tab) => {
        tab.hidden = true;
    });
    panel.querySelectorAll('[data-tab]').forEach((button) => {
        button.classList.remove('active');
    });

    const targetId = `${toPascalTab(tabName)}Tab`;
    // Leaving the PDF viewer by any route releases the document, its worker
    // and the canvases (the back buttons did it, the menu did not).
    if (tabName !== 'member-sheet-viewer' && typeof clearSheetViewer === 'function' && appState.sheetPdfUrl) clearSheetViewer();
    if (tabName === 'notification-settings') {
        try {
            await ensureNotificationsLoaded();
            await window.PortalNotifications.render();
        } catch {
            showAlert('通知設定を読み込めませんでした。もう一度開いてください。', 'warning');
            return;
        }
    }
    const target = $(targetId);
    if (target) target.hidden = false;
    const button = panel.querySelector(`[data-tab="${tabName}"]`);
    if (button) button.classList.add('active');
    // Entered after the tab is visible so the tuner's visibility guard passes.
    // Runs regardless of renderOnShow because the laboratory buttons pass false.
    if (isTunerTab) enterPortalTunerTab();
    if (isMetronomeTab) enterPortalMetronomeTab();
    if (panelId === 'systemPanel' && tabName === 'system-laboratory') void preloadPortalTuner();
    recordAccessLog(panelId, tabName);
    if (renderOnShow) {
        await ensureFeatureForMemberTab(tabName);
        await ensureDeferredTabDataLoaded(tabName);
    }
    if (renderOnShow && tabName === 'member-schedule') renderMemberSchedules();
    if (renderOnShow && tabName === 'member-home') renderPortalHome();
    if (renderOnShow && tabName === 'member-flyer-distribution') renderFlyerDistributionView();
    if (renderOnShow && tabName === 'member-performance-day') renderPerformanceDayInfoView();
    if (renderOnShow && tabName === 'member-concert-record') renderConcertRecordView();
    if (renderOnShow && tabName === 'member-manual') renderManualView();
    if (renderOnShow && tabName === 'member-album') renderAlbumView();
    if (renderOnShow && tabName === 'member-recording') ensureRecordingsLoaded();
    if (renderOnShow && tabName === 'member-sheet') ensureSheetsLoaded();
    if (renderOnShow && tabName === 'member-date-adjustment') renderDateAdjustmentView();
    if (renderOnShow && tabName === 'member-piece-info') renderPieceInfoView();
    if (renderOnShow && tabName === 'announcement-detail') renderAnnouncementDetail();
    if (renderOnShow && tabName === 'schedule') {
        renderSchedulePerformanceOptions();
        updateSchedulePieceOptions();
        renderSchedules();
    }
    if (renderOnShow && tabName === 'event') renderEvents();
    if (renderOnShow && tabName === 'member') renderMembers();
    if (renderOnShow && tabName === 'member-intro') await showMemberIntroView();
    if (renderOnShow && tabName === 'sheet-admin') ensureSheetsLoaded().then(renderSheetAdmin);
    if (renderOnShow && tabName === 'payment-admin') renderPaymentAdmin();
    if (renderOnShow && tabName === 'payment-setting') renderPaymentAdmin();
    if (renderOnShow && tabName === 'venue-admin') {
        if ((appState.venueSettings || []).length) {
            renderVenueManagement();
        } else {
            loadExtraData(['venueSettings'])
                .then(renderVenueManagement)
                .catch(function (err) {
                    console.warn('[会場設定] 遅延読込に失敗しました', err);
                });
        }
    }
    if (renderOnShow && tabName === 'flyer-distribution-admin') renderFlyerDistributionManagement();
    if (renderOnShow && tabName === 'casting-admin') renderCastingAdmin();
    if (renderOnShow && tabName === 'performance-day-admin') renderPerformanceDayInfoAdmin();
    if (renderOnShow && tabName === 'concert-record-admin') renderConcertRecordAdminView();
    if (renderOnShow && tabName === 'system-org') renderOrgManagement();
    if (renderOnShow && tabName === 'system-menu-management') {
        ensureSystemMenuManagementLoaded()
            .then(function () { return renderSystemMenuManagement(); })
            .catch(function (err) {
                console.warn('Menu management failed to load', err);
                showAlert('メニュー管理を読み込めませんでした。再度開いてください。', 'danger');
            });
    }
    if (renderOnShow && tabName === 'system-permission-management') {
        ensureSystemPermissionManagementLoaded()
            .then(function () { return renderSystemPermissionManagement(); })
            .catch(function (err) { console.warn('System permission management failed to load', err); });
    }
    if (renderOnShow && tabName === 'system-sns') renderSnsManagement();
    if (renderOnShow && tabName === 'system-connection') renderConnectionSettingsManagement();
    if (renderOnShow && tabName === 'system-environment') {
        ensureAdminEnvironmentManagementLoaded()
            .then(function () { renderSystemEnvironmentManagement(); })
            .catch(function (err) { console.warn('[\u74b0\u5883\u7ba1\u7406] \u30b9\u30af\u30ea\u30d7\u30c8\u306e\u30ed\u30fc\u30c9\u306b\u5931\u6557\u3057\u307e\u3057\u305f', err); });
    }
    if (renderOnShow && tabName === 'system-readiness') renderReadinessDashboard();
    if (renderOnShow && tabName === 'system-access-log') {
        if (typeof prepareAccessLogView !== 'function') {
            if (!window.accessLogAdminLoadPromise) {
                window.accessLogAdminLoadPromise = new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = '/static/js/modules/admin_system/access_logs.js?v=20261019-jst1';
                    script.async = true;
                    script.addEventListener('load', () => {
                        if (typeof prepareAccessLogView === 'function') {
                            resolve();
                        } else {
                            window.accessLogAdminLoadPromise = null;
                            reject(new Error('Access log module loaded but required functions are not defined'));
                        }
                    }, { once: true });
                    script.addEventListener('error', () => {
                        window.accessLogAdminLoadPromise = null;
                        reject(new Error('Access log module failed to load'));
                    }, { once: true });
                    document.head.appendChild(script);
                });
            }
            try {
                await window.accessLogAdminLoadPromise;
            } catch (error) {
                console.warn('[access-log] script load failed', error);
                showAlert('アクセスログ機能の読込に失敗しました。再度開いてください。', 'warning');
                return;
            }
        }
        prepareAccessLogView();
    }
    if (renderOnShow && tabName === 'system-database') {
        ensureAdminDatabaseViewerLoaded()
            .then(function () { renderDatabaseView(); })
            .catch(function (err) { console.warn('DB viewer failed to load', err); });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
