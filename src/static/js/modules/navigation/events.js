// Navigation events split from modules/navigation.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

// ===== Album lazy loading state =====
var lastSelectedMemberTab = null;
var isAlbumsLoadingForMemberTab = false;

function openPortalDrawer() {
    renderPortalDrawerMenu();
    const drawer = $('portalDrawer');
    const backdrop = $('portalDrawerBackdrop');
    if (drawer) drawer.hidden = false;
    if (backdrop) backdrop.hidden = false;
    if ($('portalDrawerToggle')) $('portalDrawerToggle').setAttribute('aria-expanded', 'true');
}

function closePortalDrawer() {
    const drawer = $('portalDrawer');
    const backdrop = $('portalDrawerBackdrop');
    if (drawer) drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
    if ($('portalDrawerToggle')) $('portalDrawerToggle').setAttribute('aria-expanded', 'false');
}

function ensureAttendanceFollowupLoaded() {
    if (typeof attendanceOverviewSchedules === 'function') return Promise.resolve();
    if (!window.portalRuntimeContext.attendanceFollowupLoadPromise) {
        window.portalRuntimeContext.attendanceFollowupLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/static/js/modules/attendance_followup.js?v=20260819-1';
            script.addEventListener('load', resolve, { once: true });
            script.addEventListener('error', () => {
                window.portalRuntimeContext.attendanceFollowupLoadPromise = null;
                reject(new Error('出欠画面の追加機能を読み込めませんでした'));
            }, { once: true });
            document.head.appendChild(script);
        });
    }
    return window.portalRuntimeContext.attendanceFollowupLoadPromise;
}

async function loadAttendanceReminderAfterStartup() {
    try {
        await ensureMemberFeatureLoaded('absence');
        await Promise.all([
            ensureAttendanceFollowupLoaded(),
            loadExtraData(['absences']),
        ]);
        if (typeof markDeferredPortalDataLoaded === 'function') markDeferredPortalDataLoaded('absences');
        if (typeof renderMemberSchedules === 'function') renderMemberSchedules();
        if (typeof showUpcomingAttendanceReminder === 'function') showUpcomingAttendanceReminder();
    } catch (error) {
        console.warn('Attendance reminder data load failed; reminder suppressed', error);
    }
}

// loadEssentialData完亁E��で征E��し、完亁E��に起動画面を非表示にする
async function enterPortal() {
    if ($('portalLoginPanel')) $('portalLoginPanel').hidden = true;
    await showMemberPanel(false);
    renderPortalHome();
    renderLoadingPlaceholders();
    setLoadingBar('読み込み中...');

    if (!appState.essentialDataLoaded) {
        try {
            await loadEssentialData({ useCachedPreview: true });
            appState.essentialDataLoaded = true;
        } catch (error) {
            clearLoadingBar();
            showAlert(error.message || 'データの読み込みに失敗しました', 'danger');
            throw error; // 呼出允E_runAuthAndStart筁Eへ伝播
        }
    } else {
        renderEssentialViews();
    }

    // 正常起動完亁E 起動画面を非表示にする
    if (window.portalStartup) window.portalStartup.ready();

    if (typeof scheduleLikelyMemberFeaturePreload === 'function') {
        scheduleLikelyMemberFeaturePreload();
    }

    // 出欠追加機能と最新の出欠データは初回表示後に取得し、
    // 両方の取得成功後だけ督促判定する。
    void loadAttendanceReminderAfterStartup();

    // 背景チE�Eタ読込は操作可能化後に開始。エラーは冁E��で処琁E��る、E
    void loadFullDataInBackground();
}

function bindNavigation() {
    const brand = document.querySelector('.navbar-brand');
    if (brand) brand.addEventListener('click', (event) => {
        event.preventDefault();
        showMemberPanel();
    });
    if ($('portalDrawerToggle')) $('portalDrawerToggle').addEventListener('click', openPortalDrawer);
    if ($('portalDrawerClose')) $('portalDrawerClose').addEventListener('click', closePortalDrawer);
    if ($('portalDrawerBackdrop')) $('portalDrawerBackdrop').addEventListener('click', closePortalDrawer);
    if ($('sheetViewerBackBtn')) $('sheetViewerBackBtn').addEventListener('click', () => {
        clearSheetViewer();
        showMemberTab('member-sheet');
    });
    if ($('sheetViewerMenuBtn')) $('sheetViewerMenuBtn').addEventListener('click', () => {
        clearSheetViewer();
        showMemberTab(appState.previousMemberTab || 'member-home');
    });
    if ($('sheetViewerZoomOut')) $('sheetViewerZoomOut').addEventListener('click', () => zoomSheetViewer(-0.15));
    if ($('sheetViewerZoomIn')) $('sheetViewerZoomIn').addEventListener('click', () => zoomSheetViewer(0.15));
    if ($('sheetViewerFitWidth')) $('sheetViewerFitWidth').addEventListener('click', () => fitSheetViewerWidth());
    if ($('portalManualBtn')) $('portalManualBtn').addEventListener('click', () => {
        closePortalDrawer();
        showMemberTab('member-manual');
    });
    if ($('portalLogoutBtn')) $('portalLogoutBtn').addEventListener('click', logoutPortal);
    if ($('portalReloadBtn')) $('portalReloadBtn').addEventListener('click', () => {
        setLoadingBar('更新中...');
        void refreshPortalWithRevisionCheck();
    });

    const drawerMenu = $('portalDrawerMenu');
    if (drawerMenu) {
        drawerMenu.addEventListener('click', (event) => {
            const button = event.target.closest('[data-drawer-action]');
            if (!button) return;
            const action = button.dataset.drawerAction;
            if (action === 'manual') {
                closePortalDrawer();
                showMemberTab('member-manual');
                return;
            }
            if (action === 'logout') {
                logoutPortal();
                return;
            }
            if (action === 'reload') {
                setLoadingBar('更新中...');
                void refreshPortalWithRevisionCheck();
            }
        });
    }

    document.querySelectorAll('#adminPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('adminPanel', button.dataset.tab));
    });
    // Member panel tabs: special handling for member-album lazy loading
    document.querySelectorAll('#memberPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            const tabName = button.dataset.tab;
            lastSelectedMemberTab = tabName;

            if (tabName !== 'member-album') {
                switchTab('memberPanel', tabName);
                return;
            }

            if (isAlbumsLoadingForMemberTab) {
                return;
            }

            isAlbumsLoadingForMemberTab = true;
            ensureAlbumsLoaded()
                .then(function () {
                    if (lastSelectedMemberTab !== 'member-album') {
                        return;
                    }
                    return switchTab('memberPanel', 'member-album');
                })
                .catch(function (err) {
                    console.warn('[Album] Failed to load:', err);
                    showAlert('アルバム機能を読み込めませんでした。もう一度お試しください。', 'warning');
                })
                .finally(function () {
                    isAlbumsLoadingForMemberTab = false;
                });
        });
    });
    document.querySelectorAll('#systemPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('systemPanel', button.dataset.tab));
    });
}

function logoutPortal() {
    localStorage.removeItem(window.portalRuntimeContext.PORTAL_AUTH_KEY);
    localStorage.removeItem('userRole');
    appState.portalAuthVerified = false;
    appState.currentUserMemberId = null;
    appState.currentUserName = '';
    appState.currentUserPermission = '';
    appState.currentUserPart = '';
    appState.currentUserHiddenUser = false;
    appState.currentUserIsRecordingManager = false;
    appState.currentUserIsSheetManager = false;
    closePortalDrawer();
    showPortalLogin();
}
