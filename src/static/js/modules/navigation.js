// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

function setupPortalHome() {
    const memberPanel = $('memberPanel');
    if (!memberPanel || $('memberHomeTab')) return;

    const toolbar = memberPanel.querySelector('.toolbar');
    if (toolbar && !$('memberHomeBtn')) {
        toolbar.insertAdjacentHTML('afterbegin', '<button class="btn btn-sm btn-outline-secondary" id="memberHomeBtn" data-tab="member-home" type="button">ポータルトップ</button>');
    }

    memberPanel.insertAdjacentHTML('afterbegin', `
        <div id="memberHomeTab" class="tab-content">
            <section class="portal-home">
                <div class="portal-home-section">
                    <div class="portal-home-heading">
                        <h2>お知らせ</h2>
                    </div>
                    <div id="portalHomeAnnouncements"></div>
                </div>
                <div id="portalHomeCountdown"></div>
                <div class="portal-home-section">
                    <div class="portal-home-heading">
                        <h2>メニュー</h2>
                    </div>
                    <div class="portal-menu-groups" id="portalHomeMenu"></div>
                </div>
            </section>
        </div>
    `);
    if (!$('memberSheetViewerTab')) {
        memberPanel.insertAdjacentHTML('beforeend', `
            <div id="memberSheetViewerTab" class="tab-content" hidden>
                <div class="card sheet-viewer-card">
                    <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
                        <span id="sheetViewerTitle">楽譜表示</span>
                        <div class="d-flex flex-wrap gap-2">
                            <button class="btn btn-sm btn-outline-primary" id="sheetViewerZoomOut" type="button">縮小</button>
                            <button class="btn btn-sm btn-outline-primary" id="sheetViewerFitWidth" type="button">幅に合わせる</button>
                            <button class="btn btn-sm btn-outline-primary" id="sheetViewerZoomIn" type="button">拡大</button>
                            <a class="btn btn-sm btn-primary" id="sheetViewerDownload" href="#" download>DL</a>
                            <button class="btn btn-sm btn-outline-secondary" id="sheetViewerBackBtn" type="button">楽譜ライブラリに戻る</button>
                            <button class="btn btn-sm btn-outline-primary" id="sheetViewerMenuBtn" type="button">メニューに戻る</button>
                        </div>
                    </div>
                    <div class="card-body sheet-viewer-body">
                        <div class="sheet-viewer-status" id="sheetViewerStatus">楽譜を読み込み中...</div>
                        <div class="sheet-viewer-pages" id="sheetViewerPages"></div>
                    </div>
                </div>
            </div>
        `);
    }
}

// 団員パネル側に管理者用の導線タブを差し込む。
// 録音管理・楽譜管理を団員ビューからも開けるようにするための初期化。
// setupMemberManagerTabs moved to feature module.

function updateManagerNavigationVisibility() {
    const uploadButton = $('memberUploadAdminBtn');
    if (uploadButton) uploadButton.hidden = !canManageRecordings();
    const sheetButton = $('memberSheetAdminBtn');
    if (sheetButton) sheetButton.hidden = !canManageSheets();
    document.querySelectorAll('#memberPanel [data-tab]').forEach((button) => {
        const tabName = button.dataset.tab || '';
        if (EXTRA_RESTRICTED_MEMBER_TABS.has(tabName)) button.hidden = isExtraRestrictedMemberTab(tabName);
    });
}

const EXTRA_RESTRICTED_MEMBER_TABS = new Set([
    'member-payment',
    'member-event',
    'member-date-adjustment',
    'member-desired-piece'
]);

function isExtraUser() {
    return appState.currentUserPermission === 'エキストラ';
}

// isExtraRestrictedMemberTab moved to feature module.

// visibleMemberMenuItems moved to feature module.

function portalMenuGroups() {
    const paymentAlert = paymentAlertInfo().hasAlert;
    const settingItems = [
        canManageRecordings() ? { tab: 'upload', label: '録音管理', admin: true } : null,
        canManageSheets() ? { tab: 'sheet-admin', label: '楽譜管理', admin: true } : null,
        canAccessAdmin() ? { action: 'admin', label: '管理者メニュー', admin: true } : null,
        canAccessSystemAdmin() ? { action: 'system', label: 'システム管理', admin: true } : null
    ].filter(Boolean);
    return [
        {
            title: '練習情報',
            items: [
                { tab: 'member-schedule', label: '練習予定' },
                { tab: 'member-absence', label: '欠席連絡' },
                { tab: 'member-practice-instruction', label: '練習指示' },
                { tab: 'member-recording', label: '録音部屋' }
            ]
        },
        {
            title: '演奏会情報',
            items: [
                { tab: 'member-performance', label: '演奏会情報' },
                { tab: 'member-performance-day', label: '本番情報' },
                { tab: 'member-piece-info', label: '楽曲紹介' },
                { tab: 'member-sheet', label: '楽譜ライブラリ' },
                { tab: 'member-casting', label: '乗り番表' }
            ]
        },
        {
            title: '団員情報',
            items: [
                { tab: 'member-intro', label: '団員紹介' },
                { tab: 'member-payment', label: '支払状況', alert: paymentAlert }
            ]
        },
        {
            title: `${orgShortName()}情報`,
            items: [
                { tab: 'member-event', label: 'イベント調整' },
                { tab: 'member-sns', label: 'SNS' },
                { tab: 'member-date-adjustment', label: '日程調整' },
                { tab: 'member-desired-piece', label: '演奏希望曲' }
            ]
        },
        {
            title: '記録',
            items: [
                { tab: 'member-promotion', label: '宣伝' },
                { tab: 'member-album', label: 'アルバム' },
                { tab: 'member-concert-record', label: '演奏会記録' }
            ]
        },
        {
            title: '設定',
            items: settingItems
        }
    ].map((group) => ({ ...group, items: visibleMemberMenuItems(group.items) }))
        .filter((group) => group.items.length);
}

// メニュー定義から実際のボタン HTML とイベントを生成する。

function renderMenuGroups(container) {
    if (!container) return;
    const menuHTML = portalMenuGroups().map((group) => `
        <section class="portal-menu-group">
            <h3>${escapeHtml(group.title)}</h3>
            <div class="portal-menu-grid">
                ${group.items.map((item) => `
                    <button class="portal-menu-button${item.admin ? ' admin' : ''}${item.alert ? ' alert-blink' : ''}" type="button" ${item.tab ? `data-home-tab="${escapeHtml(item.tab)}"` : ''} ${item.action ? `data-home-${escapeHtml(item.action)}` : ''}>
                        <span>${escapeHtml(item.label)}</span>
                    </button>
                `).join('')}
            </div>
        </section>
    `).join('');
    
    // アクションセクション（マニュアル、ログアウト、更新、リビジョン）を設定グループの下に追加
    const actionsHTML = `
        <section class="portal-menu-actions-section">
            <div class="portal-drawer-actions">
                <button class="btn btn-outline-primary" data-drawer-action="manual" type="button">マニュアル</button>
                <button class="btn btn-outline-danger" data-drawer-action="logout" type="button">ログアウト</button>
                <button class="btn btn-outline-success" data-drawer-action="reload" type="button">更新</button>
                <span class="revision-inline">Rev. <span data-revision-number>${escapeHtml(currentRevisionText())}</span></span>
            </div>
        </section>
    `;
    
    container.innerHTML = menuHTML + actionsHTML;
    updateCloudRunRevision();
    
    container.querySelectorAll('[data-home-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            closePortalDrawer();
            openPortalMenuTab(button.dataset.homeTab || 'member-home');
        });
    });
    const adminButton = container.querySelector('[data-home-admin]');
    if (adminButton) adminButton.addEventListener('click', () => {
        closePortalDrawer();
        requestAdminPanel();
    });
    const systemButton = container.querySelector('[data-home-system]');
    if (systemButton) systemButton.addEventListener('click', () => {
        closePortalDrawer();
        showSystemPanel();
    });

    const manualButton = container.querySelector('[data-drawer-action="manual"]');
    if (manualButton) manualButton.addEventListener('click', () => {
        closePortalDrawer();
        showMemberTab('member-manual');
    });

    const logoutButton = container.querySelector('[data-drawer-action="logout"]');
    if (logoutButton) logoutButton.addEventListener('click', logoutPortal);

    const reloadButton = container.querySelector('[data-drawer-action="reload"]');
    if (reloadButton) reloadButton.addEventListener('click', () => {
        setLoadingBar('更新中...');
        window.location.reload();
    });

    updateCloudRunRevision();
}

function openPortalMenuTab(tabName) {
    if (tabName === 'member-piece-info') {
        appState.selectedPieceInfoContext = null;
        appState.pieceInfoEditing = false;
    }
    if (tabName === 'member-practice-instruction') {
        appState.selectedPracticeInstructionContext = null;
        appState.practiceInstructionEditing = false;
    }
    showMemberTab(tabName);
}

function renderPortalDrawerMenu() {
    renderMenuGroups($('portalDrawerMenu'));
}

// サイドドロワーを開く。

function openPortalDrawer() {
    renderPortalDrawerMenu();
    const drawer = $('portalDrawer');
    const backdrop = $('portalDrawerBackdrop');
    if (drawer) drawer.hidden = false;
    if (backdrop) backdrop.hidden = false;
    if ($('portalDrawerToggle')) $('portalDrawerToggle').setAttribute('aria-expanded', 'true');
}

// サイドドロワーを閉じる。

function closePortalDrawer() {
    const drawer = $('portalDrawer');
    const backdrop = $('portalDrawerBackdrop');
    if (drawer) drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
    if ($('portalDrawerToggle')) $('portalDrawerToggle').setAttribute('aria-expanded', 'false');
}

// テキストをその場でダウンロードさせるためのヘルパー。

async function enterPortal() {
    if ($('portalLoginPanel')) $('portalLoginPanel').hidden = true;

    // まずポータルメニューだけを表示し、データ取得待ちによる白画面を避ける。
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
}

// 主要ボタンやタブ切り替えのイベントを束ねてバインドする。

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
        window.location.reload();
    });

    // ドロワー内ボタンは動的再描画されるため、親要素でイベント委譲して取りこぼしを防ぐ。
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
                window.location.reload();
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

// ログアウト処理。
// 認証情報を破棄し、状態を初期化してログイン画面へ戻す。

function logoutPortal() {
    localStorage.removeItem(PORTAL_AUTH_KEY);
    localStorage.removeItem('userRole');
    appState.portalAuthVerified = false;
    appState.currentUserMemberId = null;
    appState.currentUserName = '';
    appState.currentUserPermission = '';
    appState.currentUserPart = '';
    appState.currentUserIsRecordingManager = false;
    appState.currentUserIsSheetManager = false;
    closePortalDrawer();
    showPortalLogin();
}

// 録音アップロード関連 UI のイベントを設定する。

async function requestAdminPanel() {
    if (!(await isPortalAuthenticated())) {
        showPortalLogin();
        return;
    }
    if (!canAccessAdmin()) {
        showAlert('管理者権限がありません', 'warning');
        return;
    }
    showAdminPanel(appState.currentUserPermission === 'システム管理者' ? 'system-admin' : 'admin');
}

// 管理者パネルを表示し、初期タブへ切り替える。

function showAdminPanel(role = 'admin') {
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
    $('adminPanel').hidden = false;
    $('memberPanel').hidden = true;
    if ($('systemPanel')) $('systemPanel').hidden = true;
    localStorage.setItem('userRole', role);
    switchTab('adminPanel', 'performance');
    window.scrollTo({ top: 0, behavior: 'auto' });
}

// システム管理パネルを表示する。
// 事前に必要データを読み込み、最初のタブ状態を整える。

async function showSystemPanel() {
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
}

// 団員パネルの既定タブ（ホーム）を表示する。

async function showMemberPanel(shouldRender = true) {
    await showMemberTab('member-home', shouldRender);
}

// 指定した団員タブを表示する共通入口。

async function showMemberTab(tabName, shouldRender = true) {
    if (!(await isPortalAuthenticated())) {
        showPortalLogin();
        return;
    }
    if (isExtraRestrictedMemberTab(tabName)) {
        tabName = 'member-home';
    }
    if (tabName === 'member-piece-info') {
        appState.selectedPieceInfoContext = null;
    }
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
    $('memberPanel').hidden = false;
    $('adminPanel').hidden = true;
    if ($('systemPanel')) $('systemPanel').hidden = true;
    localStorage.setItem('userRole', 'member');
    updateManagerNavigationVisibility();
    if (shouldRender) renderMemberViews();
    switchTab('memberPanel', tabName, shouldRender);
}

// パネル内タブを切り替える共通処理。
// タブ表示と同時に必要な再描画/遅延ロードを行う。

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
    if (renderOnShow && tabName === 'member-performance-day') renderPerformanceDayInfoView();
    if (renderOnShow && tabName === 'member-manual') renderManualView();
    if (renderOnShow && tabName === 'member-recording') ensureRecordingsLoaded();
    if (renderOnShow && tabName === 'member-sheet') ensureSheetsLoaded();
    if (renderOnShow && tabName === 'member-date-adjustment') renderDateAdjustmentView();
    if (renderOnShow && tabName === 'member-piece-info') renderPieceInfoView();
    if (renderOnShow && tabName === 'announcement-detail') renderAnnouncementDetail();
    if (renderOnShow && tabName === 'sheet-admin') ensureSheetsLoaded().then(renderSheetAdmin);
    if (renderOnShow && tabName === 'payment-setting') renderPaymentAdmin();
    if (renderOnShow && tabName === 'venue-admin') renderVenueManagement();
    if (renderOnShow && tabName === 'casting-admin') renderCastingAdmin();
    if (renderOnShow && tabName === 'performance-day-admin') renderPerformanceDayInfoAdmin();
    if (renderOnShow && tabName === 'system-org') renderOrgManagement();
    if (renderOnShow && tabName === 'system-sns') renderSnsManagement();
    if (renderOnShow && tabName === 'system-connection') renderConnectionSettingsManagement();
    if (renderOnShow && tabName === 'system-access-log') renderAccessLogView();
    if (renderOnShow && tabName === 'system-database') renderDatabaseView();
    
    // 画面上部にスクロール
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// data-tab の識別子を DOM 要素 ID 規則へ変換する。

function toPascalTab(value) {
    const map = {
        upload: 'upload',
        performance: 'performance',
        'performance-day-admin': 'performanceDayAdmin',
        schedule: 'schedule',
        announcement: 'announcement',
        event: 'event',
        member: 'member',
        'payment-admin': 'paymentAdmin',
        'payment-setting': 'paymentSetting',
        'venue-admin': 'venueAdmin',
        'casting-admin': 'castingAdmin',
        'sheet-admin': 'sheetAdmin',
        'member-home': 'memberHome',
        'member-announce': 'memberAnnounce',
        'member-performance': 'memberPerformance',
        'member-performance-day': 'memberPerformanceDay',
        'member-schedule': 'memberSchedule',
        'member-practice-instruction': 'memberPracticeInstruction',
        'member-recording': 'memberRecording',
        'member-intro': 'memberIntro',
        'member-absence': 'memberAbsence',
        'member-sheet': 'memberSheet',
        'member-sheet-viewer': 'memberSheetViewer',
        'member-payment': 'memberPayment',
        'member-casting': 'memberCasting',
        'member-event': 'memberEvent',
        'member-date-adjustment': 'memberDateAdjustment',
        'member-piece-info': 'memberPieceInfo',
        'member-desired-piece': 'memberDesiredPiece',
        'member-promotion': 'memberPromotion',
        'member-manual': 'memberManual',
        'member-album': 'memberAlbum',
        'member-concert-record': 'memberConcertRecord',
        'member-sns': 'memberSns',
        'announcement-detail': 'announcementDetail',
        'system-auth': 'systemAuth',
        'system-org': 'systemOrg',
        'system-sns': 'systemSns',
        'system-connection': 'systemConnection',
        'system-part': 'systemPart',
        'system-access-log': 'systemAccessLog',
        'system-database': 'systemDatabase',
    };
    return map[value] || value;
}

const ACCESS_LOG_MENU_LABELS = {
    upload: '録音管理',
    performance: '演奏会情報管理',
    'performance-day-admin': '本番情報管理',
    schedule: '練習予定管理',
    announcement: 'お知らせ管理',
    event: 'イベント管理',
    member: '団員登録',
    'payment-admin': '支払管理',
    'payment-setting': '支払設定',
    'venue-admin': '会場管理',
    'casting-admin': '乗り番管理',
    'sheet-admin': '楽譜管理',
    'member-home': 'ポータルメニュー',
    'member-announce': 'お知らせ',
    'member-performance': '演奏会情報',
    'member-performance-day': '本番情報',
    'member-schedule': '練習予定',
    'member-practice-instruction': '練習指示',
    'member-recording': '録音部屋',
    'member-intro': '団員紹介',
    'member-absence': '欠席連絡',
    'member-sheet': '楽譜ライブラリ',
    'member-sheet-viewer': '楽譜表示',
    'member-payment': '支払状況',
    'member-casting': '乗り番表',
    'member-event': 'イベント調整',
    'member-date-adjustment': '日程調整',
    'member-piece-info': '楽曲紹介',
    'member-desired-piece': '演奏希望曲',
    'member-promotion': '宣伝',
    'member-manual': 'マニュアル',
    'member-album': 'アルバム',
    'member-concert-record': '演奏会記録',
    'member-sns': 'SNS',
    'announcement-detail': 'お知らせ詳細',
    'system-auth': '認証端末管理',
    'system-org': '団体情報管理',
    'system-sns': 'SNS情報',
    'system-connection': '接続先情報',
    'system-part': 'パート管理',
    'system-access-log': 'アクセスログ',
    'system-database': 'データベース'
};

function accessLogPanelLabel(panelId) {
    if (panelId === 'systemPanel') return 'システム管理';
    if (panelId === 'adminPanel') return '管理者メニュー';
    return '団員メニュー';
}

function recordAccessLog(panelId, tabName) {
    if (!appState.portalAuthVerified) return;
    const deviceId = localStorage.getItem(PORTAL_DEVICE_ID_KEY) || '';
    if (!deviceId) return;
    const payload = {
        panel: accessLogPanelLabel(panelId),
        menu_key: tabName,
        menu_label: ACCESS_LOG_MENU_LABELS[tabName] || tabName
    };
    fetch('/api/system/access-logs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Device-Id': deviceId
        },
        body: JSON.stringify(payload)
    }).catch((error) => console.warn('Access log save failed:', error));
}

// アップロード先パスのプレビュー表示を更新する。

function updateSavePath() {
    if (!$('savePath')) return;
    const date = $('uploadDate').value || today();
    const piece = $('uploadPiece').value.trim() || '未分類';
    $('savePath').textContent = `/converted/${date}/${piece}/`;
}

// 選択された録音ファイルを検証し、状態へ保持する。
