const appState = {
    selectedFiles: [],
    performancePieces: [],
    performancePieceEditIndex: null,
    performances: [],
    schedules: [],
    announcements: [],
    events: [],
    members: [],
    recordings: [],
    absences: [],
    eventResponses: [],
    sheetLibrary: [],
    payments: [],
    castings: [],
    pieceInfos: [],
    albums: [],
    partSettings: [],
    venueSettings: [],
    orgSettings: [],
    snsSettings: [],
    currentAudio: null,
    currentPlayButton: null,
    continuousPlayback: false,
    dataLoaded: false,
    authDevices: [],
    suppressDerivedRender: false,
    portalAuthVerified: false,
    currentUserMemberId: null,
    currentUserName: '',
    currentUserPermission: '',
    currentUserPart: '',
    currentUserIsRecordingManager: false,
    currentUserIsSheetManager: false,
    sheetPdfScale: 1,
    sheetPdfUrl: '',
    sheetPdfRendering: false,
    manifestObjectUrl: '',
    sheetFilters: {
        performanceId: '',
        piece: '',
        part: ''
    }
};

const today = () => new Date().toISOString().slice(0, 10);
const $ = (id) => document.getElementById(id);
const PORTAL_AUTH_KEY = 'kanadePortalAuthenticated';
const PORTAL_DEVICE_ID_KEY = 'kanadePortalDeviceId';
const SCHEDULE_EXTRA_PIECES = ['未定', 'ポップス全曲', 'クラシック全曲'];
const DEFAULT_MEMBER_PARTS = ['Violin', 'Viola', 'Cello', 'Contrabass', 'Flute', 'Oboe', 'Clarinet', 'Fagot', 'Horn', 'Trumpet', 'Trombone', 'Tuba', 'Percussion', 'Piano'];

async function withButtonStatus(button, processingLabel, task) {
    if (!button || button.disabled) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = processingLabel;
    try {
        return await task();
    } catch (error) {
        showAlert(error.message || '処理に失敗しました', 'danger');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function setOperationStatus(id, message, type = 'info') {
    const element = $(id);
    if (!element) return;
    element.hidden = false;
    element.className = `operation-status operation-status-${type}`;
    element.textContent = message;
}

document.addEventListener('DOMContentLoaded', async () => {
    setDefaultDates();
    setupPortalHome();
    setupMemberManagerTabs();
    bindNavigation();
    bindUpload();
    bindForms();
    updateSavePath();
    await loadPartSettingsForLogin();
    if (await isPortalAuthenticated()) {
        await enterPortal();
    } else {
        showPortalLogin();
    }
});

async function loadPartSettingsForLogin() {
    try {
        const [partSettings, orgSettings, snsSettings] = await Promise.all([
            request('/api/extra/part_settings'),
            request('/api/extra/org_settings'),
            request('/api/extra/sns_settings')
        ]);
        appState.partSettings = partSettings;
        appState.orgSettings = orgSettings;
        appState.snsSettings = snsSettings;
        refreshPartSelectOptions();
        applyOrgSettings();
    } catch {
        refreshPartSelectOptions();
        applyOrgSettings();
    }
}

function setDefaultDates() {
    ['uploadDate', 'schedDate', 'annDate'].forEach((id) => {
        $(id).value = today();
    });
    $('perfDate').value = today();
}

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
                    <div class="portal-home-actions">
                        <button class="btn btn-outline-danger" id="portalHomeLogoutBtn" type="button">ログアウト</button>
                        <button class="btn btn-outline-success" id="portalHomeReloadBtn" type="button">更新</button>
                    </div>
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

function setupMemberManagerTabs() {
    const memberPanel = $('memberPanel');
    const toolbar = memberPanel?.querySelector('.toolbar');
    if (!memberPanel || !toolbar) return;

    if (!$('memberUploadAdminBtn')) {
        toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-outline-primary" id="memberUploadAdminBtn" data-tab="upload" type="button" hidden>録音管理</button>');
    }
    if (!$('memberSheetAdminBtn')) {
        toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-outline-primary" id="memberSheetAdminBtn" data-tab="sheet-admin" type="button" hidden>楽譜管理</button>');
    }

    const uploadTab = $('uploadTab');
    if (uploadTab && uploadTab.parentElement !== memberPanel) {
        memberPanel.appendChild(uploadTab);
    }
    const sheetAdminTab = $('sheetAdminTab');
    if (sheetAdminTab && sheetAdminTab.parentElement !== memberPanel) {
        memberPanel.appendChild(sheetAdminTab);
    }
}

function updateManagerNavigationVisibility() {
    const uploadButton = $('memberUploadAdminBtn');
    if (uploadButton) uploadButton.hidden = !canManageRecordings();
    const sheetButton = $('memberSheetAdminBtn');
    if (sheetButton) sheetButton.hidden = !canManageSheets();
}

function portalMenuGroups() {
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
                { tab: 'member-recording', label: '録音部屋' }
            ]
        },
        {
            title: '演奏会情報',
            items: [
                { tab: 'member-performance', label: '演奏会情報' },
                { tab: 'member-piece-info', label: '楽曲紹介' },
                { tab: 'member-sheet', label: '楽譜ライブラリ' }
            ]
        },
        {
            title: '団員情報',
            items: [
                { tab: 'member-intro', label: '団員紹介' },
                { tab: 'member-casting', label: '乗り番表' },
                { tab: 'member-payment', label: '支払状況' },
                { tab: 'member-event', label: 'イベント調整' }
            ]
        },
        {
            title: `${orgShortName()}情報`,
            items: [
                { tab: 'member-sns', label: 'SNS' }
            ]
        },
        {
            title: '記録',
            items: [
                { tab: 'member-album', label: 'アルバム' },
                { tab: 'member-concert-record', label: '演奏会記録' }
            ]
        },
        {
            title: '設定',
            items: settingItems
        }
    ].filter((group) => group.items.length);
}

function renderMenuGroups(container) {
    if (!container) return;
    container.innerHTML = portalMenuGroups().map((group) => `
        <section class="portal-menu-group">
            <h3>${escapeHtml(group.title)}</h3>
            <div class="portal-menu-grid">
                ${group.items.map((item) => `
                    <button class="portal-menu-button${item.admin ? ' admin' : ''}" type="button" ${item.tab ? `data-home-tab="${escapeHtml(item.tab)}"` : ''} ${item.action ? `data-home-${escapeHtml(item.action)}` : ''}>
                        <span>${escapeHtml(item.label)}</span>
                    </button>
                `).join('')}
            </div>
        </section>
    `).join('');
    container.querySelectorAll('[data-home-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            closePortalDrawer();
            showMemberTab(button.dataset.homeTab);
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
}

function renderPortalDrawerMenu() {
    renderMenuGroups($('portalDrawerMenu'));
}

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

function downloadTextFile(filename, content, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

function displayNameWithoutExtension(name = '') {
    return String(name || '').replace(/\.[^.\\/]+$/, '');
}

function confirmDelete() {
    return confirm('本当に削除しますか？');
}

function portalDeviceId() {
    let deviceId = localStorage.getItem(PORTAL_DEVICE_ID_KEY);
    if (!deviceId) {
        deviceId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(PORTAL_DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
}

function portalDeviceName() {
    const platform = navigator.platform || 'unknown';
    const language = navigator.language || '';
    return `${platform}${language ? ` / ${language}` : ''}`;
}

function memberDisplayName(member) {
    const splitName = `${member?.last_name || ''}${member?.first_name || ''}`;
    return splitName || member?.name || '';
}

function currentUserMember() {
    return appState.members.find((member) => String(member.id || '') === String(appState.currentUserMemberId || '')) || null;
}

function currentUserMemberName() {
    const member = currentUserMember();
    return member ? memberDisplayName(member) : appState.currentUserName || '';
}

function canAccessAdmin() {
    return ['管理者', 'システム管理者'].includes(appState.currentUserPermission);
}

function canAccessSystemAdmin() {
    return appState.currentUserPermission === 'システム管理者';
}

function canManageRecordings() {
    return canAccessAdmin() || appState.currentUserIsRecordingManager;
}

function canManageSheets() {
    return canAccessAdmin() || appState.currentUserIsSheetManager;
}

async function isPortalAuthenticated() {
    if (appState.portalAuthVerified) return true;
    const deviceId = localStorage.getItem(PORTAL_DEVICE_ID_KEY);
    if (!deviceId || localStorage.getItem(PORTAL_AUTH_KEY) !== 'true') return false;
    try {
        const result = await request(`/api/auth/devices/${encodeURIComponent(deviceId)}`);
        appState.portalAuthVerified = Boolean(result.authenticated);
        appState.currentUserMemberId = result.device?.member_id ?? null;
        appState.currentUserName = result.device?.member_name || '';
        appState.currentUserPermission = result.device?.permission || '';
        appState.currentUserPart = result.device?.member_part || '';
        appState.currentUserIsRecordingManager = Boolean(result.device?.is_recording_manager);
        appState.currentUserIsSheetManager = Boolean(result.device?.is_sheet_manager);
        return appState.portalAuthVerified;
    } catch {
        return false;
    }
}

function showPortalLogin() {
    closePortalDrawer();
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = true;
    $('adminPanel').hidden = true;
    $('memberPanel').hidden = true;
    if ($('systemPanel')) $('systemPanel').hidden = true;
    let loginPanel = $('portalLoginPanel');
    if (!loginPanel) {
        const main = document.querySelector('main');
        main.insertAdjacentHTML('afterbegin', `
            <section id="portalLoginPanel" class="panel portal-login-panel">
                <div class="portal-login-box">
                    <div id="portalLoginForm">
                        <h1 id="portalLoginTitle">${escapeHtml(portalTitleText())}</h1>
                        <label class="form-label" for="portalNameInput">名前</label>
                        <input class="form-control" id="portalNameInput" type="text" autocomplete="name" placeholder="漢字またはふりがな">
                        <label class="form-label mt-3" for="portalPartInput">パート</label>
                        <select class="form-select" id="portalPartInput"></select>
                        <label class="form-label mt-3" for="portalPasswordInput">パスワード</label>
                        <input class="form-control" id="portalPasswordInput" type="password" autocomplete="current-password">
                        <button class="btn btn-primary w-100 mt-3" id="portalLoginBtn" type="button">ログイン</button>
                    </div>
                    <div id="portalPasswordSetupForm" hidden>
                        <h1>パスワード登録</h1>
                        <p class="text-muted small mb-3">団員情報に名前が見つかりました。個人用パスワードを登録してください。</p>
                        <input type="hidden" id="portalSetupName">
                        <input type="hidden" id="portalSetupPart">
                        <label class="form-label" for="portalNewPasswordInput">新しいパスワード</label>
                        <input class="form-control" id="portalNewPasswordInput" type="password" autocomplete="new-password">
                        <label class="form-label mt-3" for="portalNewPasswordConfirmInput">新しいパスワード（確認）</label>
                        <input class="form-control" id="portalNewPasswordConfirmInput" type="password" autocomplete="new-password">
                        <button class="btn btn-primary w-100 mt-3" id="portalPasswordSetupBtn" type="button">登録</button>
                        <button class="btn btn-outline-secondary w-100 mt-2" id="portalBackToLoginBtn" type="button">ログインに戻る</button>
                    </div>
                </div>
            </section>
        `);
        loginPanel = $('portalLoginPanel');
        refreshPartSelectOptions();
        applyOrgSettings();
        $('portalLoginBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '確認中...', handlePortalLogin));
        $('portalPasswordSetupBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', handleMemberPasswordSetup));
        $('portalBackToLoginBtn').addEventListener('click', showPortalLoginForm);
        ['portalNameInput', 'portalPasswordInput'].forEach((id) => $(id).addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                $('portalLoginBtn').click();
            }
        }));
        ['portalNewPasswordInput', 'portalNewPasswordConfirmInput'].forEach((id) => $(id).addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                $('portalPasswordSetupBtn').click();
            }
        }));
    }
    loginPanel.hidden = false;
    showPortalLoginForm();
}

async function handlePortalLogin() {
    const nameInput = $('portalNameInput');
    const partInput = $('portalPartInput');
    const passwordInput = $('portalPasswordInput');
    if (!nameInput || !partInput || !passwordInput) return;
    const name = nameInput.value.trim();
    const part = partInput.value;
    const isHiddenAdmin = name === 'Administrator';
    if (!name || !passwordInput.value || (!isHiddenAdmin && !part)) {
        showAlert('名前、パート、パスワードを入力してください', 'warning');
        return;
    }
    const response = await fetch('/api/auth/portal-login', jsonOptions('POST', {
        name,
        part,
        password: passwordInput.value,
        device_id: portalDeviceId(),
        device_name: portalDeviceName(),
        user_agent: navigator.userAgent || ''
    }));
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        showAlert(response.status === 404 ? '該当する団員が見つかりません' : '名前またはパスワードが違います', 'danger');
        passwordInput.value = '';
        return;
    }
    if (result.needs_password_setup) {
        showMemberPasswordSetup(name, part);
        return;
    }
    appState.currentUserPermission = result.permission || '';
    appState.currentUserMemberId = result.member_id ?? null;
    appState.currentUserName = result.member_name || '';
    appState.currentUserPart = result.member_part || part || '';
    appState.currentUserIsRecordingManager = Boolean(result.is_recording_manager);
    appState.currentUserIsSheetManager = Boolean(result.is_sheet_manager);
    localStorage.setItem(PORTAL_AUTH_KEY, 'true');
    appState.portalAuthVerified = true;
    await enterPortal();
}

function showPortalLoginForm() {
    if ($('portalLoginForm')) $('portalLoginForm').hidden = false;
    if ($('portalPasswordSetupForm')) $('portalPasswordSetupForm').hidden = true;
    if ($('portalPasswordInput')) $('portalPasswordInput').value = '';
    if ($('portalPartInput')) $('portalPartInput').value = '';
    $('portalNameInput')?.focus();
}

function showMemberPasswordSetup(name, part = '') {
    if ($('portalLoginForm')) $('portalLoginForm').hidden = true;
    if ($('portalPasswordSetupForm')) $('portalPasswordSetupForm').hidden = false;
    if ($('portalSetupName')) $('portalSetupName').value = name;
    if ($('portalSetupPart')) $('portalSetupPart').value = part;
    if ($('portalNewPasswordInput')) $('portalNewPasswordInput').value = '';
    if ($('portalNewPasswordConfirmInput')) $('portalNewPasswordConfirmInput').value = '';
    $('portalNewPasswordInput')?.focus();
}

async function handleMemberPasswordSetup() {
    const name = $('portalSetupName')?.value || $('portalNameInput')?.value.trim() || '';
    const part = $('portalSetupPart')?.value || $('portalPartInput')?.value || '';
    const password = $('portalNewPasswordInput')?.value || '';
    const confirmPassword = $('portalNewPasswordConfirmInput')?.value || '';
    if (!password) {
        showAlert('新しいパスワードを入力してください', 'warning');
        return;
    }
    if (password !== confirmPassword) {
        showAlert('確認用パスワードが一致しません', 'warning');
        return;
    }
    await request('/api/auth/member-password', jsonOptions('POST', { name, part, password }));
    showAlert('パスワードを登録しました。もう一度ログインしてください', 'success');
    showPortalLoginForm();
}

async function enterPortal() {
    if ($('portalLoginPanel')) $('portalLoginPanel').hidden = true;
    if (!appState.dataLoaded) {
        try {
            await loadAll();
            appState.dataLoaded = true;
        } catch (error) {
            showAlert(error.message || 'データの読み込みに失敗しました', 'danger');
        }
    }
    await showMemberPanel(true);
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
    if ($('portalHomeLogoutBtn')) $('portalHomeLogoutBtn').addEventListener('click', logoutPortal);
    if ($('portalHomeReloadBtn')) $('portalHomeReloadBtn').addEventListener('click', () => window.location.reload());
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
    if ($('portalLogoutBtn')) $('portalLogoutBtn').addEventListener('click', logoutPortal);
    if ($('portalReloadBtn')) $('portalReloadBtn').addEventListener('click', () => window.location.reload());

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

function bindUpload() {
    const fileInput = $('fileInput');

    $('selectFileBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => handleFiles(event.target.files));
    $('uploadDate').addEventListener('input', updateSavePath);
    $('uploadPiece').addEventListener('input', updateSavePath);
    $('uploadBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => uploadToLocalStore()));
    $('clearBtn').addEventListener('click', clearUploadForm);
}

function bindForms() {
    $('addPerfBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePerformance()));
    $('editPerfBtn').addEventListener('click', clearPerformanceForm);
    $('deletePerfBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePerformance()));
    $('addPieceBtn').addEventListener('click', addPerformancePiece);

    $('addSchedBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveSchedule()));
    $('editSchedBtn').addEventListener('click', clearScheduleForm);
    $('deleteSchedBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSchedule()));
    $('schedPerformance').addEventListener('change', updateSchedulePieceOptions);

    $('addAnnBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveAnnouncement()));
    $('editAnnBtn').addEventListener('click', clearAnnouncementForm);
    $('deleteAnnBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteAnnouncement()));

    $('addEventBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveEvent()));
    $('clearEventBtn').addEventListener('click', clearEventForm);
    $('deleteEventBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteEvent()));

    $('addMemberBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveMember()));
    $('clearMemberBtn').addEventListener('click', clearMemberForm);
    $('deleteMemberBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteMember()));

    if ($('paymentMemberId')) $('paymentMemberId').addEventListener('change', () => selectPaymentByMember($('paymentMemberId').value));
    if ($('savePaymentBtn')) $('savePaymentBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePaymentStatus()));
    if ($('clearPaymentBtn')) $('clearPaymentBtn').addEventListener('click', clearPaymentForm);

    if ($('savePartSettingBtn')) $('savePartSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePartSetting()));
    if ($('clearPartSettingBtn')) $('clearPartSettingBtn').addEventListener('click', clearPartSettingForm);
    if ($('saveVenueSettingBtn')) $('saveVenueSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveVenueSetting()));
    if ($('clearVenueSettingBtn')) $('clearVenueSettingBtn').addEventListener('click', clearVenueSettingForm);
    if ($('saveOrgSettingBtn')) $('saveOrgSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveOrgSetting()));
    if ($('clearOrgSettingBtn')) $('clearOrgSettingBtn').addEventListener('click', clearOrgSettingForm);
    if ($('orgIconFile')) $('orgIconFile').addEventListener('change', previewOrgIcon);
    if ($('saveSnsSettingBtn')) $('saveSnsSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveSnsSetting()));
    if ($('clearSnsSettingBtn')) $('clearSnsSettingBtn').addEventListener('click', clearSnsSettingForm);

    if ($('sheetPerformanceSelect')) $('sheetPerformanceSelect').addEventListener('change', updateSheetPieceOptions);
    if ($('uploadSheetBtn')) $('uploadSheetBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', () => uploadSheets()));
}

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

function showAdminPanel(role = 'admin') {
    if ($('portalDrawerToggle')) $('portalDrawerToggle').hidden = false;
    $('adminPanel').hidden = false;
    $('memberPanel').hidden = true;
    if ($('systemPanel')) $('systemPanel').hidden = true;
    localStorage.setItem('userRole', role);
    switchTab('adminPanel', 'performance');
}

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
    renderPartManagement();
    switchTab('systemPanel', 'system-auth');
}

async function showMemberPanel(shouldRender = true) {
    await showMemberTab('member-home', shouldRender);
}

async function showMemberTab(tabName, shouldRender = false) {
    if (!(await isPortalAuthenticated())) {
        showPortalLogin();
        return;
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

function switchTab(panelId, tabName, renderOnShow = true) {
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
    if (renderOnShow && tabName === 'member-home') renderPortalHome();
    if (renderOnShow && tabName === 'sheet-admin') renderSheetAdmin();
    if (renderOnShow && tabName === 'venue-admin') renderVenueManagement();
    if (renderOnShow && tabName === 'system-org') renderOrgManagement();
    if (renderOnShow && tabName === 'system-sns') renderSnsManagement();
}

function toPascalTab(value) {
    const map = {
        upload: 'upload',
        performance: 'performance',
        schedule: 'schedule',
        announcement: 'announcement',
        event: 'event',
        member: 'member',
        'payment-admin': 'paymentAdmin',
        'venue-admin': 'venueAdmin',
        'sheet-admin': 'sheetAdmin',
        'member-home': 'memberHome',
        'member-announce': 'memberAnnounce',
        'member-performance': 'memberPerformance',
        'member-schedule': 'memberSchedule',
        'member-recording': 'memberRecording',
        'member-intro': 'memberIntro',
        'member-absence': 'memberAbsence',
        'member-sheet': 'memberSheet',
        'member-sheet-viewer': 'memberSheetViewer',
        'member-payment': 'memberPayment',
        'member-casting': 'memberCasting',
        'member-event': 'memberEvent',
        'member-piece-info': 'memberPieceInfo',
        'member-album': 'memberAlbum',
        'member-concert-record': 'memberConcertRecord',
        'member-sns': 'memberSns',
        'system-auth': 'systemAuth',
        'system-org': 'systemOrg',
        'system-sns': 'systemSns',
        'system-part': 'systemPart'
    };
    return map[value] || value;
}

function updateSavePath() {
    if (!$('savePath')) return;
    const date = $('uploadDate').value || today();
    const piece = $('uploadPiece').value.trim() || '未分類';
    $('savePath').textContent = `/converted/${date}/${piece}/`;
}

function handleFiles(files) {
    const selected = Array.from(files || []);
    if (!selected.length) return;

    const validFiles = selected.filter((file) => {
        const extension = file.name.split('.').pop().toLowerCase();
        return ['wav', 'mp3'].includes(extension);
    });
    if (validFiles.length !== selected.length) {
        showAlert('WAV または MP3 ファイルを選択してください', 'warning');
    }
    if (!validFiles.length) return;

    appState.selectedFiles = validFiles;
    $('selectedFileName').textContent = selectedFileSummary(validFiles);
    showAlert(`${validFiles.length} 件のファイルを選択しました`, 'success');
}

async function uploadToLocalStore() {
    if (!appState.selectedFiles.length) {
        showAlert('先にファイルを選択してください', 'warning');
        return;
    }

    setOperationStatus('uploadProgress', `録音ファイルを保存しています。0 / ${appState.selectedFiles.length} 件`);
    let completed = 0;
    try {
        for (const file of appState.selectedFiles) {
            setOperationStatus('uploadProgress', `保存中: ${file.name}（${completed + 1} / ${appState.selectedFiles.length} 件）`);
            await request('/api/drive/upload', { method: 'POST', body: audioFormData(file) });
            completed += 1;
            setOperationStatus('uploadProgress', `保存完了: ${completed} / ${appState.selectedFiles.length} 件`);
        }
        showAlert(`${completed} 件の録音ファイルを保存しました`, 'info');
        await loadRecordings();
        setOperationStatus('uploadProgress', `保存が完了しました。${completed} 件の録音ファイルを一覧に反映しました。`);
    } catch (error) {
        setOperationStatus('uploadProgress', `保存に失敗しました。${completed} / ${appState.selectedFiles.length} 件まで完了しています。`, 'danger');
        throw error;
    }
}

function audioFormData(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('bitrate', $('bitrate').value);
    formData.append('date', document.getElementById('uploadDate').value);
    formData.append('piece', document.getElementById('uploadPiece').value);
    return formData;
}

function selectedFileSummary(files) {
    if (files.length === 1) {
        const file = files[0];
        return `${file.name} (${formatBytes(file.size)})`;
    }
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    return `${files.length} 件選択 (${formatBytes(totalSize)})`;
}

function clearUploadForm() {
    appState.selectedFiles = [];
    $('fileInput').value = '';
    $('selectedFileName').textContent = '未選択';
    $('uploadDate').value = today();
    $('uploadPiece').value = '';
    $('bitrate').value = '192';
    const progress = $('uploadProgress');
    if (progress) progress.hidden = true;
    updateSavePath();
}
async function loadAll() {
    let data;
    try {
        data = await requestJson('/api/bootstrap');
    } catch {
        data = await legacyBootstrapData();
    }
    applyBootstrapData(data);
    renderInitialViews();
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
}

async function legacyBootstrapData() {
    const [
        performances,
        schedules,
        announcements,
        events,
        members,
        recordings,
        absences,
        eventResponses,
        sheetLibrary,
        payments,
        castings,
        pieceInfos,
        albums,
        partSettings,
        venueSettings,
        orgSettings,
        snsSettings,
        sheets,
        authDevices
    ] = await Promise.all([
        request('/api/performances'),
        request('/api/schedules'),
        request('/api/announcements'),
        request('/api/events'),
        request('/api/members'),
        request('/api/recordings'),
        request('/api/extra/absences'),
        request('/api/extra/event_responses'),
        request('/api/extra/sheet_library'),
        request('/api/extra/payments'),
        request('/api/extra/castings'),
        request('/api/extra/piece_infos'),
        request('/api/extra/albums'),
        request('/api/extra/part_settings'),
        request('/api/extra/venue_settings'),
        request('/api/extra/org_settings'),
        request('/api/extra/sns_settings'),
        request('/api/sheets'),
        request('/api/auth/devices')
    ]);
    return {
        performances,
        schedules,
        announcements,
        events,
        members,
        recordings,
        extras: {
            absences,
            event_responses: eventResponses,
            sheet_library: sheetLibrary,
            payments,
            castings,
            piece_infos: pieceInfos,
            albums,
            part_settings: partSettings,
            venue_settings: venueSettings,
            org_settings: orgSettings,
            sns_settings: snsSettings
        },
        auth_devices: authDevices,
        sheets
    };
}

function applyBootstrapData(data) {
    const extras = data.extras || {};
    Object.assign(appState, {
        performances: data.performances || [],
        schedules: data.schedules || [],
        announcements: data.announcements || [],
        events: data.events || [],
        members: data.members || [],
        recordings: data.recordings?.files || [],
        absences: extras.absences || [],
        eventResponses: extras.event_responses || [],
        sheetLibrary: data.sheets?.files || extras.sheet_library || [],
        payments: extras.payments || [],
        castings: extras.castings || [],
        pieceInfos: extras.piece_infos || [],
        albums: extras.albums || [],
        partSettings: extras.part_settings || [],
        venueSettings: extras.venue_settings || [],
        orgSettings: extras.org_settings || [],
        snsSettings: extras.sns_settings || [],
        authDevices: data.auth_devices || []
    });
    refreshPartSelectOptions();
    refreshVenueOptions();
    applyOrgSettings();
    updateManagerNavigationVisibility();
}

async function loadPerformances() {
    appState.performances = await request('/api/performances');
    renderPerformances();
    renderSheetAdmin();
    renderPaymentAdmin();
}

async function loadSchedules() {
    appState.schedules = await request('/api/schedules');
    renderSchedules();
}

async function loadAnnouncements() {
    appState.announcements = await request('/api/announcements');
    renderAnnouncements();
}

async function loadEvents() {
    appState.events = await request('/api/events');
    renderEvents();
}

async function loadMembers() {
    appState.members = await request('/api/members');
    renderMembers();
    renderPaymentAdmin();
}

function renderInitialViews() {
    appState.suppressDerivedRender = true;
    renderPerformances();
    renderSchedules();
    renderAnnouncements();
    renderEvents();
    renderMembers();
    renderRecordings();
    renderSheetAdmin();
    renderPaymentAdmin();
    renderVenueManagement();
    renderOrgManagement();
    renderSnsManagement();
    appState.suppressDerivedRender = false;
    renderMemberPerformances();
    renderMemberSchedules();
    renderMemberIntros();
    renderMemberExtraViews();
    renderAuthDevices();
    renderPartManagement();
    renderSchedulePerformanceOptions();
    updateSchedulePieceOptions();
    renderPortalHome();
}

async function loadRecordings() {
    const data = await request('/api/recordings');
    appState.recordings = data.files || [];
    renderRecordings();
}

async function loadSheets() {
    const data = await request('/api/sheets');
    appState.sheetLibrary = data.files || [];
    renderSheetAdmin();
    renderSheetLibraryView();
}

async function loadAuthManagement() {
    const devices = await request('/api/auth/devices');
    appState.authDevices = devices || [];
    renderAuthDevices();
}

async function loadExtraData() {
    const [absences, eventResponses, sheets, payments, castings, pieceInfos, albums, partSettings, venueSettings, orgSettings, snsSettings] = await Promise.all([
        request('/api/extra/absences'),
        request('/api/extra/event_responses'),
        request('/api/sheets'),
        request('/api/extra/payments'),
        request('/api/extra/castings'),
        request('/api/extra/piece_infos'),
        request('/api/extra/albums'),
        request('/api/extra/part_settings'),
        request('/api/extra/venue_settings'),
        request('/api/extra/org_settings'),
        request('/api/extra/sns_settings')
    ]);
    Object.assign(appState, { absences, eventResponses, sheetLibrary: sheets.files || [], payments, castings, pieceInfos, albums, partSettings, venueSettings, orgSettings, snsSettings });
    refreshPartSelectOptions();
    refreshVenueOptions();
    applyOrgSettings();
    renderMemberExtraViews();
    renderSheetAdmin();
    renderPaymentAdmin();
    renderPartManagement();
    renderVenueManagement();
    renderOrgManagement();
    renderSnsManagement();
}

async function saveExtra(name, payload) {
    return request(`/api/extra/${name}`, jsonOptions('POST', payload));
}

async function savePerformance() {
    const payload = {
        title: $('perfTitle').value.trim(),
        date: $('perfDate').value,
        open_time: $('perfOpenTime').value,
        start_time: $('perfStartTime').value,
        venue: $('perfVenue').value.trim(),
        conductor: $('perfConductor').value.trim(),
        pieces: currentPerformancePieces()
    };
    if (!payload.title || !payload.date) {
        showAlert('タイトルと開催日を入力してください', 'warning');
        return;
    }

    const id = $('perfId').value;
    await request(id ? `/api/performances/${id}` : '/api/performances', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearPerformanceForm();
    await loadPerformances();
    showAlert('演奏会情報を保存しました', 'success');
}

function selectPerformance(id) {
    const item = appState.performances.find((perf) => perf.id === id);
    if (!item) return;
    $('perfId').value = item.id;
    $('perfTitle').value = item.title || '';
    $('perfDate').value = item.date || today();
    $('perfOpenTime').value = item.open_time || '18:00';
    $('perfStartTime').value = item.start_time || '19:00';
    $('perfVenue').value = item.venue || '';
    $('perfConductor').value = item.conductor || '';
    appState.performancePieces = normalizePerformancePieces(item.pieces || []);
    renderPerformancePieceList();
}

async function deletePerformance() {
    const id = $('perfId').value;
    if (!id) {
        showAlert('削除する演奏会を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/performances/${id}`, { method: 'DELETE' });
    clearPerformanceForm();
    await loadPerformances();
    showAlert('演奏会情報を削除しました', 'success');
}

function clearPerformanceForm() {
    $('perfId').value = '';
    $('perfTitle').value = '';
    $('perfDate').value = today();
    $('perfOpenTime').value = '18:00';
    $('perfStartTime').value = '19:00';
    $('perfVenue').value = '';
    $('perfConductor').value = '';
    $('perfPieceComposer').value = '';
    $('perfPieceTitle').value = '';
    if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
    appState.performancePieces = [];
    appState.performancePieceEditIndex = null;
    $('addPieceBtn').textContent = '曲を追加';
    renderPerformancePieceList();
}

function addPerformancePiece() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    const alias = $('perfPieceAlias') ? $('perfPieceAlias').value.trim() : '';
    if (!title) {
        showAlert('曲名を入力してください', 'warning');
        return;
    }

    const piece = { composer, title, alias };
    if (appState.performancePieceEditIndex !== null) {
        appState.performancePieces[appState.performancePieceEditIndex] = piece;
        appState.performancePieceEditIndex = null;
        $('addPieceBtn').textContent = '曲を追加';
    } else {
        appState.performancePieces.push(piece);
    }
    $('perfPieceComposer').value = '';
    $('perfPieceTitle').value = '';
    if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
    renderPerformancePieceList();
}

function editPerformancePiece(index) {
    const piece = appState.performancePieces[index];
    if (!piece) return;
    $('perfPieceComposer').value = piece.composer || '';
    $('perfPieceTitle').value = piece.title || '';
    if ($('perfPieceAlias')) $('perfPieceAlias').value = piece.alias || '';
    appState.performancePieceEditIndex = index;
    $('addPieceBtn').textContent = '曲を更新';
}

function removePerformancePiece(index) {
    if (!confirmDelete()) return;
    appState.performancePieces.splice(index, 1);
    if (appState.performancePieceEditIndex === index) {
        appState.performancePieceEditIndex = null;
        $('addPieceBtn').textContent = '曲を追加';
        $('perfPieceComposer').value = '';
        $('perfPieceTitle').value = '';
        if ($('perfPieceAlias')) $('perfPieceAlias').value = '';
    } else if (appState.performancePieceEditIndex !== null && appState.performancePieceEditIndex > index) {
        appState.performancePieceEditIndex -= 1;
    }
    renderPerformancePieceList();
}

function currentPerformancePieces() {
    const composer = $('perfPieceComposer').value.trim();
    const title = $('perfPieceTitle').value.trim();
    const alias = $('perfPieceAlias') ? $('perfPieceAlias').value.trim() : '';
    const pieces = [...appState.performancePieces];
    if (title) {
        pieces.push({ composer, title, alias });
    }
    return pieces;
}

function normalizePerformancePieces(pieces) {
    return (pieces || []).map((piece) => {
        if (typeof piece === 'string') {
            return { composer: '', title: piece };
        }
        return {
            composer: piece.composer || '',
            title: piece.title || piece.name || '',
            alias: piece.alias || piece.short_name || ''
        };
    }).filter((piece) => piece.title);
}

function performancePieceLabel(piece) {
    if (typeof piece === 'string') return piece;
    return piece.composer ? `${piece.composer}: ${piece.title}` : piece.title;
}

function renderPerformancePieceList() {
    const list = $('perfPieceList');
    list.innerHTML = emptyText(appState.performancePieces, '曲目はまだありません');
    appState.performancePieces.forEach((piece, index) => {
        const item = document.createElement('li');
        item.className = 'list-group-item d-flex justify-content-between align-items-center gap-3';
        item.innerHTML = `
            <span>${escapeHtml(performancePieceLabel(piece))}</span>
            <span class="d-flex gap-2">
                <button class="btn btn-sm btn-outline-primary edit-piece-btn" type="button">編集</button>
                <button class="btn btn-sm btn-outline-danger delete-piece-btn" type="button">削除</button>
            </span>
        `;
        item.querySelector('.edit-piece-btn').addEventListener('click', () => editPerformancePiece(index));
        item.querySelector('.delete-piece-btn').addEventListener('click', () => removePerformancePiece(index));
        list.appendChild(item);
    });
}

async function saveSchedule() {
    const startTime = $('schedStartTime').value;
    const endTime = $('schedEndTime').value;
    const availableStartTime = $('schedAvailableStartTime').value;
    const availableEndTime = $('schedAvailableEndTime').value;
    const selectedPerformance = selectedSchedulePerformance();
    const payload = {
        date: $('schedDate').value,
        time: formatTimeRange(startTime, endTime),
        start_time: startTime,
        end_time: endTime,
        venue: $('schedVenue').value.trim(),
        available_hours: formatTimeRange(availableStartTime, availableEndTime),
        available_start_time: availableStartTime,
        available_end_time: availableEndTime,
        performance_id: selectedPerformance ? selectedPerformance.id : null,
        performance_title: selectedPerformance ? selectedPerformance.title : '未定',
        pieces: $('schedPieces').value,
        is_conductor_training: $('schedConductorTraining') ? $('schedConductorTraining').checked : false,
        is_main_performance: $('schedMainPerformance') ? $('schedMainPerformance').checked : false,
        notes: $('schedNotes').value.trim()
    };
    if (!payload.date || !payload.start_time || !payload.end_time) {
        showAlert('練習日と開始時間を入力してください', 'warning');
        return;
    }

    const id = $('schedId').value;
    await request(id ? `/api/schedules/${id}` : '/api/schedules', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearScheduleForm();
    await loadSchedules();
    showAlert('練習予定を保存しました', 'success');
}

function selectSchedule(id) {
    const item = appState.schedules.find((sched) => sched.id === id);
    if (!item) return;
    $('schedId').value = item.id;
    $('schedDate').value = item.date || today();
    const practiceRange = splitTimeRange(item.time);
    const availableRange = splitTimeRange(item.available_hours);
    $('schedStartTime').value = item.start_time || practiceRange.start || '13:00';
    $('schedEndTime').value = item.end_time || practiceRange.end || '16:30';
    $('schedVenue').value = item.venue || '';
    $('schedAvailableStartTime').value = item.available_start_time || availableRange.start || '12:30';
    $('schedAvailableEndTime').value = item.available_end_time || availableRange.end || '16:30';
    $('schedPerformance').value = item.performance_id ? String(item.performance_id) : '';
    updateSchedulePieceOptions(item.pieces || '未定');
    if ($('schedConductorTraining')) $('schedConductorTraining').checked = Boolean(item.is_conductor_training);
    if ($('schedMainPerformance')) $('schedMainPerformance').checked = Boolean(item.is_main_performance);
    $('schedNotes').value = item.notes || '';
}

async function deleteSchedule() {
    const id = $('schedId').value;
    if (!id) {
        showAlert('削除する練習予定を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/schedules/${id}`, { method: 'DELETE' });
    clearScheduleForm();
    await loadSchedules();
    showAlert('練習予定を削除しました', 'success');
}

function clearScheduleForm() {
    $('schedId').value = '';
    $('schedDate').value = today();
    $('schedStartTime').value = '13:00';
    $('schedEndTime').value = '16:30';
    $('schedVenue').value = '';
    $('schedAvailableStartTime').value = '12:30';
    $('schedAvailableEndTime').value = '16:30';
    $('schedPerformance').value = '';
    updateSchedulePieceOptions('未定');
    if ($('schedConductorTraining')) $('schedConductorTraining').checked = false;
    if ($('schedMainPerformance')) $('schedMainPerformance').checked = false;
    $('schedNotes').value = '';
}

function selectedSchedulePerformance() {
    const value = $('schedPerformance').value;
    if (!value) return null;
    return appState.performances.find((perf) => String(perf.id) === value) || null;
}

function renderSchedulePerformanceOptions() {
    const select = $('schedPerformance');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">未定</option>' + appState.performances.map((perf) =>
        `<option value="${escapeHtml(perf.id)}">${escapeHtml(perf.title)}</option>`
    ).join('');
    if ([...select.options].some((option) => option.value === current)) {
        select.value = current;
    }
}

function updateSchedulePieceOptions(preferredValue = null) {
    const select = $('schedPieces');
    if (!select) return;
    const current = preferredValue ?? select.value ?? '未定';
    const performance = selectedSchedulePerformance();
    const performancePieces = performance ? normalizePerformancePieces(performance.pieces || []).map(performancePieceLabel) : [];
    const values = [...SCHEDULE_EXTRA_PIECES, ...performancePieces].filter((value, index, array) => value && array.indexOf(value) === index);
    select.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    select.value = values.includes(current) ? current : '未定';
}

function formatTimeRange(start, end) {
    return start && end ? `${start} - ${end}` : start || end || '';
}

function splitTimeRange(value) {
    const match = String(value || '').match(/(\d{1,2}:\d{2})\s*(?:-|〜|~|～)\s*(\d{1,2}:\d{2})/);
    return match ? { start: match[1], end: match[2] } : { start: '', end: '' };
}

function scheduleTimeLabel(sched) {
    return formatTimeRange(sched.start_time, sched.end_time) || sched.time || '';
}

function scheduleAvailableLabel(sched) {
    return formatTimeRange(sched.available_start_time, sched.available_end_time) || sched.available_hours || '';
}

function scheduleCalendarTitle(sched) {
    const pieces = sched.pieces ? ` / ${sched.pieces}` : '';
    return `奏オケ 練習${pieces}`;
}

function scheduleCalendarDetails(sched) {
    return [
        `演奏会: ${schedulePerformanceLabel(sched)}`,
        `練習曲: ${sched.pieces || '未定'}`,
        `練習可能時間: ${scheduleAvailableLabel(sched) || '未定'}`,
        `備考: ${sched.notes || 'なし'}`
    ].join('\n');
}

function addHoursToTime(time, hours) {
    const match = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return '';
    const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
    date.setHours(date.getHours() + hours);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function compactCalendarDate(date, time = '') {
    const ymd = String(date || '').replaceAll('-', '');
    if (!ymd) return '';
    if (!time) return ymd;
    return `${ymd}T${String(time).replace(':', '')}00`;
}

function nextAllDayDate(date) {
    if (!date) return '';
    const value = new Date(`${date}T00:00:00`);
    value.setDate(value.getDate() + 1);
    return value.toISOString().slice(0, 10);
}

function googleCalendarUrlForSchedule(sched) {
    const startTime = sched.start_time || splitTimeRange(sched.time).start;
    const endTime = sched.end_time || splitTimeRange(sched.time).end || addHoursToTime(startTime, 2);
    const dates = startTime
        ? `${compactCalendarDate(sched.date, startTime)}/${compactCalendarDate(sched.date, endTime || startTime)}`
        : `${compactCalendarDate(sched.date)}/${compactCalendarDate(nextAllDayDate(sched.date))}`;
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: scheduleCalendarTitle(sched),
        dates,
        ctz: 'Asia/Tokyo',
        location: sched.venue || '',
        details: scheduleCalendarDetails(sched)
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function openGoogleCalendarForSchedule(scheduleId) {
    const sched = appState.schedules.find((item) => String(item.id) === String(scheduleId));
    if (!sched) return;
    window.open(googleCalendarUrlForSchedule(sched), '_blank', 'noopener');
}

function icsEscape(value) {
    return String(value || '')
        .replaceAll('\\', '\\\\')
        .replaceAll('\n', '\\n')
        .replaceAll(',', '\\,')
        .replaceAll(';', '\\;');
}

function icsDateTime(date, time = '') {
    const compact = compactCalendarDate(date, time);
    return time ? compact : compact;
}

function scheduleToIcsEvent(sched) {
    const startTime = sched.start_time || splitTimeRange(sched.time).start;
    const endTime = sched.end_time || splitTimeRange(sched.time).end || addHoursToTime(startTime, 2);
    const allDay = !startTime;
    const startKey = allDay ? 'DTSTART;VALUE=DATE' : 'DTSTART;TZID=Asia/Tokyo';
    const endKey = allDay ? 'DTEND;VALUE=DATE' : 'DTEND;TZID=Asia/Tokyo';
    const startValue = allDay ? icsDateTime(sched.date) : icsDateTime(sched.date, startTime);
    const endValue = allDay ? icsDateTime(nextAllDayDate(sched.date)) : icsDateTime(sched.date, endTime || startTime);
    return [
        'BEGIN:VEVENT',
        `UID:kanade-schedule-${sched.id || `${sched.date}-${sched.venue}`}@kanade-portal`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`,
        `${startKey}:${startValue}`,
        `${endKey}:${endValue}`,
        `SUMMARY:${icsEscape(scheduleCalendarTitle(sched))}`,
        `LOCATION:${icsEscape(sched.venue || '')}`,
        `DESCRIPTION:${icsEscape(scheduleCalendarDetails(sched))}`,
        'END:VEVENT'
    ].join('\r\n');
}

function downloadSchedulesIcs(schedules) {
    const targets = sortedSchedules(schedules).filter((sched) => sched.date);
    if (!targets.length) {
        showAlert('連携できる練習予定がありません', 'warning');
        return;
    }
    const content = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Kanade Orchestra Portal//Schedule//JA',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-TIMEZONE:Asia/Tokyo',
        ...targets.map(scheduleToIcsEvent),
        'END:VCALENDAR'
    ].join('\r\n');
    downloadTextFile('奏オケ練習予定.ics', content, 'text/calendar;charset=utf-8');
    showAlert('練習予定の一括連携ファイルを作成しました。Googleカレンダーのインポートで読み込めます', 'success');
}

async function saveAnnouncement() {
    const payload = {
        date: $('annDate').value || today(),
        content: $('annContent').value.trim()
    };
    if (!payload.content) {
        showAlert('お知らせ内容を入力してください', 'warning');
        return;
    }

    const id = $('annId').value;
    await request(id ? `/api/announcements/${id}` : '/api/announcements', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearAnnouncementForm();
    await loadAnnouncements();
    showAlert('お知らせを保存しました', 'success');
}

function selectAnnouncement(id) {
    const item = appState.announcements.find((ann) => ann.id === id);
    if (!item) return;
    $('annId').value = item.id;
    $('annDate').value = item.date || today();
    $('annContent').value = item.content || '';
}

async function deleteAnnouncement() {
    const id = $('annId').value;
    if (!id) {
        showAlert('削除するお知らせを一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/announcements/${id}`, { method: 'DELETE' });
    clearAnnouncementForm();
    await loadAnnouncements();
    showAlert('お知らせを削除しました', 'success');
}

function clearAnnouncementForm() {
    $('annId').value = '';
    $('annDate').value = today();
    $('annContent').value = '';
}


async function saveEvent() {
    const payload = {
        title: $('eventTitle').value.trim(),
        date: $('eventDate').value,
        start_time: $('eventStartTime') ? $('eventStartTime').value : '',
        deadline: $('eventDeadline').value,
        url: $('eventUrl').value.trim(),
        notes: $('eventNotes').value.trim(),
        delete_phrase: $('eventDeletePhrase') ? $('eventDeletePhrase').value.trim() : ''
    };
    if (!payload.title) {
        showAlert('イベント名を入力してください', 'warning');
        return;
    }

    const id = $('eventId').value;
    await request(id ? `/api/events/${id}` : '/api/events', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearEventForm();
    await loadEvents();
    showAlert('イベント調整を保存しました', 'success');
}

function selectEvent(id) {
    const item = appState.events.find((event) => event.id === id);
    if (!item) return;
    $('eventId').value = item.id;
    $('eventTitle').value = item.title || '';
    $('eventDate').value = item.date || '';
    if ($('eventStartTime')) $('eventStartTime').value = item.start_time || '';
    $('eventDeadline').value = item.deadline || '';
    $('eventUrl').value = item.url || '';
    $('eventNotes').value = item.notes || '';
    if ($('eventDeletePhrase')) $('eventDeletePhrase').value = item.delete_phrase || '';
}

async function deleteEvent() {
    const id = $('eventId').value;
    if (!id) {
        showAlert('削除するイベントを一覧から選択してください', 'warning');
        return;
    }
    await deleteEventById(id, true);
}

async function deleteEventById(id, adminDelete = false) {
    if (adminDelete && !confirmDelete()) return;
    await request(`/api/events/${id}`, { method: 'DELETE' });
    clearEventForm();
    await loadEvents();
    await loadExtraData();
    showAlert('イベント調整を削除しました', 'success');
}

function clearEventForm() {
    $('eventId').value = '';
    $('eventTitle').value = '';
    $('eventDate').value = '';
    if ($('eventStartTime')) $('eventStartTime').value = '';
    $('eventDeadline').value = '';
    $('eventUrl').value = '';
    $('eventNotes').value = '';
    if ($('eventDeletePhrase')) $('eventDeletePhrase').value = '';
}

function sortedEvents(events) {
    return [...(events || [])].sort((a, b) =>
        String(a.date || '').localeCompare(String(b.date || '')) ||
        String(a.start_time || '').localeCompare(String(b.start_time || '')) ||
        String(a.title || '').localeCompare(String(b.title || ''))
    );
}

function eventDateTimeLabel(event) {
    const date = formatDateWithWeekday(event?.date, '未定');
    return event?.start_time ? `${date} ${event.start_time}` : date;
}

async function saveMember() {
    const current = appState.members.find((member) => String(member.id) === String($('memberId').value));
    const photoFile = $('memberPhotoFile')?.files?.[0];
    const photoUrl = photoFile ? await fileToDataUrl(photoFile) : (current?.photo_url || '');
    const password = $('memberPassword') ? $('memberPassword').value : '';
    const lastName = $('memberLastName') ? $('memberLastName').value.trim() : '';
    const firstName = $('memberFirstName') ? $('memberFirstName').value.trim() : '';
    const payload = {
        name: `${lastName}${firstName}`,
        last_name: lastName,
        first_name: firstName,
        maiden_name: $('memberMaidenName') ? $('memberMaidenName').value.trim() : '',
        last_name_kana: $('memberLastNameKana') ? $('memberLastNameKana').value.trim() : '',
        first_name_kana: $('memberFirstNameKana') ? $('memberFirstNameKana').value.trim() : '',
        maiden_name_kana: $('memberMaidenNameKana') ? $('memberMaidenNameKana').value.trim() : '',
        part: $('memberPart').value,
        photo_url: photoUrl,
        is_founder: $('memberIsFounder') ? $('memberIsFounder').checked : false,
        is_recording_manager: $('memberIsRecordingManager') ? $('memberIsRecordingManager').checked : false,
        is_sheet_manager: $('memberIsSheetManager') ? $('memberIsSheetManager').checked : false,
        password: password || current?.password || '',
        permission: $('memberPermission') ? $('memberPermission').value : '一般',
        joined_at: $('memberJoinedAt') ? $('memberJoinedAt').value : '',
        introducer: $('memberIntroducer') ? $('memberIntroducer').value.trim() : '',
        role: $('memberRole') ? $('memberRole').value.trim() : '',
        instrument_history: $('memberInstrumentHistory') ? $('memberInstrumentHistory').value.trim() : '',
        past_orchestras: $('memberPastOrchestras') ? $('memberPastOrchestras').value.trim() : '',
        comment: $('memberComment').value.trim()
    };
    if (!payload.last_name || !payload.first_name) {
        showAlert('姓と名を入力してください', 'warning');
        return;
    }
    if (!payload.part) {
        showAlert('パートを選択してください', 'warning');
        return;
    }
    const id = $('memberId').value;
    await request(id ? `/api/members/${id}` : '/api/members', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearMemberForm();
    await loadMembers();
    showAlert('団員情報を保存しました', 'success');
}

function selectMember(id) {
    const item = appState.members.find((member) => member.id === id);
    if (!item) return;
    $('memberId').value = item.id;
    const fallbackName = item.name && !item.last_name && !item.first_name ? item.name : '';
    if ($('memberLastName')) $('memberLastName').value = item.last_name || fallbackName;
    if ($('memberFirstName')) $('memberFirstName').value = item.first_name || '';
    if ($('memberMaidenName')) $('memberMaidenName').value = item.maiden_name || '';
    if ($('memberLastNameKana')) $('memberLastNameKana').value = item.last_name_kana || '';
    if ($('memberFirstNameKana')) $('memberFirstNameKana').value = item.first_name_kana || '';
    if ($('memberMaidenNameKana')) $('memberMaidenNameKana').value = item.maiden_name_kana || '';
    $('memberPart').value = item.part || '';
    if ($('memberPhotoFile')) $('memberPhotoFile').value = '';
    if ($('memberIsFounder')) $('memberIsFounder').checked = Boolean(item.is_founder);
    if ($('memberIsRecordingManager')) $('memberIsRecordingManager').checked = Boolean(item.is_recording_manager);
    if ($('memberIsSheetManager')) $('memberIsSheetManager').checked = Boolean(item.is_sheet_manager);
    if ($('memberPassword')) $('memberPassword').value = item.password || '';
    if ($('memberPermission')) $('memberPermission').value = item.permission || '一般';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = item.joined_at || '';
    if ($('memberIntroducer')) $('memberIntroducer').value = item.introducer || '';
    if ($('memberRole')) $('memberRole').value = item.role || '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = item.instrument_history || '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = item.past_orchestras || '';
    $('memberComment').value = item.comment || '';
}

async function deleteMember() {
    const id = $('memberId').value;
    if (!id) {
        showAlert('削除する団員を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/members/${id}`, { method: 'DELETE' });
    clearMemberForm();
    await loadMembers();
    showAlert('団員情報を削除しました', 'success');
}

function clearMemberForm() {
    $('memberId').value = '';
    if ($('memberLastName')) $('memberLastName').value = '';
    if ($('memberFirstName')) $('memberFirstName').value = '';
    if ($('memberMaidenName')) $('memberMaidenName').value = '';
    if ($('memberLastNameKana')) $('memberLastNameKana').value = '';
    if ($('memberFirstNameKana')) $('memberFirstNameKana').value = '';
    if ($('memberMaidenNameKana')) $('memberMaidenNameKana').value = '';
    $('memberPart').value = '';
    if ($('memberPhotoFile')) $('memberPhotoFile').value = '';
    if ($('memberIsFounder')) $('memberIsFounder').checked = false;
    if ($('memberIsRecordingManager')) $('memberIsRecordingManager').checked = false;
    if ($('memberIsSheetManager')) $('memberIsSheetManager').checked = false;
    if ($('memberPassword')) $('memberPassword').value = '';
    if ($('memberPermission')) $('memberPermission').value = '一般';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = '';
    if ($('memberIntroducer')) $('memberIntroducer').value = '';
    if ($('memberRole')) $('memberRole').value = '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = '';
    $('memberComment').value = '';
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(String(reader.result || '')));
        reader.addEventListener('error', () => reject(reader.error || new Error('画像を読み込めませんでした')));
        reader.readAsDataURL(file);
    });
}

function memberKanaName(member) {
    return `${member?.last_name_kana || ''}${member?.first_name_kana || ''}`;
}

function sortedMembersByPartAndKana(members) {
    return [...(members || [])].sort((a, b) =>
        partSortIndex(a.part) - partSortIndex(b.part) ||
        String(a.part || '').localeCompare(String(b.part || ''), 'ja') ||
        String(memberKanaName(a) || memberDisplayName(a)).localeCompare(String(memberKanaName(b) || memberDisplayName(b)), 'ja') ||
        String(memberDisplayName(a)).localeCompare(String(memberDisplayName(b)), 'ja')
    );
}

function partSortIndex(partName) {
    const index = currentPartNames().indexOf(String(partName || ''));
    return index === -1 ? 9999 : index;
}

function renderMembers() {
    const list = $('memberListItems');
    if (list) {
        list.innerHTML = emptyText(appState.members, '団員情報はまだありません');
        sortedMembersByPartAndKana(appState.members).forEach((member) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'list-group-item list-group-item-action';
            item.innerHTML = `
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                    <strong>${escapeHtml(memberDisplayName(member))}</strong>
                    <span class="d-flex flex-wrap gap-2">
                        <span class="badge text-bg-secondary">${escapeHtml(member.permission || '一般')}</span>
                        <span class="badge ${member.password ? 'text-bg-success' : 'text-bg-warning'}">パスワード: ${escapeHtml(member.password || '未登録')}</span>
                    </span>
                </div>
            `;
            item.addEventListener('click', () => selectMember(member.id));
            list.appendChild(item);
        });
    }
    if (!appState.suppressDerivedRender) {
        renderMemberIntros();
        renderMemberExtraViews();
    }
}

function renderAuthDevices() {
    const container = $('authDeviceListItems');
    if (!container) return;
    if (!appState.authDevices.length) {
        container.innerHTML = '<p class="text-muted mb-0">認証済み端末はまだありません</p>';
        return;
    }
    container.innerHTML = `<div class="list-group">${appState.authDevices.map((device) => `
        <div class="list-group-item">
            <div class="d-flex flex-wrap justify-content-between gap-2">
                <span>
                    <strong>${escapeHtml(device.device_name || 'Unknown device')}</strong>
                    <div class="small text-muted">ログイン者: ${escapeHtml(device.member_name || 'Unknown')} / ${escapeHtml(device.member_part || 'パート未設定')}</div>
                    <div class="small text-muted">権限: ${escapeHtml(device.permission || '')}</div>
                    <div class="small text-muted">端末ID: ${escapeHtml(device.device_id || '')}</div>
                    <div class="small text-muted">認証日時: ${escapeHtml(formatDateTimeLabel(device.authenticated_at))}</div>
                    <div class="small text-muted">最終確認: ${escapeHtml(formatDateTimeLabel(device.last_seen_at))}</div>
                    ${device.user_agent ? `<div class="small text-muted text-break">${escapeHtml(device.user_agent)}</div>` : ''}
                </span>
                <span><button class="btn btn-sm btn-outline-danger auth-device-delete-btn" type="button" data-device-id="${escapeHtml(device.device_id || '')}">削除</button></span>
            </div>
        </div>
    `).join('')}</div>`;
    container.querySelectorAll('.auth-device-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteAuthDevice(button.dataset.deviceId)));
    });
}

async function deleteAuthDevice(deviceId) {
    if (!deviceId) return;
    if (!confirmDelete()) return;
    await request(`/api/auth/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    if (deviceId === localStorage.getItem(PORTAL_DEVICE_ID_KEY)) {
        localStorage.removeItem(PORTAL_AUTH_KEY);
        appState.portalAuthVerified = false;
    }
    await loadAuthManagement();
    showAlert('認証端末を削除しました', 'success');
}

function sortedPartSettings() {
    return [...(appState.partSettings || [])].sort((a, b) =>
        Number(a.display_order || 9999) - Number(b.display_order || 9999) ||
        String(a.name || '').localeCompare(String(b.name || ''), 'ja')
    );
}

function currentPartNames() {
    const configured = sortedPartSettings()
        .map((part) => String(part.name || '').trim())
        .filter(Boolean);
    return configured.length ? configured : DEFAULT_MEMBER_PARTS;
}

function partSelectOptionsHtml(selected = '') {
    return ['<option value="">選択してください</option>']
        .concat(currentPartNames().map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`))
        .join('');
}

function refreshPartSelectOptions() {
    const portalPart = $('portalPartInput');
    if (portalPart) {
        const selected = portalPart.value;
        portalPart.innerHTML = partSelectOptionsHtml(selected);
        if ([...portalPart.options].some((option) => option.value === selected)) portalPart.value = selected;
    }
    const memberPart = $('memberPart');
    if (memberPart) {
        const selected = memberPart.value;
        memberPart.innerHTML = partSelectOptionsHtml(selected);
        if ([...memberPart.options].some((option) => option.value === selected)) memberPart.value = selected;
    }
}

function partMigrationNames() {
    return [...DEFAULT_MEMBER_PARTS, ...appState.members.map((member) => String(member.part || '').trim())]
        .filter((part, index, array) => part && array.indexOf(part) === index);
}

async function ensurePartSettingsMigrated() {
    if ((appState.partSettings || []).length) return;
    const names = partMigrationNames();
    if (!names.length) return;
    for (const [index, name] of names.entries()) {
        await saveExtra('part_settings', { name, display_order: index + 1 });
    }
    await loadExtraData();
}

function renderPartManagement() {
    const list = $('partSettingList');
    if (!list) return;
    const parts = sortedPartSettings();
    list.innerHTML = parts.length
        ? `<div class="list-group">${parts.map((part) => `
            <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                <div>
                    <strong>${escapeHtml(part.name || '')}</strong>
                    <div class="small text-muted">表示位置: ${parts.indexOf(part) + 1}</div>
                </div>
                <div class="d-flex flex-wrap gap-2">
                    <button class="btn btn-sm btn-outline-secondary part-setting-up-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}" ${parts.indexOf(part) === 0 ? 'disabled' : ''}>上へ</button>
                    <button class="btn btn-sm btn-outline-secondary part-setting-down-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}" ${parts.indexOf(part) === parts.length - 1 ? 'disabled' : ''}>下へ</button>
                    <button class="btn btn-sm btn-outline-primary part-setting-edit-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}">編集</button>
                    <button class="btn btn-sm btn-outline-danger part-setting-delete-btn" type="button" data-part-id="${escapeHtml(String(part.id || ''))}">削除</button>
                </div>
            </div>
        `).join('')}</div>`
        : '<div class="alert alert-info mb-0">パート設定を移行中です。表示されない場合は再度システム管理を開いてください。</div>';

    list.querySelectorAll('.part-setting-up-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '移動中...', () => movePartSetting(button.dataset.partId || '', -1)));
    });
    list.querySelectorAll('.part-setting-down-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '移動中...', () => movePartSetting(button.dataset.partId || '', 1)));
    });
    list.querySelectorAll('.part-setting-edit-btn').forEach((button) => {
        button.addEventListener('click', () => selectPartSetting(button.dataset.partId || ''));
    });
    list.querySelectorAll('.part-setting-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePartSetting(button.dataset.partId || '')));
    });
}

function selectPartSetting(partId) {
    const part = appState.partSettings.find((item) => String(item.id || '') === String(partId));
    if (!part) return;
    $('partSettingId').value = part.id || '';
    $('partSettingName').value = part.name || '';
}

function clearPartSettingForm() {
    if ($('partSettingId')) $('partSettingId').value = '';
    if ($('partSettingName')) $('partSettingName').value = '';
}

function nextPartDisplayOrder() {
    const maxOrder = Math.max(0, ...appState.partSettings.map((part) => Number(part.display_order || 0)));
    return maxOrder + 1;
}

async function movePartSetting(partId, direction) {
    const parts = sortedPartSettings();
    const index = parts.findIndex((part) => String(part.id || '') === String(partId));
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= parts.length) return;
    const current = parts[index];
    const target = parts[nextIndex];
    await Promise.all([
        request(`/api/extra/part_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', {
            ...current,
            display_order: target.display_order || nextIndex + 1
        })),
        request(`/api/extra/part_settings/${encodeURIComponent(target.id)}`, jsonOptions('PUT', {
            ...target,
            display_order: current.display_order || index + 1
        }))
    ]);
    await loadExtraData();
}

async function savePartSetting() {
    const name = $('partSettingName')?.value.trim() || '';
    if (!name) {
        showAlert('パート名を入力してください', 'warning');
        return;
    }
    const duplicate = appState.partSettings.find((part) =>
        String(part.name || '').trim() === name &&
        String(part.id || '') !== String($('partSettingId')?.value || '')
    );
    if (duplicate) {
        showAlert('同じパート名が既に登録されています', 'warning');
        return;
    }
    const id = $('partSettingId')?.value || '';
    const current = appState.partSettings.find((part) => String(part.id || '') === String(id));
    const payload = { name, display_order: current?.display_order || nextPartDisplayOrder() };
    if (id) {
        await request(`/api/extra/part_settings/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('part_settings', payload);
    }
    clearPartSettingForm();
    await loadExtraData();
    showAlert('パートを保存しました', 'success');
}

async function deletePartSetting(partId) {
    if (!partId || !confirmDelete()) return;
    await request(`/api/extra/part_settings/${encodeURIComponent(partId)}`, { method: 'DELETE' });
    clearPartSettingForm();
    await loadExtraData();
    showAlert('パートを削除しました', 'success');
}

function sortedVenueSettings() {
    return [...(appState.venueSettings || [])].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'ja')
    );
}

function venueSettingsFor(kind) {
    return sortedVenueSettings().filter((venue) => {
        if (kind === 'performance') return venue.for_performance !== false;
        if (kind === 'practice') return venue.for_practice !== false;
        return true;
    });
}

function refreshVenueOptions() {
    const performanceList = $('performanceVenueOptions');
    if (performanceList) {
        performanceList.innerHTML = venueSettingsFor('performance')
            .map((venue) => `<option value="${escapeHtml(venue.name || '')}"></option>`)
            .join('');
    }
    const practiceList = $('practiceVenueOptions');
    if (practiceList) {
        practiceList.innerHTML = venueSettingsFor('practice')
            .map((venue) => `<option value="${escapeHtml(venue.name || '')}"></option>`)
            .join('');
    }
}

function renderVenueManagement() {
    const list = $('venueSettingList');
    if (!list) return;
    const venues = sortedVenueSettings();
    list.innerHTML = venues.length
        ? `<div class="list-group">${venues.map((venue) => {
            const uses = [
                venue.for_practice !== false ? '練習' : '',
                venue.for_performance !== false ? '本番' : ''
            ].filter(Boolean).join(' / ') || '未設定';
            return `
                <button class="list-group-item list-group-item-action text-start venue-setting-item" type="button" data-venue-id="${escapeHtml(String(venue.id || ''))}">
                    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                        <span>
                            <strong>${escapeHtml(venue.name || '')}</strong>
                            <span class="badge text-bg-secondary ms-2">${escapeHtml(uses)}</span>
                            ${venue.note ? `<div class="small text-muted mt-1">${escapeHtml(venue.note)}</div>` : ''}
                        </span>
                        <span class="d-flex gap-2">
                            <button class="btn btn-sm btn-outline-danger venue-setting-delete-btn" type="button" data-venue-id="${escapeHtml(String(venue.id || ''))}">削除</button>
                        </span>
                    </div>
                </button>
            `;
        }).join('')}</div>`
        : '<p class="text-muted mb-0">会場はまだ登録されていません</p>';

    list.querySelectorAll('.venue-setting-item').forEach((button) => {
        button.addEventListener('click', () => selectVenueSetting(button.dataset.venueId || ''));
    });
    list.querySelectorAll('.venue-setting-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            withButtonStatus(event.currentTarget, '削除中...', () => deleteVenueSetting(button.dataset.venueId || ''));
        });
    });
}

function selectVenueSetting(venueId) {
    const venue = appState.venueSettings.find((item) => String(item.id || '') === String(venueId));
    if (!venue) return;
    $('venueSettingId').value = venue.id || '';
    $('venueSettingName').value = venue.name || '';
    $('venueForPractice').checked = venue.for_practice !== false;
    $('venueForPerformance').checked = venue.for_performance !== false;
    $('venueSettingNote').value = venue.note || '';
}

function clearVenueSettingForm() {
    if ($('venueSettingId')) $('venueSettingId').value = '';
    if ($('venueSettingName')) $('venueSettingName').value = '';
    if ($('venueForPractice')) $('venueForPractice').checked = true;
    if ($('venueForPerformance')) $('venueForPerformance').checked = false;
    if ($('venueSettingNote')) $('venueSettingNote').value = '';
}

async function saveVenueSetting() {
    const name = $('venueSettingName')?.value.trim() || '';
    if (!name) {
        showAlert('会場名を入力してください', 'warning');
        return;
    }
    const forPractice = $('venueForPractice')?.checked ?? false;
    const forPerformance = $('venueForPerformance')?.checked ?? false;
    if (!forPractice && !forPerformance) {
        showAlert('用途を1つ以上選択してください', 'warning');
        return;
    }
    const id = $('venueSettingId')?.value || '';
    const duplicate = appState.venueSettings.find((venue) =>
        String(venue.name || '').trim() === name &&
        String(venue.id || '') !== String(id)
    );
    if (duplicate) {
        showAlert('同じ会場名が既に登録されています', 'warning');
        return;
    }
    const payload = {
        name,
        for_practice: forPractice,
        for_performance: forPerformance,
        note: $('venueSettingNote')?.value.trim() || ''
    };
    if (id) {
        await request(`/api/extra/venue_settings/${encodeURIComponent(id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('venue_settings', payload);
    }
    clearVenueSettingForm();
    await loadExtraData();
    showAlert('会場を保存しました', 'success');
}

async function deleteVenueSetting(venueId) {
    if (!venueId || !confirmDelete()) return;
    await request(`/api/extra/venue_settings/${encodeURIComponent(venueId)}`, { method: 'DELETE' });
    clearVenueSettingForm();
    await loadExtraData();
    showAlert('会場を削除しました', 'success');
}

function currentOrgSetting() {
    return (appState.orgSettings || [])[0] || {};
}

function orgShortName() {
    return String(currentOrgSetting().short_name || currentOrgSetting().shortName || '楽団').trim() || '楽団';
}

function portalTitleText() {
    return `${orgShortName()}ポータル`;
}

function applyOrgSettings() {
    const org = currentOrgSetting();
    const title = portalTitleText();
    document.title = title;
    const titleElement = document.querySelector('title');
    if (titleElement) titleElement.textContent = title;
    if ($('portalBrandTitle')) $('portalBrandTitle').textContent = title;
    if ($('portalLoginTitle')) $('portalLoginTitle').textContent = title;
    const iconUrl = org.icon_url || org.iconUrl || '';
    if (iconUrl) {
        document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((link) => {
            link.href = iconUrl;
        });
        if ($('portalLogo')) $('portalLogo').src = iconUrl;
        if ($('orgIconPreview')) $('orgIconPreview').src = iconUrl;
    }
    const logo = $('portalLogo');
    if (logo) logo.alt = orgShortName();
    applyDynamicManifest(title, orgShortName(), org.icon_url || org.iconUrl || '');
}

function applyDynamicManifest(name, shortName, iconUrl = '') {
    const manifestLink = document.querySelector('link[rel="manifest"]');
    if (!manifestLink) return;
    const icons = [
        { src: iconUrl || '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: iconUrl || '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ];
    const manifest = {
        name,
        short_name: shortName,
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#235789',
        icons
    };
    if (appState.manifestObjectUrl) {
        URL.revokeObjectURL(appState.manifestObjectUrl);
    }
    appState.manifestObjectUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
    manifestLink.href = appState.manifestObjectUrl;
}

function renderOrgManagement() {
    const org = currentOrgSetting();
    if ($('orgSettingId')) $('orgSettingId').value = org.id || '';
    if ($('orgName')) $('orgName').value = org.name || '';
    if ($('orgShortName')) $('orgShortName').value = org.short_name || org.shortName || '';
    if ($('orgIconFile')) $('orgIconFile').value = '';
    if ($('orgIconPreview')) $('orgIconPreview').src = org.icon_url || org.iconUrl || '/static/icons/icon-192.png';
}

async function previewOrgIcon() {
    const file = $('orgIconFile')?.files?.[0];
    if (!file || !$('orgIconPreview')) return;
    $('orgIconPreview').src = await fileToDataUrl(file);
}

function clearOrgSettingForm() {
    if ($('orgSettingId')) $('orgSettingId').value = currentOrgSetting().id || '';
    if ($('orgName')) $('orgName').value = '';
    if ($('orgShortName')) $('orgShortName').value = '';
    if ($('orgIconFile')) $('orgIconFile').value = '';
    if ($('orgIconPreview')) $('orgIconPreview').src = currentOrgSetting().icon_url || '/static/icons/icon-192.png';
}

async function saveOrgSetting() {
    const current = currentOrgSetting();
    const name = $('orgName')?.value.trim() || '';
    const shortName = $('orgShortName')?.value.trim() || '';
    if (!name || !shortName) {
        showAlert('団体名と略称を入力してください', 'warning');
        return;
    }
    const iconFile = $('orgIconFile')?.files?.[0];
    const iconUrl = iconFile ? await fileToDataUrl(iconFile) : (current.icon_url || current.iconUrl || '');
    const payload = {
        name,
        short_name: shortName,
        icon_url: iconUrl
    };
    if (current.id) {
        await request(`/api/extra/org_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('org_settings', payload);
    }
    await loadExtraData();
    showAlert('団体情報を保存しました', 'success');
}

function currentSnsSetting() {
    return (appState.snsSettings || [])[0] || {};
}

function renderSnsManagement() {
    const sns = currentSnsSetting();
    if ($('snsSettingId')) $('snsSettingId').value = sns.id || '';
    if ($('snsFacebookUrl')) $('snsFacebookUrl').value = sns.facebook_url || '';
    if ($('snsInstagramUrl')) $('snsInstagramUrl').value = sns.instagram_url || '';
    if ($('snsXUrl')) $('snsXUrl').value = sns.x_url || '';
    if ($('snsYoutubeUrl')) $('snsYoutubeUrl').value = sns.youtube_url || '';
}

function clearSnsSettingForm() {
    if ($('snsFacebookUrl')) $('snsFacebookUrl').value = '';
    if ($('snsInstagramUrl')) $('snsInstagramUrl').value = '';
    if ($('snsXUrl')) $('snsXUrl').value = '';
    if ($('snsYoutubeUrl')) $('snsYoutubeUrl').value = '';
}

async function saveSnsSetting() {
    const current = currentSnsSetting();
    const payload = {
        facebook_url: $('snsFacebookUrl')?.value.trim() || '',
        instagram_url: $('snsInstagramUrl')?.value.trim() || '',
        x_url: $('snsXUrl')?.value.trim() || '',
        youtube_url: $('snsYoutubeUrl')?.value.trim() || ''
    };
    if (current.id) {
        await request(`/api/extra/sns_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('sns_settings', payload);
    }
    await loadExtraData();
    showAlert('SNS情報を保存しました', 'success');
}

function renderSnsView() {
    const container = $('memberSnsInfo');
    if (!container) return;
    const sns = currentSnsSetting();
    const links = [
        { label: 'Facebook', url: sns.facebook_url },
        { label: 'Instagram', url: sns.instagram_url },
        { label: 'X', url: sns.x_url },
        { label: 'YouTube', url: sns.youtube_url }
    ];
    container.innerHTML = `
        <div class="d-flex flex-wrap gap-2">
            ${links.map((item) => item.url
                ? `<a class="btn btn-outline-primary" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>`
                : `<button class="btn btn-outline-secondary" type="button" disabled>${escapeHtml(item.label)}</button>`
            ).join('')}
        </div>
    `;
}

function renderConcertRecordView() {
    const container = $('memberConcertRecordInfo');
    if (!container) return;
    const youtubeUrl = currentSnsSetting().youtube_url || '';
    container.innerHTML = youtubeUrl
        ? `<a class="btn btn-outline-primary" href="${escapeHtml(youtubeUrl)}" target="_blank" rel="noopener noreferrer">YouTube</a>`
        : '<p class="text-muted mb-0">YouTubeリンクはまだ登録されていません</p>';
}

function renderMemberIntros() {
    const container = $('memberIntroInfo');
    if (!container) return;
    if (!appState.members.length) {
        container.innerHTML = '<p class="text-muted mb-0">団員情報はまだありません</p>';
        return;
    }
    const grouped = groupBy(sortedMembersByPartAndKana(appState.members), 'part');
    container.innerHTML = Object.entries(grouped).map(([part, members]) => `
        <section class="mb-3">
            <h6>${escapeHtml(part || '未設定')}</h6>
            <div class="row g-3">${members.map((member) => `
                <div class="col-md-6 col-xl-4"><div class="card h-100"><div class="card-body">
                    <div class="d-flex gap-3">
                        ${member.photo_url ? `<img src="${escapeHtml(member.photo_url)}" alt="${escapeHtml(memberDisplayName(member))}" class="member-photo">` : ''}
                        <div>
                            <h6 class="mb-1">${escapeHtml(memberDisplayName(member))}${member.is_founder ? '<span class="badge text-bg-info ms-2">創設メンバー</span>' : ''}</h6>
                            ${memberKanaName(member) ? `<div class="small text-muted">${escapeHtml(memberKanaName(member))}</div>` : ''}
                            <div class="small text-muted">${escapeHtml(member.part || '')}</div>
                        </div>
                    </div>
                    ${member.joined_at ? `<div class="small mt-2"><strong>入団:</strong> ${escapeHtml(member.joined_at)}</div>` : ''}
                    ${member.introducer ? `<div class="small"><strong>紹介者:</strong> ${escapeHtml(member.introducer)}</div>` : ''}
                    ${member.role ? `<div class="small"><strong>役割:</strong> ${escapeHtml(member.role)}</div>` : ''}
                    ${member.instrument_history ? `<div class="small mt-2 multiline-text"><strong>楽器歴:</strong><br>${escapeHtml(member.instrument_history)}</div>` : ''}
                    ${member.past_orchestras ? `<div class="small mt-2 multiline-text"><strong>過去所属オケ:</strong><br>${escapeHtml(member.past_orchestras)}</div>` : ''}
                    ${member.comment ? `<div class="small text-muted mt-2 multiline-text"><strong>コメント:</strong><br>${escapeHtml(member.comment)}</div>` : ''}
                    ${String(member.id || '') === String(appState.currentUserMemberId || '') ? `<div class="mt-3"><button class="btn btn-sm btn-outline-primary member-profile-edit-btn" type="button" data-member-id="${escapeHtml(String(member.id || ''))}">編集</button></div>` : ''}
                </div></div></div>`).join('')}</div>
        </section>
    `).join('');
    container.querySelectorAll('.member-profile-edit-btn').forEach((button) => {
        button.addEventListener('click', () => showOwnProfileEditForm(button.dataset.memberId || ''));
    });
}

function showOwnProfileEditForm(memberId) {
    const member = appState.members.find((item) => String(item.id || '') === String(memberId));
    const container = $('memberIntroInfo');
    if (!member || !container || String(member.id || '') !== String(appState.currentUserMemberId || '')) {
        showAlert('編集できるプロフィールが見つかりません', 'warning');
        return;
    }
    container.innerHTML = `
        <div class="card">
            <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
                <span>プロフィール編集</span>
                <button class="btn btn-sm btn-outline-secondary" id="profileEditCancelBtn" type="button">戻る</button>
            </div>
            <div class="card-body">
                <div class="row g-3">
                    <div class="col-md-4">
                        <label class="form-label" for="profilePhotoFile">プロフィール写真</label>
                        <input type="file" class="form-control" id="profilePhotoFile" accept="image/*">
                    </div>
                    <div class="col-md-4">
                        <label class="form-label" for="profileJoinedAt">入団年月</label>
                        <input type="month" class="form-control" id="profileJoinedAt" value="${escapeHtml(member.joined_at || '')}">
                    </div>
                    <div class="col-md-4">
                        <label class="form-label" for="profileIntroducer">紹介者</label>
                        <input type="text" class="form-control" id="profileIntroducer" value="${escapeHtml(member.introducer || '')}">
                    </div>
                    <div class="col-12">
                        <label class="form-label" for="profileRole">役割</label>
                        <input type="text" class="form-control" id="profileRole" value="${escapeHtml(member.role || '')}">
                    </div>
                    <div class="col-md-6">
                        <label class="form-label" for="profileInstrumentHistory">楽器歴</label>
                        <textarea class="form-control" id="profileInstrumentHistory" rows="4">${escapeHtml(member.instrument_history || '')}</textarea>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label" for="profilePastOrchestras">過去所属オケ</label>
                        <textarea class="form-control" id="profilePastOrchestras" rows="4">${escapeHtml(member.past_orchestras || '')}</textarea>
                    </div>
                    <div class="col-12">
                        <label class="form-label" for="profileComment">コメント</label>
                        <textarea class="form-control" id="profileComment" rows="4">${escapeHtml(member.comment || '')}</textarea>
                    </div>
                </div>
                <div class="d-flex flex-wrap gap-2 mt-3">
                    <button class="btn btn-primary" id="profileSaveBtn" type="button">保存</button>
                    <button class="btn btn-outline-secondary" id="profileEditCancelBtnBottom" type="button">キャンセル</button>
                </div>
            </div>
        </div>
    `;
    $('profileSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveOwnProfile(member.id)));
    $('profileEditCancelBtn')?.addEventListener('click', renderMemberIntros);
    $('profileEditCancelBtnBottom')?.addEventListener('click', renderMemberIntros);
}

async function saveOwnProfile(memberId) {
    const current = appState.members.find((item) => String(item.id || '') === String(memberId));
    if (!current || String(current.id || '') !== String(appState.currentUserMemberId || '')) {
        showAlert('編集できるプロフィールが見つかりません', 'warning');
        return;
    }
    const photoFile = $('profilePhotoFile')?.files?.[0];
    const photoUrl = photoFile ? await fileToDataUrl(photoFile) : (current.photo_url || '');
    const payload = {
        ...current,
        photo_url: photoUrl,
        joined_at: $('profileJoinedAt')?.value || '',
        introducer: $('profileIntroducer')?.value.trim() || '',
        role: $('profileRole')?.value.trim() || '',
        instrument_history: $('profileInstrumentHistory')?.value.trim() || '',
        past_orchestras: $('profilePastOrchestras')?.value.trim() || '',
        comment: $('profileComment')?.value.trim() || ''
    };
    await request(`/api/members/${encodeURIComponent(memberId)}`, jsonOptions('PUT', payload));
    await loadMembers();
    showAlert('プロフィールを保存しました', 'success');
}

function renderEvents() {
    const list = $('eventListItems');
    if (!list) return;
    list.innerHTML = emptyText(appState.events, 'イベント調整はまだありません');
    sortedEvents(appState.events).forEach((event) => {
        const item = document.createElement('div');
        item.className = 'list-group-item list-group-item-action';
        item.innerHTML = `
            <div class="d-flex flex-wrap justify-content-between gap-2">
                <span>
                    <strong>${escapeHtml(event.title)}</strong>
                    <div class="small text-muted">開催日: ${escapeHtml(eventDateTimeLabel(event))} / 回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}</div>
                    <div class="small text-muted">削除時の合言葉: ${escapeHtml(event.delete_phrase || '未設定')}</div>
                </span>
                <span>
                    <button class="btn btn-sm btn-outline-danger admin-event-delete-btn" type="button">削除</button>
                </span>
            </div>
            ${event.notes ? `<div class="small multiline-text mt-1">${escapeHtml(event.notes)}</div>` : ''}
            ${event.url ? `<div class="small text-truncate">${escapeHtml(event.url)}</div>` : ''}
        `;
        item.addEventListener('click', () => selectEvent(event.id));
        item.querySelector('.admin-event-delete-btn').addEventListener('click', (clickEvent) => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            withButtonStatus(clickEvent.currentTarget, '削除中...', () => deleteEventById(event.id, true));
        });
        list.appendChild(item);
    });
    if (!appState.suppressDerivedRender) renderMemberEventView();
}

function renderPerformances() {
    const list = $('perfListItems');
    list.innerHTML = emptyText(appState.performances, '演奏会情報はまだありません');
    appState.performances.forEach((perf) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'list-group-item list-group-item-action';
        item.innerHTML = `
            <strong>${escapeHtml(perf.title)}</strong>
            <div class="small text-muted">${escapeHtml(formatDateWithWeekday(perf.date))} / ${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</div>
        `;
        item.addEventListener('click', () => selectPerformance(perf.id));
        list.appendChild(item);
    });
    if (!appState.suppressDerivedRender) {
        renderMemberPerformances();
        renderMemberSchedules();
        renderSchedulePerformanceOptions();
        updateSchedulePieceOptions();
        renderPortalHome();
    }
}

function renderSchedules() {
    const container = $('schedListItems');
    if (!appState.schedules.length) {
        container.innerHTML = '<p class="text-muted mb-0">練習予定はまだありません</p>';
        if (!appState.suppressDerivedRender) renderMemberSchedules();
        return;
    }
    container.innerHTML = `
        <div class="table-responsive">
            <table class="table table-sm align-middle">
                <thead><tr><th>日付</th><th>時間</th><th>場所</th><th>演奏会</th><th>曲</th><th>備考</th></tr></thead>
                <tbody></tbody>
            </table>
        </div>
    `;
    const body = container.querySelector('tbody');
    sortedSchedules(appState.schedules).forEach((sched) => {
        const row = document.createElement('tr');
        row.className = 'clickable-row';
        row.innerHTML = `
            <td>${escapeHtml(formatDateWithWeekday(sched.date))}</td>
            <td>${escapeHtml(scheduleTimeLabel(sched))}</td>
            <td>${escapeHtml(sched.venue || '')}</td>
            <td>${escapeHtml(schedulePerformanceLabel(sched))}</td>
            <td>${escapeHtml(sched.pieces || '')}</td>
            <td>${escapeHtml(sched.notes || '')}</td>
        `;
        row.addEventListener('click', () => selectSchedule(sched.id));
        body.appendChild(row);
    });
    if (!appState.suppressDerivedRender) renderMemberSchedules();
}

function renderAnnouncements() {
    const admin = $('annListItems');
    const member = $('memberAnnList');
    admin.innerHTML = emptyText(appState.announcements, 'お知らせはまだありません');
    member.innerHTML = emptyText(appState.announcements, 'お知らせはまだありません');
    appState.announcements.forEach((ann) => {
        const adminItem = announcementItem(ann, true);
        const memberItem = announcementItem(ann, false);
        admin.appendChild(adminItem);
        member.appendChild(memberItem);
    });
    if (!appState.suppressDerivedRender) renderPortalHome();
}

function announcementItem(ann, selectable) {
    const item = document.createElement(selectable ? 'button' : 'li');
    item.className = selectable
        ? 'list-group-item list-group-item-action'
        : 'list-group-item';
    if (selectable) item.type = 'button';
    item.innerHTML = `<span class="small text-muted">${escapeHtml(formatDateWithWeekday(ann.date))}</span><br>${escapeHtml(ann.content)}`;
    if (selectable) item.addEventListener('click', () => selectAnnouncement(ann.id));
    return item;
}

function renderRecordings() {
    renderRecordingList('songTreeAdmin', true);
    renderRecordingList('songTreeMember', false);
}

function renderRecordingList(containerId, canDelete) {
    const container = $(containerId);
    if (!appState.recordings.length) {
        container.innerHTML = '<p class="text-muted mb-0">録音ファイルはまだありません</p>';
        return;
    }

    const grouped = groupRecordingsByDateAndPiece(appState.recordings);
    const latestDate = grouped[0]?.date || '';
    container.innerHTML = '';
    if (!canDelete) {
        const controls = document.createElement('div');
        controls.className = 'recording-controls';
        controls.innerHTML = `
            <label class="form-check recording-continuous-check">
                <input class="form-check-input" id="continuousPlaybackCheck" type="checkbox" ${appState.continuousPlayback ? 'checked' : ''}>
                <span class="form-check-label">連続再生</span>
            </label>
        `;
        controls.querySelector('#continuousPlaybackCheck').addEventListener('change', (event) => {
            appState.continuousPlayback = event.currentTarget.checked;
        });
        container.appendChild(controls);
    }
    grouped.forEach((dateGroup) => {
        const dateOpen = canDelete || dateGroup.date === latestDate;
        const dateDetails = document.createElement('details');
        dateDetails.className = 'recording-date-group';
        dateDetails.open = dateOpen;
            dateDetails.innerHTML = `
                <summary class="recording-summary recording-date-summary">
                    <span>${escapeHtml(formatDateWithWeekday(dateGroup.date, '未分類'))}</span>
                    ${canDelete ? '<button class="btn btn-sm btn-outline-danger recording-bulk-delete-btn" type="button">練習日を一括削除</button>' : `<a class="btn btn-sm btn-primary recording-bulk-download-btn" href="${escapeHtml(recordingZipUrl(dateGroup.date, ''))}">練習日一括DL</a>`}
                </summary>
            `;
        if (canDelete) {
            dateDetails.querySelector('.recording-bulk-delete-btn').addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                withButtonStatus(event.currentTarget, '削除中...', () => deleteRecordingGroup(dateGroup.pieces.flatMap((pieceGroup) => pieceGroup.files), `${formatDateWithWeekday(dateGroup.date, '未分類')} の録音`));
            });
        } else {
            dateDetails.querySelectorAll('.recording-bulk-download-btn').forEach((link) => {
                link.addEventListener('click', (event) => event.stopPropagation());
            });
        }
        dateGroup.pieces.forEach((pieceGroup) => {
            const pieceDetails = document.createElement('details');
            pieceDetails.className = 'recording-piece-group';
            pieceDetails.open = canDelete || dateGroup.date === latestDate;
                pieceDetails.innerHTML = `
                <summary class="recording-summary recording-piece-summary">
                    <span>${escapeHtml(pieceGroup.piece || '未分類')}</span>
                    ${canDelete ? '<button class="btn btn-sm btn-outline-danger recording-bulk-delete-btn" type="button">曲を一括削除</button>' : `<a class="btn btn-sm btn-outline-primary recording-bulk-download-btn" href="${escapeHtml(recordingZipUrl(dateGroup.date, pieceGroup.piece))}">曲一括DL</a>`}
                </summary>
            `;
            if (canDelete) {
                pieceDetails.querySelector('.recording-bulk-delete-btn').addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    withButtonStatus(event.currentTarget, '削除中...', () => deleteRecordingGroup(pieceGroup.files, `${formatDateWithWeekday(dateGroup.date, '未分類')} / ${pieceGroup.piece || '未分類'} の録音`));
                });
            }
            if (!canDelete) {
                pieceDetails.querySelectorAll('.recording-bulk-download-btn').forEach((link) => {
                    link.addEventListener('click', (event) => event.stopPropagation());
                });
            }
            const list = document.createElement('div');
            list.className = 'list-group mb-3';
            if (!canDelete && dateGroup.date === latestDate) {
                pieceDetails.classList.add('files-collapsed');
                list.hidden = true;
                const summary = pieceDetails.querySelector('summary');
                summary.addEventListener('click', (event) => {
                    event.preventDefault();
                    list.hidden = !list.hidden;
                    pieceDetails.open = true;
                    pieceDetails.classList.toggle('files-collapsed', list.hidden);
                });
            }
            pieceGroup.files.forEach((file) => {
                list.appendChild(recordingFileItem(file, canDelete));
            });
            pieceDetails.appendChild(list);
            dateDetails.appendChild(pieceDetails);
        });
        container.appendChild(dateDetails);
    });
}

function recordingZipUrl(date = '', piece = '') {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (piece) params.set('piece', piece);
    return `/api/recordings/download-zip?${params.toString()}`;
}

function groupRecordingsByDateAndPiece(recordings) {
    const dates = new Map();
    [...recordings]
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.piece || '').localeCompare(String(b.piece || '')) || String(a.name || '').localeCompare(String(b.name || '')))
        .forEach((file) => {
            const date = file.date || '未分類';
            const piece = file.piece || '未分類';
            if (!dates.has(date)) dates.set(date, new Map());
            if (!dates.get(date).has(piece)) dates.get(date).set(piece, []);
            dates.get(date).get(piece).push(file);
        });
    return Array.from(dates.entries()).map(([date, pieces]) => ({
        date,
        pieces: Array.from(pieces.entries()).map(([piece, files]) => ({ piece, files }))
    }));
}

function recordingFileItem(file, canDelete) {
    const item = document.createElement('div');
    item.className = 'list-group-item recording-list-item';
    const playUrl = file.play_url || file.download_url;
    const downloadUrl = file.download_url || playUrl;
    const actionButton = canDelete
        ? '<button class="btn btn-sm btn-outline-danger delete-recording-btn" type="button">削除</button>'
        : `<a class="btn btn-sm btn-primary" href="${escapeHtml(downloadUrl)}">DL</a>`;
    item.innerHTML = `
        <div class="recording-row">
            <span class="recording-meta">
                <strong class="recording-file-name">${escapeHtml(displayNameWithoutExtension(file.name))}</strong>
                <span class="recording-duration">${formatDurationLabel(file)}</span>
            </span>
            <span class="recording-actions">
                <button class="btn btn-sm btn-outline-primary play-recording-btn" type="button">再生</button>
                ${actionButton}
            </span>
        </div>
        <div class="recording-player-area mt-2"></div>
    `;
    bindRecordingFileItem(item, file, playUrl, canDelete);
    if (canDelete) {
        item.querySelector('.delete-recording-btn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteRecording(file)));
    }
    return item;
}

function bindRecordingFileItem(item, file, playUrl, canDelete) {
    const playButton = item.querySelector('.play-recording-btn');
    const playerArea = item.querySelector('.recording-player-area');
    playButton.disabled = !playUrl;
    if (!playUrl) return;
    let audio = null;
    playButton.addEventListener('click', async () => {
        try {
            if (!audio) {
                audio = document.createElement('audio');
                audio.controls = true;
                audio.preload = 'auto';
                audio.className = 'w-100';
                audio.src = withCacheBuster(playUrl);
                playerArea.appendChild(audio);
                audio.addEventListener('pause', () => {
                    if (!audio.ended) {
                        playButton.textContent = '再生';
                        if (appState.currentAudio === audio) {
                            appState.currentAudio = null;
                            appState.currentPlayButton = null;
                        }
                    }
                });
                audio.addEventListener('ended', () => {
                    playButton.textContent = '再生';
                    if (appState.currentAudio === audio) {
                        appState.currentAudio = null;
                        appState.currentPlayButton = null;
                    }
                    if (!canDelete && appState.continuousPlayback) {
                        playNextRecording(item);
                    }
                });
                audio.addEventListener('error', () => {
                    showAlert('音声ファイルを読み込めませんでした。再デプロイ後の場合は更新して再試行してください。', 'danger');
                    playButton.textContent = '再生';
                });
            }
            if (audio.paused) {
                stopCurrentRecording(audio);
                await audio.play();
                appState.currentAudio = audio;
                appState.currentPlayButton = playButton;
                playButton.textContent = '停止';
            } else {
                audio.pause();
                playButton.textContent = '再生';
                if (appState.currentAudio === audio) {
                    appState.currentAudio = null;
                    appState.currentPlayButton = null;
                }
            }
        } catch (error) {
            showAlert(`再生できませんでした: ${error.message}`, 'danger');
            playButton.textContent = '再生';
        }
    });
}

function stopCurrentRecording(exceptAudio = null) {
    const audio = appState.currentAudio;
    const button = appState.currentPlayButton;
    if (audio && audio !== exceptAudio) {
        audio.pause();
        try {
            audio.currentTime = 0;
        } catch {
            // Some streaming sources cannot seek until enough data has loaded.
        }
        if (button) {
            button.textContent = '再生';
        }
    }
    if (audio !== exceptAudio) {
        appState.currentAudio = null;
        appState.currentPlayButton = null;
    }
}

function playNextRecording(currentItem) {
    const items = Array.from(document.querySelectorAll('#songTreeMember .recording-list-item'));
    const currentIndex = items.indexOf(currentItem);
    const nextItem = items[currentIndex + 1];
    const nextButton = nextItem?.querySelector('.play-recording-btn:not(:disabled)');
    if (nextButton) {
        nextButton.click();
    }
}

function withCacheBuster(url) {
    if (!url) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}t=${Date.now()}`;
}

async function deleteRecording(file) {
    if (!confirmDelete()) return;

    await deleteRecordingFile(file);
    await loadRecordings();
    showAlert('録音ファイルを削除しました', 'success');
}

async function deleteRecordingGroup(files, label) {
    const targets = (files || []).filter(Boolean);
    if (!targets.length) return;
    if (!confirmDelete()) return;

    for (const file of targets) {
        await deleteRecordingFile(file);
    }
    await loadRecordings();
    showAlert(`${targets.length}件の録音ファイルを削除しました`, 'success');
}

async function deleteRecordingFile(file) {
    await request('/api/recordings', jsonOptions('DELETE', {
        source: file.source || 'local',
        object_name: file.object_name || file.id || '',
        path: file.path || ''
    }));
}

function renderMemberViews() {
    renderMemberPerformances();
    renderMemberSchedules();
    renderAnnouncements();
    renderRecordings();
    renderMemberIntros();
    renderPortalHome();
}

function renderPortalHome() {
    const announceContainer = $('portalHomeAnnouncements');
    const countdownContainer = $('portalHomeCountdown');
    const menuContainer = $('portalHomeMenu');
    if (!announceContainer || !countdownContainer || !menuContainer) return;

    const announcements = [...(appState.announcements || [])]
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        .slice(0, 5);
    announceContainer.innerHTML = announcements.length
        ? `<div class="list-group">${announcements.map((ann) => `
            <article class="list-group-item">
                <div class="small text-muted">${escapeHtml(formatDateWithWeekday(ann.date, ''))}</div>
                <div class="multiline-text">${escapeHtml(ann.content || '')}</div>
            </article>
        `).join('')}</div>`
        : '<p class="text-muted mb-0">お知らせはまだありません</p>';

    const nextPerf = nextPerformance();
    const countdown = nextPerf ? daysUntil(nextPerf.date) : null;
    countdownContainer.innerHTML = nextPerf && countdown !== null
        ? `<section class="portal-countdown-card">
            <div class="portal-countdown-main">本番まであと${Math.max(0, countdown)}日！</div>
            <div class="portal-countdown-sub">${escapeHtml(nextPerf.title || '')} / ${escapeHtml(formatDateWithWeekday(nextPerf.date, ''))}</div>
        </section>`
        : `<section class="portal-countdown-card muted">
            <div class="portal-countdown-main">演奏会情報はまだありません</div>
            <div class="portal-countdown-sub">管理メニューから演奏会情報を登録してください</div>
        </section>`;

    renderMenuGroups(menuContainer);
}

function nextPerformance() {
    const upcoming = [...(appState.performances || [])]
        .filter((perf) => perf.date && perf.date >= today())
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return upcoming[0] || null;
}

function renderMemberPerformances() {
    const container = $('memberPerfInfo');
    if (!appState.performances.length) {
        container.innerHTML = '<p class="text-muted mb-0">演奏会情報はまだありません</p>';
        return;
    }
    const nextPerf = nextPerformance() || [...appState.performances].filter((perf) => perf.date).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    const countdown = nextPerf ? daysUntil(nextPerf.date) : null;
    container.innerHTML = `${nextPerf && countdown !== null ? `<div class="countdown-banner">本番まであと${countdown}日！</div>` : ''}` + appState.performances.map((perf) => `
        <article class="info-block">
            <h5>${escapeHtml(perf.title)}</h5>
            <p>${escapeHtml(formatDateWithWeekday(perf.date))} ${escapeHtml(perf.open_time)}開場 / ${escapeHtml(perf.start_time)}開演</p>
            <p>${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</p>
            <div class="mb-0">${(perf.pieces || []).map((piece) => `<div>${escapeHtml(performancePieceLabel(piece))}</div>`).join('')}</div>
        </article>
    `).join('');
}

function renderMemberSchedules() {
    const container = $('memberSchedInfo');
    const upcoming = sortedSchedules(appState.schedules).filter((sched) => !sched.date || sched.date >= today());
    if (!upcoming.length) {
        container.innerHTML = '<p class="text-muted mb-0">練習予定はまだありません</p>';
        return;
    }
    const grouped = groupSchedulesByPerformance(upcoming);
    container.innerHTML = `
        <div class="d-flex flex-wrap justify-content-end gap-2 mb-3">
            <button class="btn btn-outline-success btn-sm" id="scheduleBulkCalendarBtn" type="button">予定を一括連携</button>
        </div>
        ${grouped.map((group) => `
        <details class="schedule-performance-group" open>
            <summary class="schedule-performance-summary">
                <span class="schedule-performance-title">${escapeHtml(group.title)}</span>
            </summary>
            ${group.schedules.map((sched) => `
                <article class="info-block schedule-card ${scheduleIsMainPerformance(sched) ? 'schedule-card-main-performance' : ''}">
                    <div class="schedule-main-line schedule-date-line">
                        <span>${escapeHtml(formatScheduleDate(sched.date))}</span>
                        ${scheduleIsConductorTraining(sched) ? '<span class="schedule-conductor-training">※指揮トレ</span>' : ''}
                    </div>
                    <div class="schedule-main-line">${escapeHtml(scheduleTimeLabel(sched) || '時間未定')}</div>
                    <div class="schedule-main-line">${escapeHtml(sched.venue || '場所未定')}</div>
                    <div class="schedule-detail-line">練習可能時間: ${escapeHtml(scheduleAvailableLabel(sched) || '未定')}</div>
                    <div class="schedule-detail-line">練習曲: ${escapeHtml(sched.pieces || '未定')}</div>
                    <div class="schedule-detail-line multiline-text">備考: ${escapeHtml(sched.notes || 'なし')}</div>
                    <div class="schedule-action-row">
                        <button class="btn btn-outline-success btn-sm" type="button" data-google-calendar="${escapeHtml(String(sched.id))}">Googleカレンダー連携</button>
                    </div>
                </article>
            `).join('')}
        </details>
    `).join('')}
    `;
    $('scheduleBulkCalendarBtn')?.addEventListener('click', () => downloadSchedulesIcs(upcoming));
    container.querySelectorAll('[data-google-calendar]').forEach((button) => {
        button.addEventListener('click', () => openGoogleCalendarForSchedule(button.dataset.googleCalendar));
    });
}

function sortedSchedules(schedules) {
    return [...(schedules || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(scheduleTimeLabel(a)).localeCompare(String(scheduleTimeLabel(b))));
}

function groupSchedulesByPerformance(schedules) {
    const groups = new Map();
    schedules.forEach((sched) => {
        const key = sched.performance_id ? `performance-${sched.performance_id}` : `title-${schedulePerformanceLabel(sched)}`;
        if (!groups.has(key)) {
            const performance = appState.performances.find((perf) => String(perf.id) === String(sched.performance_id));
            groups.set(key, {
                title: performance ? performance.title : schedulePerformanceLabel(sched),
                performanceId: performance?.id || sched.performance_id || null,
                date: performance?.date || '',
                schedules: []
            });
        }
        groups.get(key).schedules.push(sched);
    });
    return Array.from(groups.values())
        .sort(compareSchedulePerformanceGroups)
        .map((group) => ({
            ...group,
            schedules: sortedSchedules(group.schedules)
        }));
}

function compareSchedulePerformanceGroups(a, b) {
    const aUndecided = schedulePerformanceGroupIsUndecided(a);
    const bUndecided = schedulePerformanceGroupIsUndecided(b);
    if (aUndecided !== bUndecided) return aUndecided ? 1 : -1;

    const aHasDate = Boolean(a.date);
    const bHasDate = Boolean(b.date);
    if (aHasDate !== bHasDate) return aHasDate ? -1 : 1;

    return String(a.date || '').localeCompare(String(b.date || ''))
        || String(a.title || '').localeCompare(String(b.title || ''));
}

function schedulePerformanceGroupIsUndecided(group) {
    return !group.performanceId && (!group.title || group.title === '未定');
}

function schedulePerformance(sched) {
    if (!sched || !sched.performance_id) return null;
    return appState.performances.find((perf) => String(perf.id) === String(sched.performance_id)) || null;
}

function scheduleIsConductorTraining(sched) {
    return Boolean(sched?.is_conductor_training);
}

function scheduleIsMainPerformance(sched) {
    return Boolean(sched?.is_main_performance);
}

function formatScheduleDate(dateText) {
    return formatDateWithWeekday(dateText);
}

function formatDateWithWeekday(dateText, fallback = '未定') {
    if (!dateText) return fallback;
    const date = new Date(`${dateText}T00:00:00`);
    if (Number.isNaN(date.getTime())) return dateText;
    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    return `${dateText}（${weekdays[date.getDay()]}）`;
}

function formatDateTimeLabel(value) {
    if (!value) return '未記録';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const dateText = date.toISOString().slice(0, 10);
    const timeText = date.toTimeString().slice(0, 5);
    return `${formatDateWithWeekday(dateText)} ${timeText}`;
}

function schedulePerformanceLabel(sched) {
    if (sched.performance_title) return sched.performance_title;
    if (sched.performance_id) {
        const performance = appState.performances.find((perf) => String(perf.id) === String(sched.performance_id));
        if (performance) return performance.title;
    }
    return '未定';
}

function daysUntil(dateText) {
    const target = new Date(`${dateText}T00:00:00`);
    const base = new Date(`${today()}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    return Math.ceil((target - base) / 86400000);
}

function formatDurationLabel(file) {
    if (file.duration) return file.duration;
    if (file.duration_seconds || file.duration_seconds === 0) {
        const total = Math.round(Number(file.duration_seconds));
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }
    return '長さ未取得';
}

function renderMemberExtraViews() {
    renderAbsenceView();
    renderSheetLibraryView();
    renderPaymentView();
    renderCastingView();
    renderMemberEventView();
    renderPieceInfoView();
    renderAlbumView();
    renderConcertRecordView();
    renderSnsView();
}

function scheduleOptions(selected = '') {
    return ['<option value="">選択してください</option>'].concat(sortedSchedules(appState.schedules).map((s) => `<option value="${escapeHtml(String(s.id))}" ${String(s.id) === String(selected) ? 'selected' : ''}>${escapeHtml(formatDateWithWeekday(s.date))} ${escapeHtml(scheduleTimeLabel(s))} ${escapeHtml(s.venue || '')}</option>`)).join('');
}

function renderAbsenceView() {
    const container = $('memberAbsenceInfo');
    if (!container) return;
    const currentName = currentUserMemberName();
    if (!currentName) {
        container.innerHTML = '<p class="text-muted mb-0">ログイン中の団員情報が見つかりません</p>';
        return;
    }
    const grouped = groupBy(appState.absences, 'schedule_id');
    const ownAbsences = sortedSchedules(appState.schedules)
        .map((schedule) => ({
            schedule,
            absence: appState.absences.find((item) =>
                String(item.schedule_id || '') === String(schedule.id || '') && absenceBelongsToCurrentUser(item)
            )
        }))
        .filter((item) => item.absence);
    container.innerHTML = `
        <input type="hidden" id="absenceId">
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-5"><label class="form-label">練習日</label><select id="absenceScheduleId" class="form-select">${scheduleOptions()}</select></div>
            <div class="col-md-2"><label class="form-label">連絡区分</label><select id="absenceStatus" class="form-select"><option value="absent">欠席</option><option value="late">遅刻</option><option value="leave_early">早退</option></select></div>
            <div class="col-md-2"><label class="form-label" id="absenceTimeLabel" for="absenceTime">予定時刻</label><input id="absenceTime" class="form-control" type="time" disabled></div>
            <div class="col-md-3"><button class="btn btn-primary w-100" id="absenceSaveBtn" type="button">連絡を保存</button></div>
        </div>
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-outline-secondary btn-sm" id="absenceClearBtn" type="button">入力をクリア</button>
            <button class="btn btn-outline-danger btn-sm" id="absenceDeleteBtn" type="button" disabled>選択中の連絡を削除</button>
        </div>
        <h6>自分の出欠連絡</h6>
        ${ownAbsences.length ? `<div class="list-group mb-3">${ownAbsences.map(({ schedule, absence }) => `
            <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                <span>
                    <strong>${escapeHtml(formatDateWithWeekday(schedule.date))} ${escapeHtml(scheduleTimeLabel(schedule))}</strong>
                    <span class="ms-2">${escapeHtml(absenceEntryLabel(absence, false))}</span>
                    <div class="small text-muted">${escapeHtml(schedule.venue || '')}</div>
                </span>
                <span class="d-flex gap-2">
                    <button class="btn btn-sm btn-outline-primary absence-edit-btn" type="button" data-absence-id="${escapeHtml(String(absence.id || ''))}">編集</button>
                    <button class="btn btn-sm btn-outline-danger absence-delete-btn" type="button" data-absence-id="${escapeHtml(String(absence.id || ''))}">削除</button>
                </span>
            </div>
        `).join('')}</div>` : '<p class="text-muted">自分の出欠連絡はまだ登録されていません</p>'}
        <h6>練習日ごとの出欠連絡</h6>
        ${sortedSchedules(appState.schedules).map((s) => {
            const abs = (grouped[String(s.id)] || grouped[s.id] || []);
            return `<div class="info-block"><strong>${escapeHtml(formatDateWithWeekday(s.date))} ${escapeHtml(scheduleTimeLabel(s))}</strong><div class="small text-muted">${escapeHtml(s.venue || '')}</div><div>${abs.length ? abs.map((a) => escapeHtml(absenceEntryLabel(a))).join('、') : '出欠連絡なし'}</div></div>`;
        }).join('')}
    `;
    const updateAbsenceTimeState = () => {
        const status = $('absenceStatus').value;
        const timeInput = $('absenceTime');
        const label = $('absenceTimeLabel');
        const needsTime = status === 'late' || status === 'leave_early';
        timeInput.disabled = !needsTime;
        if (!needsTime) timeInput.value = '';
        label.textContent = status === 'late' ? '到着予定時刻' : status === 'leave_early' ? '退出予定時刻' : '予定時刻';
    };
    $('absenceStatus').addEventListener('change', updateAbsenceTimeState);
    updateAbsenceTimeState();
    const setSelectedAbsenceId = (id = '') => {
        $('absenceId').value = id;
        $('absenceDeleteBtn').disabled = !id;
    };
    $('absenceClearBtn').addEventListener('click', () => {
        setSelectedAbsenceId('');
        $('absenceScheduleId').value = '';
        $('absenceStatus').value = 'absent';
        $('absenceTime').value = '';
        updateAbsenceTimeState();
    });
    $('absenceDeleteBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteOwnAbsence($('absenceId').value)));
    container.querySelectorAll('.absence-edit-btn').forEach((button) => {
        button.addEventListener('click', () => selectOwnAbsence(button.dataset.absenceId || ''));
    });
    container.querySelectorAll('.absence-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteOwnAbsence(button.dataset.absenceId || '')));
    });
    $('absenceSaveBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', async () => {
        const name = currentUserMemberName();
        const absenceId = $('absenceId').value;
        const scheduleId = $('absenceScheduleId').value;
        const status = $('absenceStatus').value;
        const plannedTime = $('absenceTime').value;
        if (!name || !scheduleId) { showAlert('練習日を選択してください', 'warning'); return; }
        if ((status === 'late' || status === 'leave_early') && !plannedTime) {
            showAlert('予定時刻を入力してください', 'warning');
            return;
        }
        const sched = appState.schedules.find((s) => String(s.id) === String(scheduleId));
        const payload = {
            name,
            member_id: appState.currentUserMemberId,
            schedule_id: scheduleId,
            schedule_date: sched ? sched.date : '',
            status,
            planned_time: plannedTime
        };
        const existing = appState.absences.find((item) =>
            String(item.schedule_id || '') === String(scheduleId) &&
            (String(item.member_id || '') === String(appState.currentUserMemberId || '') || item.name === name)
        );
        const saveId = existing?.id || absenceId || '';
        if (saveId) {
            await request(`/api/extra/absences/${encodeURIComponent(saveId)}`, jsonOptions('PUT', payload));
        } else {
            await saveExtra('absences', payload);
        }
        if (absenceId && existing?.id && String(existing.id) !== String(absenceId)) {
            await request(`/api/extra/absences/${encodeURIComponent(absenceId)}`, { method: 'DELETE' });
        }
        showAlert('出欠連絡を登録しました', 'success');
        await loadExtraData();
    }));
}

function absenceBelongsToCurrentUser(absence) {
    const currentId = String(appState.currentUserMemberId || '');
    const currentName = currentUserMemberName();
    return (currentId && String(absence?.member_id || '') === currentId) || (currentName && absence?.name === currentName);
}

function selectOwnAbsence(absenceId) {
    const absence = appState.absences.find((item) => String(item.id || '') === String(absenceId));
    if (!absence || !absenceBelongsToCurrentUser(absence)) return;
    $('absenceId').value = absence.id || '';
    $('absenceScheduleId').value = String(absence.schedule_id || '');
    $('absenceStatus').value = absence.status || 'absent';
    $('absenceTime').value = absence.planned_time || '';
    $('absenceDeleteBtn').disabled = false;
    $('absenceStatus').dispatchEvent(new Event('change'));
}

async function deleteOwnAbsence(absenceId) {
    if (!absenceId) return;
    const absence = appState.absences.find((item) => String(item.id || '') === String(absenceId));
    if (!absence || !absenceBelongsToCurrentUser(absence)) {
        showAlert('削除できる出欠連絡が見つかりません', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/extra/absences/${encodeURIComponent(absenceId)}`, { method: 'DELETE' });
    showAlert('出欠連絡を削除しました', 'success');
    await loadExtraData();
}

function absenceStatusLabel(absence) {
    const status = absence?.status || 'absent';
    if (status === 'late') return '遅刻';
    if (status === 'leave_early') return '早退';
    return '欠席';
}

function absenceEntryLabel(absence, includeName = true) {
    const time = absence?.planned_time ? ` ${absence.planned_time}` : '';
    const status = `${absenceStatusLabel(absence)}${time}`;
    return includeName ? `${absence?.name || ''}（${status}）` : status;
}

function renderSheetLibraryView() {
    const c = $('memberSheetInfo');
    if (!c) return;
    if (!appState.sheetLibrary.length) {
        c.innerHTML = '<p class="text-muted mb-0">登録された楽譜はありません</p>';
        return;
    }

    const filters = appState.sheetFilters || { performanceId: '', piece: '', part: '' };
    const visibleSheets = appState.sheetLibrary.filter((sheet) => {
        return (!filters.performanceId || String(sheet.performance_id || '') === String(filters.performanceId))
            && (!filters.piece || String(sheet.piece || '') === filters.piece)
            && (!filters.part || String(sheet.part || '') === filters.part);
    });
    const performanceOptions = sheetFilterPerformanceOptions(filters.performanceId);
    const pieceOptions = sheetFilterPieceOptions(filters.piece, filters.performanceId);
    const partOptions = sheetFilterPartOptions(filters.part, filters.performanceId, filters.piece);
    const filterHtml = `
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-4">
                <label class="form-label" for="memberSheetPerformanceFilter">演奏会</label>
                <select class="form-select" id="memberSheetPerformanceFilter">${performanceOptions}</select>
            </div>
            <div class="col-md-4">
                <label class="form-label" for="memberSheetPieceFilter">曲名</label>
                <select class="form-select" id="memberSheetPieceFilter">${pieceOptions}</select>
            </div>
            <div class="col-md-3">
                <label class="form-label" for="memberSheetPartFilter">パート</label>
                <select class="form-select" id="memberSheetPartFilter">${partOptions}</select>
            </div>
            <div class="col-md-1">
                <button class="btn btn-outline-secondary w-100" id="memberSheetFilterClearBtn" type="button">解除</button>
            </div>
        </div>
    `;
    if (!visibleSheets.length) {
        c.innerHTML = filterHtml + '<p class="text-muted mb-0">条件に一致する楽譜はありません</p>';
        bindSheetLibraryFilters();
        return;
    }

    const performanceGroups = groupBy(visibleSheets, 'performance_id');
    c.innerHTML = filterHtml + Object.entries(performanceGroups).map(([performanceId, sheets]) => {
        const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
        const performanceTitle = performance?.title || sheets[0]?.performance_title || '未設定の演奏会';
        const pieceGroups = groupBy(sheets, 'piece');
        return `
            <details class="mb-3 sheet-library-details sheet-performance-details" open>
                <summary class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                    <strong>${escapeHtml(performanceTitle)}</strong>
                    <a class="btn btn-sm btn-primary" href="${escapeHtml(sheetZipUrl(performanceId, '', filters.part))}">演奏会一括DL</a>
                </summary>
                <div class="mt-2">
                    ${Object.entries(pieceGroups).map(([piece, pieceSheets]) => `
                        <details class="mb-2 ms-md-3 sheet-library-details sheet-piece-details">
                            <summary class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                                <span>${escapeHtml(piece || '未設定の曲名')}</span>
                                <a class="btn btn-sm btn-outline-primary" href="${escapeHtml(sheetZipUrl(performanceId, piece, filters.part))}">曲一括DL</a>
                            </summary>
                            <div class="list-group mt-2">
                                ${pieceSheets.map((sheet) => `
                                    <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                                        <span>${escapeHtml(displayNameWithoutExtension(sheet.name || '楽譜'))}<span class="badge text-bg-secondary ms-2">${escapeHtml(sheet.part || 'パート未設定')}</span></span>
                                        <span class="d-flex gap-2">
                                            <button class="btn btn-sm btn-outline-primary" type="button" data-sheet-view="${escapeHtml(String(sheet.id || ''))}">表示</button>
                                            <a class="btn btn-sm btn-primary" href="${escapeHtml(sheet.download_url || sheet.url || '#')}" download>DL</a>
                                        </span>
                                    </div>
                                `).join('')}
                            </div>
                        </details>
                    `).join('')}
                </div>
            </details>
        `;
    }).join('');
    bindSheetLibraryFilters();
    c.querySelectorAll('[data-sheet-view]').forEach((button) => {
        button.addEventListener('click', () => showSheetViewer(button.dataset.sheetView || ''));
    });
}

function showSheetViewer(sheetId) {
    const sheet = appState.sheetLibrary.find((item) => String(item.id || '') === String(sheetId));
    if (!sheet) {
        showAlert('表示する楽譜が見つかりません', 'warning');
        return;
    }
    const viewUrl = sheet.view_url || sheet.url || '';
    if (!viewUrl) {
        showAlert('楽譜の表示URLが見つかりません', 'warning');
        return;
    }
    const title = $('sheetViewerTitle');
    const download = $('sheetViewerDownload');
    if (title) title.textContent = displayNameWithoutExtension(sheet.name || '楽譜表示');
    if (download) download.href = sheet.download_url || sheet.url || viewUrl;
    switchTab('memberPanel', 'member-sheet-viewer', false);
    renderPdfViewer(viewUrl);
}

function clearSheetViewer() {
    appState.sheetPdfUrl = '';
    appState.sheetPdfRendering = false;
    const pages = $('sheetViewerPages');
    const status = $('sheetViewerStatus');
    if (pages) pages.innerHTML = '';
    if (status) status.textContent = '';
}

async function loadPdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-pdfjs]');
        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.dataset.pdfjs = 'true';
        script.addEventListener('load', resolve, { once: true });
        script.addEventListener('error', reject, { once: true });
        document.head.appendChild(script);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return window.pdfjsLib;
}

async function renderPdfViewer(url, scale = null) {
    const pages = $('sheetViewerPages');
    const status = $('sheetViewerStatus');
    if (!pages || !status) return;
    appState.sheetPdfUrl = url;
    appState.sheetPdfRendering = true;
    pages.innerHTML = '';
    status.textContent = '楽譜を読み込み中...';
    try {
        const pdfjsLib = await loadPdfJs();
        const data = await fetch(url, { cache: 'no-store' }).then((response) => {
            if (!response.ok) throw new Error(`PDFを取得できませんでした (${response.status})`);
            return response.arrayBuffer();
        });
        if (appState.sheetPdfUrl !== url) return;
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const firstPage = await pdf.getPage(1);
        appState.sheetPdfScale = scale || sheetViewerFitScale(firstPage);
        status.textContent = `${pdf.numPages}ページを表示中`;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            if (appState.sheetPdfUrl !== url) return;
            const page = pageNumber === 1 ? firstPage : await pdf.getPage(pageNumber);
            await renderPdfPage(page, pageNumber, appState.sheetPdfScale, pages);
        }
        status.textContent = `${pdf.numPages}ページ`;
    } catch (error) {
        status.textContent = 'PDFを表示できませんでした';
        showAlert(error.message || 'PDFを表示できませんでした', 'danger');
    } finally {
        appState.sheetPdfRendering = false;
    }
}

function sheetViewerFitScale(page) {
    const body = $('sheetViewerPages');
    const viewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max((body?.clientWidth || window.innerWidth) - 24, 280);
    return Math.max(0.35, Math.min(2.5, availableWidth / viewport.width));
}

async function renderPdfPage(page, pageNumber, scale, container) {
    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement('section');
    wrapper.className = 'sheet-viewer-page';
    wrapper.innerHTML = `<div class="sheet-viewer-page-label">${pageNumber}</div>`;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    await page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
    }).promise;
}

function zoomSheetViewer(delta) {
    if (!appState.sheetPdfUrl || appState.sheetPdfRendering) return;
    const nextScale = Math.max(0.35, Math.min(3, appState.sheetPdfScale + delta));
    renderPdfViewer(appState.sheetPdfUrl, nextScale);
}

async function fitSheetViewerWidth() {
    if (!appState.sheetPdfUrl || appState.sheetPdfRendering) return;
    renderPdfViewer(appState.sheetPdfUrl, null);
}

function sheetPieceOptions(performance) {
    return normalizePerformancePieces(performance?.pieces || []).map(performancePieceLabel).filter(Boolean);
}

function sheetFilterPerformanceOptions(selected = '') {
    const ids = [...new Set(appState.sheetLibrary.map((sheet) => String(sheet.performance_id || '')).filter(Boolean))];
    return ['<option value="">すべて</option>'].concat(ids.map((id) => {
        const performance = appState.performances.find((perf) => String(perf.id) === id);
        const fallback = appState.sheetLibrary.find((sheet) => String(sheet.performance_id || '') === id)?.performance_title || '未設定の演奏会';
        return `<option value="${escapeHtml(id)}" ${id === String(selected) ? 'selected' : ''}>${escapeHtml(performance?.title || fallback)}</option>`;
    })).join('');
}

function sheetFilterPieceOptions(selected = '', performanceId = '') {
    const pieces = [...new Set(appState.sheetLibrary
        .filter((sheet) => !performanceId || String(sheet.performance_id || '') === String(performanceId))
        .map((sheet) => String(sheet.piece || ''))
        .filter(Boolean))];
    return ['<option value="">すべて</option>'].concat(pieces.map((piece) => `<option value="${escapeHtml(piece)}" ${piece === selected ? 'selected' : ''}>${escapeHtml(piece)}</option>`)).join('');
}

function sheetFilterPartOptions(selected = '', performanceId = '', piece = '') {
    const parts = [...new Set(appState.sheetLibrary
        .filter((sheet) => !performanceId || String(sheet.performance_id || '') === String(performanceId))
        .filter((sheet) => !piece || String(sheet.piece || '') === piece)
        .map((sheet) => String(sheet.part || ''))
        .filter(Boolean))].sort((a, b) => partSortIndex(a) - partSortIndex(b) || a.localeCompare(b, 'ja'));
    return ['<option value="">すべて</option>'].concat(parts.map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`)).join('');
}

function bindSheetLibraryFilters() {
    const performance = $('memberSheetPerformanceFilter');
    const piece = $('memberSheetPieceFilter');
    const part = $('memberSheetPartFilter');
    if (performance) performance.addEventListener('change', () => {
        appState.sheetFilters.performanceId = performance.value;
        appState.sheetFilters.piece = '';
        appState.sheetFilters.part = '';
        renderSheetLibraryView();
    });
    if (piece) piece.addEventListener('change', () => {
        appState.sheetFilters.piece = piece.value;
        appState.sheetFilters.part = '';
        renderSheetLibraryView();
    });
    if (part) part.addEventListener('change', () => {
        appState.sheetFilters.part = part.value;
        renderSheetLibraryView();
    });
    if ($('memberSheetFilterClearBtn')) $('memberSheetFilterClearBtn').addEventListener('click', () => {
        appState.sheetFilters = { performanceId: '', piece: '', part: '' };
        renderSheetLibraryView();
    });
}

function sheetPartOptions() {
    return currentPartNames();
}

function partOptionHtml(selected = '') {
    return ['<option value="">選択してください</option>']
        .concat(sheetPartOptions().map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`))
        .join('');
}

function sheetZipUrl(performanceId, piece = '', part = '') {
    const params = new URLSearchParams({ performance_id: String(performanceId || '') });
    if (piece) params.set('piece', piece);
    if (part) params.set('part', part);
    return `/api/sheets/download-zip?${params.toString()}`;
}

function renderSheetAdmin() {
    const performanceSelect = $('sheetPerformanceSelect');
    const list = $('sheetAdminList');
    if (!performanceSelect || !list) return;

    const selectedPerformance = performanceSelect.value;
    performanceSelect.innerHTML = ['<option value="">選択してください</option>'].concat(
        appState.performances.map((perf) => `<option value="${escapeHtml(String(perf.id))}" ${String(perf.id) === selectedPerformance ? 'selected' : ''}>${escapeHtml(perf.title || '')}</option>`)
    ).join('');
    if (selectedPerformance && !performanceSelect.value) performanceSelect.value = selectedPerformance;
    updateSheetPieceOptions();
    renderSheetAdminList();
}

function updateSheetPieceOptions() {
    const performanceSelect = $('sheetPerformanceSelect');
    const pieceSelect = $('sheetPieceSelect');
    if (!performanceSelect || !pieceSelect) return;
    const selectedPiece = pieceSelect.value;
    const performance = appState.performances.find((perf) => String(perf.id) === String(performanceSelect.value));
    const pieces = sheetPieceOptions(performance);
    pieceSelect.innerHTML = pieces.length
        ? ['<option value="">選択してください</option>'].concat(pieces.map((piece) => `<option value="${escapeHtml(piece)}" ${piece === selectedPiece ? 'selected' : ''}>${escapeHtml(piece)}</option>`)).join('')
        : '<option value="">曲目が登録されていません</option>';
}

async function uploadSheets() {
    const performanceId = $('sheetPerformanceSelect')?.value || '';
    const piece = $('sheetPieceSelect')?.value || '';
    const files = Array.from($('sheetFileInput')?.files || []);
    const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
    if (!performanceId || !performance || !piece) {
        showAlert('演奏会と曲名を選択してください', 'warning');
        return;
    }
    if (!files.length) {
        showAlert('PDFファイルを選択してください', 'warning');
        return;
    }
    const pdfFiles = files.filter((file) => file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf');
    if (pdfFiles.length !== files.length) {
        showAlert('PDFファイルのみ登録できます', 'warning');
        return;
    }

    for (const file of pdfFiles) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('performance_id', performanceId);
        formData.append('performance_title', performance.title || '');
        formData.append('piece', piece);
        await request('/api/sheets/upload', { method: 'POST', body: formData });
    }
    $('sheetFileInput').value = '';
    await loadSheets();
    showAlert(`${pdfFiles.length}件の楽譜を登録しました`, 'success');
}

function renderSheetAdminList() {
    const list = $('sheetAdminList');
    if (!list) return;
    if (!appState.sheetLibrary.length) {
        list.innerHTML = '<p class="text-muted mb-0">登録済みの楽譜はありません</p>';
        return;
    }

    const performanceGroups = groupBy(appState.sheetLibrary, 'performance_id');
    list.innerHTML = Object.entries(performanceGroups).map(([performanceId, sheets]) => {
        const performance = appState.performances.find((perf) => String(perf.id) === String(performanceId));
        const performanceTitle = performance?.title || sheets[0]?.performance_title || '未設定の演奏会';
        const pieceGroups = groupBy(sheets, 'piece');
        return `
            <section class="mb-4">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
                    <h5 class="mb-0">${escapeHtml(performanceTitle)}</h5>
                    <button class="btn btn-sm btn-outline-danger sheet-delete-performance-btn" type="button" data-performance-id="${escapeHtml(performanceId)}">演奏会配下を削除</button>
                </div>
                ${Object.entries(pieceGroups).map(([piece, pieceSheets]) => `
                    <div class="list-group mb-3">
                        <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                            <strong>${escapeHtml(piece || '未設定の曲名')}</strong>
                            <button class="btn btn-sm btn-outline-danger sheet-delete-piece-btn" type="button" data-performance-id="${escapeHtml(performanceId)}" data-piece="${escapeHtml(piece)}">曲名配下を削除</button>
                        </div>
                        ${pieceSheets.map((sheet) => `
                            <div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                                <span>${escapeHtml(displayNameWithoutExtension(sheet.name || '楽譜'))}<span class="badge text-bg-secondary ms-2">${escapeHtml(sheet.part || 'パート未設定')}</span></span>
                                <span class="d-flex flex-wrap gap-2 align-items-center">
                                    <select class="form-select form-select-sm sheet-part-assign-select" data-sheet-id="${escapeHtml(String(sheet.id || ''))}" style="width: 12rem;">
                                        ${partOptionHtml(sheet.part || '')}
                                    </select>
                                    <button class="btn btn-sm btn-outline-success sheet-part-save-btn" type="button" data-sheet-id="${escapeHtml(String(sheet.id || ''))}">パート保存</button>
                                    <a class="btn btn-sm btn-outline-primary" href="${escapeHtml(sheet.url || '#')}" target="_blank">閲覧</a>
                                    <a class="btn btn-sm btn-primary" href="${escapeHtml(sheet.download_url || sheet.url || '#')}" download>DL</a>
                                    <button class="btn btn-sm btn-outline-danger sheet-delete-file-btn" type="button" data-performance-id="${escapeHtml(performanceId)}" data-sheet-id="${escapeHtml(String(sheet.id || ''))}">削除</button>
                                </span>
                            </div>
                        `).join('')}
                    </div>
                `).join('')}
            </section>
        `;
    }).join('');

    list.querySelectorAll('.sheet-part-save-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveSheetPart(button.dataset.sheetId || '')));
    });
    list.querySelectorAll('.sheet-delete-file-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({
            performance_id: button.dataset.performanceId || '',
            sheet_id: Number(button.dataset.sheetId || 0)
        }, 'この楽譜を削除しますか？')));
    });
    list.querySelectorAll('.sheet-delete-piece-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({
            performance_id: button.dataset.performanceId || '',
            piece: button.dataset.piece || ''
        }, 'この曲名配下の楽譜を一括削除しますか？')));
    });
    list.querySelectorAll('.sheet-delete-performance-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSheets({
            performance_id: button.dataset.performanceId || ''
        }, 'この演奏会配下の楽譜を一括削除しますか？')));
    });
}

async function deleteSheets(payload) {
    if (!confirmDelete()) return;
    await request('/api/sheets', jsonOptions('DELETE', payload));
    await loadSheets();
    showAlert('楽譜を削除しました', 'success');
}

async function saveSheetPart(sheetId) {
    if (!sheetId) return;
    const select = [...document.querySelectorAll('.sheet-part-assign-select')]
        .find((item) => String(item.dataset.sheetId || '') === String(sheetId));
    const part = select ? select.value : '';
    await request(`/api/sheets/${encodeURIComponent(sheetId)}/part`, jsonOptions('PUT', { part }));
    await loadSheets();
    showAlert('楽譜のパートを保存しました', 'success');
}

function renderPaymentView() {
    const c = $('memberPaymentInfo');
    if (!c) return;
    const member = currentUserMember();
    const name = member ? memberDisplayName(member) : '';
    const payment = findPaymentForMember(member?.id, name);
    c.innerHTML = payment
        ? paymentStatusHtml(payment)
        : '<p class="text-muted">支払情報は未登録です</p>';
}

function findPaymentForMember(memberId, name = '') {
    return appState.payments.find((payment) =>
        (memberId && String(payment.member_id || '') === String(memberId)) ||
        (name && payment.name === name)
    ) || null;
}

function performanceFeeMap(payment) {
    return payment?.performance_fees && typeof payment.performance_fees === 'object'
        ? payment.performance_fees
        : {};
}

function paymentStatusHtml(payment) {
    const feeMap = performanceFeeMap(payment);
    const performanceFees = appState.performances.map((perf) => {
        const paid = Boolean(feeMap[String(perf.id)]);
        return `<div>${escapeHtml(perf.title)}: <span class="badge ${paid ? 'text-bg-success' : 'text-bg-secondary'}">${paid ? '支払済み' : '未払い'}</span></div>`;
    }).join('');
    return `
        <div class="info-block">
            <div>団費: ${escapeHtml(payment.paid_until_month || payment.membership_fee || payment.dues || '未登録')} まで</div>
            <div>最新支払日: ${escapeHtml(payment.latest_payment_date || '未登録')}</div>
            <div class="mt-2"><strong>演奏会費</strong>${performanceFees || '<div class="text-muted">演奏会情報は未登録です</div>'}</div>
        </div>
    `;
}

function paymentMemberOptionsById(selected = '') {
    return ['<option value="">選択してください</option>'].concat(sortedMembersByPartAndKana(appState.members).map((member) => {
        const id = String(member.id || '');
        const part = member.part ? `（${member.part}）` : '';
        return `<option value="${escapeHtml(id)}" ${id === String(selected) ? 'selected' : ''}>${escapeHtml(memberDisplayName(member) + part)}</option>`;
    })).join('');
}

function renderPaymentAdmin() {
    const memberSelect = $('paymentMemberId');
    const feeContainer = $('paymentPerformanceFees');
    const list = $('paymentAdminList');
    if (!memberSelect || !feeContainer || !list) return;

    const selected = memberSelect.value;
    memberSelect.innerHTML = paymentMemberOptionsById(selected);
    if ([...memberSelect.options].some((option) => option.value === selected)) {
        memberSelect.value = selected;
    }

    feeContainer.innerHTML = appState.performances.length
        ? appState.performances.map((perf) => `
            <label class="form-check">
                <input class="form-check-input payment-performance-checkbox" type="checkbox" value="${escapeHtml(String(perf.id))}">
                <span class="form-check-label">${escapeHtml(perf.title)}</span>
            </label>
        `).join('')
        : '<p class="text-muted mb-0">演奏会情報はまだありません</p>';

    list.innerHTML = appState.payments.length
        ? `<div class="list-group">${appState.payments.map((payment) => {
            const member = appState.members.find((item) => String(item.id || '') === String(payment.member_id || ''));
            const name = member ? memberDisplayName(member) : (payment.name || '未設定');
            return `
                <button class="list-group-item list-group-item-action payment-admin-item" type="button" data-payment-id="${escapeHtml(String(payment.id || ''))}">
                    <strong>${escapeHtml(name)}</strong>
                    <div class="small text-muted">団費: ${escapeHtml(payment.paid_until_month || '未登録')} まで / 最新支払日: ${escapeHtml(payment.latest_payment_date || '未登録')}</div>
                </button>
            `;
        }).join('')}</div>`
        : '<p class="text-muted mb-0">支払状況はまだ登録されていません</p>';

    list.querySelectorAll('.payment-admin-item').forEach((button) => {
        button.addEventListener('click', () => selectPaymentRecord(button.dataset.paymentId || ''));
    });
}

function selectPaymentByMember(memberId) {
    const member = appState.members.find((item) => String(item.id || '') === String(memberId));
    const payment = findPaymentForMember(memberId, member ? memberDisplayName(member) : '');
    fillPaymentForm(payment, memberId);
}

function selectPaymentRecord(paymentId) {
    const payment = appState.payments.find((item) => String(item.id || '') === String(paymentId));
    if (!payment) return;
    fillPaymentForm(payment, payment.member_id || '');
}

function fillPaymentForm(payment, memberId = '') {
    if (!$('paymentId')) return;
    $('paymentId').value = payment?.id || '';
    $('paymentMemberId').value = memberId || payment?.member_id || '';
    $('paymentPaidUntilMonth').value = payment?.paid_until_month || '';
    $('paymentLatestDate').value = payment?.latest_payment_date || '';
    const feeMap = performanceFeeMap(payment);
    document.querySelectorAll('.payment-performance-checkbox').forEach((checkbox) => {
        checkbox.checked = Boolean(feeMap[String(checkbox.value)]);
    });
}

function clearPaymentForm() {
    fillPaymentForm(null, '');
}

async function savePaymentStatus() {
    const memberId = $('paymentMemberId')?.value || '';
    const member = appState.members.find((item) => String(item.id || '') === String(memberId));
    if (!member) {
        showAlert('支払状況を登録する団員を選択してください', 'warning');
        return;
    }
    const performanceFees = {};
    document.querySelectorAll('.payment-performance-checkbox').forEach((checkbox) => {
        performanceFees[String(checkbox.value)] = checkbox.checked;
    });
    const payload = {
        member_id: memberId,
        name: memberDisplayName(member),
        paid_until_month: $('paymentPaidUntilMonth')?.value || '',
        latest_payment_date: $('paymentLatestDate')?.value || '',
        performance_fees: performanceFees
    };
    const id = $('paymentId')?.value || findPaymentForMember(memberId, payload.name)?.id || '';
    const saved = id
        ? await request(`/api/extra/payments/${encodeURIComponent(id)}`, jsonOptions('PUT', payload))
        : await saveExtra('payments', payload);
    await loadExtraData();
    renderPaymentView();
    fillPaymentForm(saved, memberId);
    showAlert('支払状況を保存しました', 'success');
}

function renderCastingView() {
    const c = $('memberCastingInfo'); if (!c) return;
    c.innerHTML = appState.performances.map((perf) => {
        const rows = appState.castings.filter((x) => String(x.performance_id || '') === String(perf.id));
        return `<section class="mb-3"><h5>${escapeHtml(perf.title)}</h5>${rows.length ? rows.map((r) => `<div class="info-block"><strong>${escapeHtml(r.piece || '全曲')}</strong><div>${escapeHtml(r.members || r.names || '')}</div></div>`).join('') : '<p class="text-muted">乗り番表は未登録です</p>'}</section>`;
    }).join('');
}

function renderMemberEventView() {
    const c = $('memberEventInfo'); if (!c) return;
    c.innerHTML = `
        <div id="memberEventListView">
            <div class="row g-2 mb-3">
                <div class="col-md-4"><label class="form-label">イベント名</label><input id="memberEventTitle" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">開催日</label><input id="memberEventDate" type="date" class="form-control"></div>
                <div class="col-md-2"><label class="form-label">開始時刻</label><input id="memberEventStartTime" type="time" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">回答期限</label><input id="memberEventDeadline" type="date" class="form-control"></div>
                <div class="col-12"><label class="form-label">イベント概要/備考</label><textarea id="memberEventNotes" class="form-control" rows="3"></textarea></div>
                <div class="col-md-6"><label class="form-label">削除時の合言葉</label><input id="memberEventDeletePhrase" class="form-control"></div>
                <div class="col-md-3 d-flex align-items-end"><button id="memberEventCreateBtn" class="btn btn-primary w-100" type="button">イベント登録</button></div>
            </div>
            <h6>イベント一覧</h6>
            <div class="list-group" id="memberEventList"></div>
        </div>
        <div id="memberEventDetailView" hidden></div>`;
    $('memberEventDate').value = today();
    $('memberEventDeadline').value = today();
    $('memberEventCreateBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '作成中...', async () => {
        const payload = {
            title: $('memberEventTitle').value.trim(),
            date: $('memberEventDate').value,
            start_time: $('memberEventStartTime').value,
            deadline: $('memberEventDeadline').value,
            notes: $('memberEventNotes').value.trim(),
            delete_phrase: $('memberEventDeletePhrase').value.trim(),
            url: ''
        };
        if (!payload.title || !payload.date || !payload.start_time || !payload.deadline || !payload.delete_phrase) {
            showAlert('イベント名、開催日、開始時刻、回答期限、削除時の合言葉を入力してください', 'warning');
            return;
        }
        await request('/api/events', jsonOptions('POST', payload));
        showAlert('イベントを作成しました', 'success');
        await loadEvents(); await loadExtraData();
    }));
    renderMemberEventList();
}

function renderMemberEventList() {
    const list = $('memberEventList');
    if (!list) return;
    const events = sortedEvents(appState.events);
    list.innerHTML = events.length ? '' : '<p class="text-muted mb-0">イベントはまだありません</p>';
    events.forEach((event) => {
        const item = document.createElement('button');
        item.className = 'list-group-item list-group-item-action text-start';
        item.type = 'button';
        const responseCount = appState.eventResponses.filter((r) => String(r.event_id) === String(event.id)).length;
        item.innerHTML = `
            <strong>${escapeHtml(event.title)}</strong>
            <div class="small text-muted">開催: ${escapeHtml(eventDateTimeLabel(event))} / 回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}</div>
            ${event.notes ? `<div class="small multiline-text mt-1">${escapeHtml(event.notes)}</div>` : ''}
            <div class="small text-muted mt-1">回答数: ${responseCount}</div>
        `;
        item.addEventListener('click', () => renderMemberEventDetail(event.id));
        list.appendChild(item);
    });
}

function renderMemberEventDetail(id) {
    const listView = $('memberEventListView');
    const detailView = $('memberEventDetailView');
    const event = appState.events.find((item) => String(item.id) === String(id));
    if (!listView || !detailView || !event) return;
    listView.hidden = true;
    detailView.hidden = false;
    const responses = appState.eventResponses.filter((r) => String(r.event_id) === String(id));
    detailView.innerHTML = `
        <button class="btn btn-sm btn-outline-secondary mb-3" id="memberEventBackBtn" type="button">イベント一覧に戻る</button>
        <section class="info-block pt-0">
            <h5>${escapeHtml(event.title)}</h5>
            <div>開催: ${escapeHtml(eventDateTimeLabel(event))}</div>
            <div>回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}</div>
            ${event.notes ? `<div class="multiline-text mt-2">${escapeHtml(event.notes)}</div>` : ''}
        </section>
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-7"><label class="form-label">参加/不参加</label><select id="eventResponseStatus" class="form-select"><option>参加</option><option>不参加</option></select></div>
            <div class="col-md-3"><button id="eventResponseSaveBtn" class="btn btn-primary w-100" type="button">登録</button></div>
        </div>
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-outline-danger" id="memberEventDeleteBtn" type="button">イベント削除</button>
        </div>
        <h6>回答状況</h6>
        ${responses.length ? responses.map((r) => `<div class="list-group-item">${escapeHtml(r.name)}：${escapeHtml(r.status)}</div>`).join('') : '<p class="text-muted">回答はまだありません</p>'}
    `;
    $('memberEventBackBtn').addEventListener('click', () => {
        detailView.hidden = true;
        listView.hidden = false;
        renderMemberEventList();
    });
    $('eventResponseSaveBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', async () => {
        const name = currentUserMemberName(); const status = $('eventResponseStatus').value;
        if (!name) { showAlert('ログイン中の団員情報が見つかりません', 'warning'); return; }
        await saveExtra('event_responses', { event_id: id, name, status });
        showAlert('イベント出欠を登録しました', 'success');
        await loadExtraData();
        renderMemberEventDetail(id);
    }));
    $('memberEventDeleteBtn').addEventListener('click', (clickEvent) => withButtonStatus(clickEvent.currentTarget, '削除中...', async () => {
        const phrase = prompt('削除時の合言葉を入力してください');
        if (phrase === null) return;
        if (phrase !== (event.delete_phrase || '')) {
            showAlert('削除時の合言葉が違います', 'danger');
            return;
        }
        if (!confirmDelete()) return;
        await deleteEventById(id, false);
        renderMemberEventView();
    }));
}

function renderPieceInfoView() {
    const c = $('memberPieceInfo'); if (!c) return;
    c.innerHTML = appState.performances.map((perf) => {
        const rows = appState.pieceInfos.filter((x) => String(x.performance_id || '') === String(perf.id));
        const fallback = (perf.pieces || []).map((p) => ({ title: performancePieceLabel(p), description: '' }));
        const list = rows.length ? rows : fallback;
        return `<section class="mb-3"><h5>${escapeHtml(perf.title)}</h5>${list.map((r) => `<div class="info-block"><strong>${escapeHtml(r.piece || r.title || '')}</strong>${r.composer ? `<div class="small text-muted">${escapeHtml(r.composer)}</div>` : ''}${r.description || r.notes ? `<div class="multiline-text mt-1">${escapeHtml(r.description || r.notes)}</div>` : ''}</div>`).join('')}</section>`;
    }).join('');
}

function renderAlbumView() {
    const c = $('memberAlbumInfo'); if (!c) return;
    c.innerHTML = appState.albums.length ? `<div class="row g-3">${appState.albums.map((a) => `<div class="col-6 col-md-4 col-xl-3"><a href="${escapeHtml(a.url || '#')}" target="_blank"><img src="${escapeHtml(a.thumbnail_url || a.url || '')}" class="album-photo" alt="${escapeHtml(a.title || '写真')}"></a><div class="small mt-1">${escapeHtml(a.title || '')}</div></div>`).join('')}</div>` : '<p class="text-muted">写真はまだ登録されていません</p>';
}


async function request(url, options = {}) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
        const message = typeof data === 'object' && data.detail ? data.detail : '通信に失敗しました';
        showAlert(message, 'danger');
        throw new Error(message);
    }
    return data;
}

function jsonOptions(method, payload) {
    return {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    };
}

function emptyText(items, message) {
    return items.length ? '' : `<li class="list-group-item text-muted">${message}</li>`;
}

function groupBy(items, key) {
    return items.reduce((groups, item) => {
        const value = item[key] || '未分類';
        groups[value] = groups[value] || [];
        groups[value].push(item);
        return groups;
    }, {});
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[char]));
}

function showAlert(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `alert alert-${type} shadow-sm`;
    toast.textContent = message;
    $('toastArea').appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
}
