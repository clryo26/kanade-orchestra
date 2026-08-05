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

function showAdminPanel(role = 'admin') {
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
    $('adminPanel').hidden = false;
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
        try {
            await ensureAdminSystemApiLoaded();
        } catch (err) {
            console.warn('[管理API] スクリプトのロードに失敗しました', err);
            showAlert('管理機能の読込に失敗しました。再度開いてください。', 'warning');
            return;
        }
        if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
        $('memberPanel').hidden = true;
        $('adminPanel').hidden = true;
        $('systemPanel').hidden = false;
        localStorage.setItem('userRole', 'system-admin');
        await ensurePartSettingsMigrated();
        await loadAuthManagement();
        await ensureAdminEnvironmentManagementLoaded()
            .then(function () { return refreshSystemEnvironmentMenuVisibility(); })
            .catch(function (err) { console.warn('[\u74b0\u5883\u7ba1\u7406] \u30b9\u30af\u30ea\u30d7\u30c8\u306e\u30ed\u30fc\u30c9\u306b\u5931\u6557\u3057\u307e\u3057\u305f', err); });
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
        $('adminPanel').hidden = true;
        if ($('systemPanel')) $('systemPanel').hidden = true;
        localStorage.setItem('userRole', 'member');
        updateManagerNavigationVisibility();
        if (shouldRender) renderMemberViews();
        switchTab('memberPanel', tabName, shouldRender);
    })();
}

function switchTab(panelId, tabName, renderOnShow = true) {
    if (panelId === 'memberPanel' && isExtraRestrictedMemberTab(tabName)) {
        tabName = 'member-home';
    }
    const panel = $(panelId);
    if (!panel) return;
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
    if (renderOnShow && tabName === 'member-home') renderPortalHome();
    if (renderOnShow && tabName === 'member-flyer-distribution') renderFlyerDistributionView();
    if (renderOnShow && tabName === 'member-performance-day') renderPerformanceDayInfoView();
    if (renderOnShow && tabName === 'member-manual') renderManualView();
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
    if (renderOnShow && tabName === 'sheet-admin') ensureSheetsLoaded().then(renderSheetAdmin);
    if (renderOnShow && tabName === 'payment-admin') renderPaymentAdmin();
    if (renderOnShow && tabName === 'payment-setting') renderPaymentAdmin();
    if (renderOnShow && tabName === 'venue-admin') renderVenueManagement();
    if (renderOnShow && tabName === 'flyer-distribution-admin') renderFlyerDistributionManagement();
    if (renderOnShow && tabName === 'casting-admin') renderCastingAdmin();
    if (renderOnShow && tabName === 'performance-day-admin') renderPerformanceDayInfoAdmin();
    if (renderOnShow && tabName === 'system-org') renderOrgManagement();
    if (renderOnShow && tabName === 'system-sns') renderSnsManagement();
    if (renderOnShow && tabName === 'system-connection') renderConnectionSettingsManagement();
    if (renderOnShow && tabName === 'system-environment') {
        ensureAdminEnvironmentManagementLoaded()
            .then(function () { renderSystemEnvironmentManagement(); })
            .catch(function (err) { console.warn('[\u74b0\u5883\u7ba1\u7406] \u30b9\u30af\u30ea\u30d7\u30c8\u306e\u30ed\u30fc\u30c9\u306b\u5931\u6557\u3057\u307e\u3057\u305f', err); });
    }
    if (renderOnShow && tabName === 'system-readiness') renderReadinessDashboard();
    if (renderOnShow && tabName === 'system-access-log') renderAccessLogView();
    if (renderOnShow && tabName === 'system-database') {
        ensureAdminDatabaseViewerLoaded()
            .then(function () { renderDatabaseView(); })
            .catch(function (err) { console.warn('DB viewer failed to load', err); });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
