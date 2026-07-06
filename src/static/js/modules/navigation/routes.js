// Navigation route/tab transitions split from modules/navigation.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function requestAdminPanel() {
    return (async () => {
        if (!(await isPortalAuthenticated())) {
            showPortalLogin();
            return;
        }
        if (!canAccessAdmin()) {
            showAlert('管理者権限がありません', 'warning');
            return;
        }
        showAdminPanel(appState.currentUserPermission === 'システム管理者' ? 'system-admin' : 'admin');
    })();
}

function showAdminPanel(role = 'admin') {
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
    $('adminPanel').hidden = false;
    $('memberPanel').hidden = true;
    if ($('systemPanel')) $('systemPanel').hidden = true;
    localStorage.setItem('userRole', role);
    switchTab('adminPanel', 'performance');
    window.scrollTo({ top: 0, behavior: 'auto' });
}

function showSystemPanel() {
    return (async () => {
        if (!(await isPortalAuthenticated())) {
            showPortalLogin();
            return;
        }
        if (!canAccessSystemAdmin()) {
            showAlert('システム管理者権限がありません', 'warning');
            return;
        }
        if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
        $('memberPanel').hidden = true;
        $('adminPanel').hidden = true;
        $('systemPanel').hidden = false;
        localStorage.setItem('userRole', 'system-admin');
        await ensurePartSettingsMigrated();
        await loadAuthManagement();
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
        if (!(await isPortalAuthenticated())) {
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
    if (renderOnShow && tabName === 'system-readiness') renderReadinessDashboard();
    if (renderOnShow && tabName === 'system-access-log') renderAccessLogView();
    if (renderOnShow && tabName === 'system-database') renderDatabaseView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
