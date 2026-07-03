// Navigation menu helpers split from modules/navigation.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

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

function portalMenuGroups() {
    const paymentAlert = paymentAlertInfo().hasAlert;
    const settingItems = [
        canManageRecordings() ? { tab: 'upload', label: '録音管理', admin: true } : null,
        canManageSheets() ? { tab: 'sheet-admin', label: '楽譜管理', admin: true } : null,
        canAccessAdmin() ? { action: 'admin', label: '管理者メニュー', admin: true } : null,
        canAccessSystemAdmin() ? { action: 'system', label: 'システム管理', admin: true } : null,
    ].filter(Boolean);
    return [
        {
            title: '練習情報',
            items: [
                { tab: 'member-schedule', label: '練習予定' },
                { tab: 'member-absence', label: '欠席連絡' },
                { tab: 'member-practice-instruction', label: '練習指示' },
                { tab: 'member-recording', label: '録音部屋' },
            ],
        },
        {
            title: '演奏会情報',
            items: [
                { tab: 'member-performance', label: '演奏会情報' },
                { tab: 'member-flyer-distribution', label: 'チラシ配布' },
                { tab: 'member-performance-day', label: '本番情報' },
                { tab: 'member-piece-info', label: '楽曲紹介' },
                { tab: 'member-sheet', label: '楽譜ライブラリ' },
                { tab: 'member-casting', label: '乗り番表' },
            ],
        },
        {
            title: '団員情報',
            items: [
                { tab: 'member-intro', label: '団員紹介' },
                { tab: 'member-payment', label: '支払状況', alert: paymentAlert },
            ],
        },
        {
            title: `${orgShortName()}情報`,
            items: [
                { tab: 'member-event', label: 'イベント調整' },
                { tab: 'member-sns', label: 'SNS' },
                { tab: 'member-date-adjustment', label: '日程調整' },
                { tab: 'member-desired-piece', label: '演奏希望曲' },
            ],
        },
        {
            title: '記録',
            items: [
                { tab: 'member-promotion', label: '宣伝' },
                { tab: 'member-album', label: 'アルバム' },
                { tab: 'member-concert-record', label: '演奏会記録' },
            ],
        },
        {
            title: '設定',
            items: settingItems,
        },
    ].map((group) => ({ ...group, items: visibleMemberMenuItems(group.items) }))
        .filter((group) => group.items.length);
}

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
    const defaultPatch = {
        'member-piece-info': { selectedPieceInfoContext: null, pieceInfoEditing: false },
        'member-practice-instruction': { selectedPracticeInstructionContext: null, practiceInstructionEditing: false }
    };
    const patch = window.FrontendTestableLogic?.portalMenuStatePatch
        ? window.FrontendTestableLogic.portalMenuStatePatch(tabName)
        : (defaultPatch[tabName] || {});
    Object.assign(appState, patch);
    showMemberTab(tabName);
}

function renderPortalDrawerMenu() {
    renderMenuGroups($('portalDrawerMenu'));
}