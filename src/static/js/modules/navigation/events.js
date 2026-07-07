// Navigation events split from modules/navigation.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

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

function enterPortal() {
    return (async () => {
        if ($('portalLoginPanel')) $('portalLoginPanel').hidden = true;
        await showMemberPanel(false);
        renderPortalHome();
        renderLoadingPlaceholders();
        setLoadingBar('読み込み中...');

        if (!appState.essentialDataLoaded) {
            loadEssentialData()
                .then(() => { appState.essentialDataLoaded = true; })
                .catch((error) => {
                    clearLoadingBar();
                    showAlert(error.message || 'データの読み込みに失敗しました', 'danger');
                })
                .finally(() => loadFullDataInBackground());
        } else {
            renderEssentialViews();
            loadFullDataInBackground();
        }
    })();
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
        showMemberPanel();
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
        refreshPortalData();
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
                refreshPortalData();
            }
        });
    }

    document.querySelectorAll('#adminPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('adminPanel', button.dataset.tab));
    });
    document.querySelectorAll('#memberPanel [data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab('memberPanel', button.dataset.tab));
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
