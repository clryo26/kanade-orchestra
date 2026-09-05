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
        script.src = '/static/js/modules/improvement_suggestions.js?v=20260808-2';
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
        script.src = '/static/js/modules/albums.js?v=20260630-6';
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
var memberFeatureScripts = {
    absence: ['/static/js/modules/absences.js?v=20260630-6'],
    recording: ['/static/js/modules/recordings.js?v=20260731-1'],
    sheet: [
        '/static/js/modules/practice_casting/helpers.js?v=20260701-1',
        '/static/js/modules/scores/helpers.js?v=20260701-1',
        '/static/js/modules/scores/render.js?v=20260701-1',
        '/static/js/modules/scores/events.js?v=20260701-1',
        '/static/js/modules/scores.js?v=20260701-1',
    ],
    datePiecePromotion: [
        '/static/js/modules/date_piece_promotion/helpers.js?v=20260701-1',
        '/static/js/modules/date_piece_promotion/validation.js?v=20260701-3',
        '/static/js/modules/date_piece_promotion/events.js?v=20260701-3',
        '/static/js/modules/date_piece_promotion/state.js?v=20260701-2',
        '/static/js/modules/date_piece_promotion/api.js?v=20260701-2',
        '/static/js/modules/date_piece_promotion/render_piece_practice.js?v=20260701-1',
        '/static/js/modules/date_piece_promotion/render_desired_promotion.js?v=20260701-1',
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
            script.src = scriptPath;
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

function showAdminPanel(role = 'admin') {
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
        switchTab('systemPanel', 'system-auth');
        window.scrollTo({ top: 0, behavior: 'auto' });
    })();
}

function showMemberPanel(shouldRender = true) {
    return showMemberTab('member-home', shouldRender);
}

function showMemberTab(tabName, shouldRender = true) {
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
    const target = $(targetId);
    if (target) target.hidden = false;
    const button = panel.querySelector(`[data-tab="${tabName}"]`);
    if (button) button.classList.add('active');
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
                    script.src = '/static/js/modules/admin_system/access_logs.js?v=20260812-1';
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
