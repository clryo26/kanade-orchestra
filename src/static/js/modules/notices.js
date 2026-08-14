// New member notice board and legacy maintenance-information integration.
// Existing /api/announcements remains maintenance information; /api/notices is the new notice board.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

const PORTAL_NOTICE_REGISTER_PERMISSIONS = new Set(['一般', '管理者', 'システム管理者']);
const PORTAL_NOTICE_ADMIN_PERMISSIONS = new Set(['管理者', 'システム管理者']);

var baseSetupPortalHomeForNotices = setupPortalHome;
var baseRenderMenuGroupsForNotices = renderMenuGroups;
var baseRenderPortalHomeForNotices = renderPortalHome;

let portalNoticesLoaded = false;
let portalNoticesLoadPromise = null;

async function ensurePortalNoticesLoaded() {
    if (portalNoticesLoaded) return appState.notices || [];
    if (!portalNoticesLoadPromise) {
        portalNoticesLoadPromise = request('/api/notices')
            .then((items) => {
                appState.notices = Array.isArray(items) ? items : [];
                portalNoticesLoaded = true;
                return appState.notices;
            })
            .catch((error) => {
                portalNoticesLoadPromise = null;
                throw error;
            });
    }
    return portalNoticesLoadPromise;
}

function canRegisterPortalNotice() {
    return PORTAL_NOTICE_REGISTER_PERMISSIONS.has(String(appState.currentUserPermission || ''));
}

function canEditPortalNotice(notice) {
    if (!notice) return false;
    if (PORTAL_NOTICE_ADMIN_PERMISSIONS.has(String(appState.currentUserPermission || ''))) return true;
    const creatorId = String(notice.created_by_member_id || '');
    const memberId = String(appState.currentUserMemberId || '');
    return Boolean(creatorId && memberId && creatorId === memberId);
}

function sortedPortalNotices() {
    return [...(appState.notices || [])].sort((a, b) =>
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
        || Number(b.id || 0) - Number(a.id || 0)
    );
}

function sortedMaintenanceInfo() {
    return [...(appState.announcements || [])].sort((a, b) =>
        String(b.date || '').localeCompare(String(a.date || ''))
        || Number(b.id || 0) - Number(a.id || 0)
    );
}

// Override legacy announcement presentation only. API behavior remains unchanged.
async function saveAnnouncement() {
    const payload = {
        date: $('annDate').value || window.portalRuntimeContext.today(),
        title: $('annTitle') ? $('annTitle').value.trim() : '',
        content: $('annContent').value.trim(),
    };
    if (!payload.title && !payload.content) {
        showAlert('メンテナンス情報のタイトルまたは内容を入力してください', 'warning');
        return;
    }
    const id = $('annId').value;
    await request(id ? `/api/announcements/${id}` : '/api/announcements', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearAnnouncementForm();
    await loadAnnouncements();
    showAlert('メンテナンス情報を保存しました', 'success');
}

async function deleteAnnouncement() {
    const id = $('annId').value;
    if (!id) {
        showAlert('削除するメンテナンス情報を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/announcements/${id}`, { method: 'DELETE' });
    clearAnnouncementForm();
    await loadAnnouncements();
    showAlert('メンテナンス情報を削除しました', 'success');
}

function renderAnnouncements() {
    const admin = $('annListItems');
    const member = $('memberAnnList');
    const sorted = sortedMaintenanceInfo();
    if (admin) admin.innerHTML = emptyText(sorted, 'メンテナンス情報はまだありません');
    if (member) member.innerHTML = emptyText(sorted, 'メンテナンス情報はまだありません');
    sorted.forEach((ann) => {
        if (admin) admin.appendChild(announcementItem(ann, true));
        if (member) member.appendChild(announcementItem(ann, false));
    });
    if (!appState.suppressDerivedRender) renderPortalHome();
}

function announcementItem(ann, selectable, options = {}) {
    const item = document.createElement(selectable ? 'button' : 'li');
    item.className = 'list-group-item list-group-item-action';
    if (selectable) item.type = 'button';
    else item.style.cursor = 'pointer';
    if (options.portalHomeOneLine) item.classList.add('portal-home-announcement-mobile-line');

    if (!selectable) {
        const dateText = escapeHtml(formatDateWithWeekday(ann.date));
        const titleText = escapeHtml(ann.title || '');
        const oneLineClass = options.portalHomeOneLine ? ' portal-announcement-one-line' : '';
        item.innerHTML = `<div class="${oneLineClass.trim()}"><span class="small text-muted portal-announcement-date">${dateText}</span> <strong class="portal-announcement-title">${titleText}</strong></div>`;
        item.addEventListener('click', () => {
            appState.portalSelectedAnnouncementId = ann.id;
            appState.maintenanceDetailReturnTab = options.returnTab || 'member-home';
            showMemberTab('announcement-detail');
        });
    } else {
        item.innerHTML = `<div><span class="small text-muted">${escapeHtml(formatDateWithWeekday(ann.date))}</span> <strong>${escapeHtml(ann.title || '')}</strong></div>${ann.content ? `<div class="mt-1">${escapeHtml(ann.content)}</div>` : ''}`;
        item.addEventListener('click', () => selectAnnouncement(ann.id));
    }
    return item;
}

function renderAnnouncementDetail() {
    const header = $('annDetailHeader');
    const content = $('annDetailContent');
    if (!header || !content) return;
    const ann = (appState.announcements || []).find((item) => String(item.id) === String(appState.portalSelectedAnnouncementId));
    if (!ann) {
        header.textContent = 'メンテナンス情報詳細';
        content.innerHTML = '<p class="text-muted">メンテナンス情報が見つかりません</p>';
        return;
    }
    const returnTab = appState.maintenanceDetailReturnTab === 'maintenance-history' ? 'maintenance-history' : 'member-home';
    const backLabel = returnTab === 'maintenance-history' ? '一覧に戻る' : 'ポータルメニューに戻る';
    header.textContent = `${formatDateWithWeekday(ann.date)} ${ann.title || ''}`;
    content.innerHTML = `
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-sm btn-outline-secondary" id="annDetailBackBtn" type="button">${backLabel}</button>
        </div>
        <div class="multiline-text">${escapeHtml(ann.content || 'コンテンツなし')}</div>
    `;
    $('annDetailBackBtn')?.addEventListener('click', () => {
        appState.portalSelectedAnnouncementId = null;
        if (returnTab === 'maintenance-history') {
            openMaintenanceHistory();
            return;
        }
        showMemberTab('member-home');
    });
}

function ensurePortalNoticeHeaderActions() {
    const noticeContainer = $('portalHomeAnnouncements');
    const heading = noticeContainer?.closest('.portal-home-section')?.querySelector('.portal-home-heading');
    if (!heading) return;
    if (!$('portalNoticeHeaderActions')) {
        heading.insertAdjacentHTML('beforeend', `
            <div class="d-flex flex-wrap gap-2" id="portalNoticeHeaderActions">
                <button class="btn btn-sm btn-outline-primary" id="portalNoticeRegisterBtn" type="button">登録</button>
                <button class="btn btn-sm btn-outline-primary" id="portalNoticeHistoryBtn" type="button">過去の一覧</button>
            </div>
        `);
    }
    const registerButton = $('portalNoticeRegisterBtn');
    if (registerButton) registerButton.hidden = !canRegisterPortalNotice();
}

function setupNoticeAndMaintenanceUi() {
    ensurePortalNoticeHeaderActions();

    const adminAnnouncementButton = document.querySelector('#adminPanel .toolbar [data-tab="announcement"]');
    if (adminAnnouncementButton) adminAnnouncementButton.remove();

    const systemPanel = $('systemPanel');
    const systemToolbar = systemPanel?.querySelector('.toolbar');
    const maintenanceTab = $('announcementTab') || $('system-maintenance-infoTab');
    if (systemPanel && systemToolbar && maintenanceTab) {
        if (!systemToolbar.querySelector('[data-tab="system-maintenance-info"]')) {
            systemToolbar.insertAdjacentHTML(
                'beforeend',
                '<button class="btn btn-sm btn-outline-primary" data-tab="system-maintenance-info" type="button">メンテナンス情報</button>'
            );
        }
        const maintenanceButton = systemToolbar.querySelector('[data-tab="system-maintenance-info"]');
        // This button is created after the initial navigation binding, so bind its
        // existing system-tab transition here without changing other tab handlers.
        if (maintenanceButton && maintenanceButton.dataset.maintenanceInfoBound !== 'true') {
            maintenanceButton.dataset.maintenanceInfoBound = 'true';
            maintenanceButton.addEventListener('click', function () {
                switchTab('systemPanel', 'system-maintenance-info');
            });
        }
        maintenanceTab.id = 'system-maintenance-infoTab';
        const cardHeader = maintenanceTab.querySelector('.card-header');
        if (cardHeader) cardHeader.textContent = 'メンテナンス情報';
        if (maintenanceTab.parentElement !== systemPanel) systemPanel.appendChild(maintenanceTab);
    }

    const legacyMemberButton = document.querySelector('#memberPanel .toolbar [data-tab="member-announce"]');
    if (legacyMemberButton) legacyMemberButton.remove();
    const legacyMemberTab = $('memberAnnounceTab');
    if (legacyMemberTab) legacyMemberTab.hidden = true;

    const memberPanel = $('memberPanel');
    if (!memberPanel) return;

    if (!$('maintenance-historyTab')) {
        memberPanel.insertAdjacentHTML('beforeend', `
            <div id="maintenance-historyTab" class="tab-content" hidden>
                <div class="card">
                    <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
                        <span>メンテナンス情報一覧</span>
                        <button class="btn btn-sm btn-outline-secondary" id="maintenanceHistoryBackBtn" type="button">ポータルメニューに戻る</button>
                    </div>
                    <div class="card-body"><ul class="list-group" id="maintenanceHistoryList"></ul></div>
                </div>
            </div>
        `);
    }

    if (!$('notice-registerTab')) {
        memberPanel.insertAdjacentHTML('beforeend', `
            <div id="notice-registerTab" class="tab-content" hidden>
                <div class="card">
                    <div class="card-header" id="noticeFormHeader">お知らせ登録</div>
                    <div class="card-body">
                        <div class="row g-3">
                            <div class="col-md-3"><label class="form-label" for="noticeDate">日付</label><input type="date" class="form-control" id="noticeDate"></div>
                            <div class="col-md-9"><label class="form-label" for="noticeTitle">タイトル</label><input type="text" class="form-control" id="noticeTitle"></div>
                            <div class="col-12"><label class="form-label" for="noticeContent">内容</label><textarea class="form-control" id="noticeContent" rows="7"></textarea></div>
                        </div>
                        <div class="d-flex flex-wrap gap-2 mt-3">
                            <button class="btn btn-success" id="noticeSaveBtn" type="button">登録</button>
                            <button class="btn btn-outline-secondary" id="noticeFormBackBtn" type="button">ポータルメニューに戻る</button>
                        </div>
                    </div>
                </div>
            </div>
        `);
    }

    if (!$('notice-historyTab')) {
        memberPanel.insertAdjacentHTML('beforeend', `
            <div id="notice-historyTab" class="tab-content" hidden>
                <div class="card">
                    <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
                        <span>お知らせ一覧</span>
                        <button class="btn btn-sm btn-outline-secondary" id="noticeHistoryBackBtn" type="button">ポータルメニューに戻る</button>
                    </div>
                    <div class="card-body"><ul class="list-group" id="noticeHistoryList"></ul></div>
                </div>
            </div>
        `);
    }

    if (!$('notice-detailTab')) {
        memberPanel.insertAdjacentHTML('beforeend', `
            <div id="notice-detailTab" class="tab-content" hidden>
                <div class="card">
                    <div class="card-header" id="noticeDetailHeader">お知らせ詳細</div>
                    <div class="card-body" id="noticeDetailContent"></div>
                </div>
            </div>
        `);
    }

    const maintenanceBack = $('maintenanceHistoryBackBtn');
    if (maintenanceBack) maintenanceBack.onclick = () => showMemberTab('member-home');
    const noticeHistoryBack = $('noticeHistoryBackBtn');
    if (noticeHistoryBack) noticeHistoryBack.onclick = () => showMemberTab('member-home');
    const noticeSave = $('noticeSaveBtn');
    if (noticeSave) noticeSave.onclick = (event) => withButtonStatus(event.currentTarget, '保存中...', savePortalNotice);
}

function maintenanceInfoHomeHtml() {
    return `
        <section class="portal-menu-group portal-maintenance-info-section">
            <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
                <h3 class="mb-0">メンテナンス情報</h3>
                <button class="btn btn-sm btn-outline-primary" data-maintenance-history type="button">過去の情報</button>
            </div>
            <div id="portalMaintenanceInfoList"></div>
        </section>
    `;
}

function bindMaintenanceHome(container) {
    const list = container.querySelector('#portalMaintenanceInfoList');
    const items = sortedMaintenanceInfo().slice(0, 5);
    if (list) {
        list.innerHTML = items.length
            ? '<div class="list-group" data-maintenance-latest-list></div>'
            : '<p class="text-muted mb-0">メンテナンス情報はまだありません</p>';
        const group = list.querySelector('[data-maintenance-latest-list]');
        if (group) {
            items.forEach((item) => group.appendChild(announcementItem(item, false, {
                portalHomeOneLine: true,
                returnTab: 'member-home',
            })));
        }
    }
    const historyButton = container.querySelector('[data-maintenance-history]');
    if (historyButton) historyButton.onclick = openMaintenanceHistory;
}

function openMaintenanceHistory() {
    const list = $('maintenanceHistoryList');
    const items = sortedMaintenanceInfo();
    if (list) {
        list.innerHTML = emptyText(items, 'メンテナンス情報はまだありません');
        items.forEach((item) => list.appendChild(announcementItem(item, false, { returnTab: 'maintenance-history' })));
    }
    showMemberTab('maintenance-history', false);
    window.scrollTo({ top: 0, behavior: 'auto' });
}

function portalNoticeItem(notice) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'list-group-item list-group-item-action portal-home-announcement-mobile-line';
    item.innerHTML = `
        <div class="portal-announcement-one-line">
            <span class="small text-muted portal-announcement-date">${escapeHtml(formatDateWithWeekday(notice.date || ''))}</span>
            <strong class="portal-announcement-title">${escapeHtml(notice.title || '')}</strong>
        </div>
    `;
    item.addEventListener('click', () => openPortalNoticeDetail(notice.id, 'member-home'));
    return item;
}

function renderPortalNoticeHome(container) {
    ensurePortalNoticeHeaderActions();
    if (!portalNoticesLoaded) {
        container.innerHTML = '<p class="text-muted mb-0">お知らせを読み込み中...</p>';
        ensurePortalNoticesLoaded()
            .then(() => { if (container.isConnected) renderPortalNoticeHome(container); })
            .catch((error) => {
                console.warn('Portal notice load failed', error);
                if (container.isConnected) container.innerHTML = '<p class="text-danger mb-0">お知らせを取得できませんでした</p>';
            });
    } else {
        const items = sortedPortalNotices().slice(0, 5);
        container.innerHTML = items.length
            ? '<div class="list-group" id="portalHomeNoticeList"></div>'
            : '<p class="text-muted mb-0">お知らせはまだありません</p>';
        const list = $('portalHomeNoticeList');
        if (list) items.forEach((notice) => list.appendChild(portalNoticeItem(notice)));
    }

    const registerButton = $('portalNoticeRegisterBtn');
    if (registerButton) {
        registerButton.hidden = !canRegisterPortalNotice();
        registerButton.onclick = canRegisterPortalNotice() ? () => openPortalNoticeForm() : null;
    }
    const historyButton = $('portalNoticeHistoryBtn');
    if (historyButton) historyButton.onclick = openPortalNoticeHistory;
}

async function openPortalNoticeHistory() {
    try {
        await ensurePortalNoticesLoaded();
    } catch (error) {
        console.warn('Portal notice history load failed', error);
        showAlert('お知らせを取得できませんでした', 'danger');
        return;
    }
    renderPortalNoticeHistory();
    showMemberTab('notice-history', false);
    window.scrollTo({ top: 0, behavior: 'auto' });
}

function renderPortalNoticeHistory() {
    const list = $('noticeHistoryList');
    if (!list) return;
    const items = sortedPortalNotices();
    list.innerHTML = emptyText(items, 'お知らせはまだありません');
    items.forEach((notice) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'list-group-item list-group-item-action';
        row.innerHTML = `<div class="portal-announcement-one-line"><span class="small text-muted portal-announcement-date">${escapeHtml(formatDateWithWeekday(notice.date || ''))}</span><strong class="portal-announcement-title">${escapeHtml(notice.title || '')}</strong></div>`;
        row.addEventListener('click', () => openPortalNoticeDetail(notice.id, 'notice-history'));
        list.appendChild(row);
    });
}

function openPortalNoticeDetail(noticeId, returnTab = 'member-home') {
    appState.selectedPortalNoticeId = noticeId;
    appState.noticeDetailReturnTab = returnTab === 'notice-history' ? 'notice-history' : 'member-home';
    renderPortalNoticeDetail();
    showMemberTab('notice-detail', false);
    window.scrollTo({ top: 0, behavior: 'auto' });
}

function renderPortalNoticeDetail() {
    const header = $('noticeDetailHeader');
    const content = $('noticeDetailContent');
    if (!header || !content) return;
    const notice = (appState.notices || []).find((item) => String(item.id) === String(appState.selectedPortalNoticeId));
    if (!notice) {
        header.textContent = 'お知らせ詳細';
        content.innerHTML = '<p class="text-muted mb-0">お知らせが見つかりません</p>';
        return;
    }
    const fromHistory = appState.noticeDetailReturnTab === 'notice-history';
    const backLabel = fromHistory ? '一覧に戻る' : 'ポータルメニューに戻る';
    const editActions = canEditPortalNotice(notice)
        ? '<button class="btn btn-sm btn-outline-primary" id="noticeEditBtn" type="button">編集</button><button class="btn btn-sm btn-outline-danger" id="noticeDeleteBtn" type="button">削除</button>'
        : '';
    header.textContent = `${formatDateWithWeekday(notice.date || '')} ${notice.title || ''}`;
    content.innerHTML = `
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-sm btn-outline-secondary" id="noticeDetailBackBtn" type="button">${backLabel}</button>
            ${editActions}
        </div>
        <div class="multiline-text">${escapeHtml(notice.content || '')}</div>
    `;
    $('noticeDetailBackBtn')?.addEventListener('click', () => {
        if (fromHistory) openPortalNoticeHistory();
        else showMemberTab('member-home');
    });
    $('noticeEditBtn')?.addEventListener('click', () => openPortalNoticeForm(notice));
    $('noticeDeleteBtn')?.addEventListener('click', () => deletePortalNotice(notice));
}

function openPortalNoticeForm(notice = null) {
    if (!notice && !canRegisterPortalNotice()) {
        showAlert('お知らせを登録する権限がありません', 'warning');
        return;
    }
    if (notice && !canEditPortalNotice(notice)) {
        showAlert('このお知らせを編集する権限がありません', 'warning');
        return;
    }
    appState.noticeEditingId = notice?.id || null;
    const editing = Boolean(notice);
    $('noticeFormHeader').textContent = editing ? 'お知らせ編集' : 'お知らせ登録';
    $('noticeDate').value = notice?.date || window.portalRuntimeContext.today();
    $('noticeTitle').value = notice?.title || '';
    $('noticeContent').value = notice?.content || '';
    $('noticeSaveBtn').textContent = editing ? '更新' : '登録';
    $('noticeFormBackBtn').textContent = editing && appState.noticeDetailReturnTab === 'notice-history' ? '一覧に戻る' : 'ポータルメニューに戻る';
    $('noticeFormBackBtn').onclick = () => {
        appState.noticeEditingId = null;
        if (editing) openPortalNoticeDetail(notice.id, appState.noticeDetailReturnTab);
        else showMemberTab('member-home');
    };
    showMemberTab('notice-register', false);
    window.scrollTo({ top: 0, behavior: 'auto' });
}

async function savePortalNotice() {
    const payload = {
        date: $('noticeDate')?.value || '',
        title: $('noticeTitle')?.value.trim() || '',
        content: $('noticeContent')?.value.trim() || '',
    };
    if (!payload.date || !payload.title || !payload.content) {
        showAlert('日付、タイトル、内容を入力してください', 'warning');
        return;
    }
    const editingId = appState.noticeEditingId;
    const updated = await request(
        editingId ? `/api/notices/${encodeURIComponent(editingId)}` : '/api/notices',
        jsonOptions(editingId ? 'PUT' : 'POST', payload)
    );
    const items = [...(appState.notices || [])];
    const index = items.findIndex((item) => String(item.id) === String(updated.id));
    if (index >= 0) items[index] = updated;
    else items.push(updated);
    appState.notices = items;
    portalNoticesLoaded = true;
    appState.noticeEditingId = null;
    renderPortalHome();
    showAlert(editingId ? 'お知らせを更新しました' : 'お知らせを登録しました', 'success');
    if (editingId) openPortalNoticeDetail(updated.id, appState.noticeDetailReturnTab);
    else showMemberTab('member-home');
}

async function deletePortalNotice(notice) {
    if (!canEditPortalNotice(notice)) {
        showAlert('このお知らせを削除する権限がありません', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/notices/${encodeURIComponent(notice.id)}`, { method: 'DELETE' });
    appState.notices = (appState.notices || []).filter((item) => String(item.id) !== String(notice.id));
    portalNoticesLoaded = true;
    appState.selectedPortalNoticeId = null;
    renderPortalHome();
    showAlert('お知らせを削除しました', 'success');
    if (appState.noticeDetailReturnTab === 'notice-history') openPortalNoticeHistory();
    else showMemberTab('member-home');
}

setupPortalHome = function setupPortalHomeWithNoticeIntegration() {
    baseSetupPortalHomeForNotices();
    setupNoticeAndMaintenanceUi();
};

renderMenuGroups = function renderMenuGroupsWithMaintenanceInfo(container) {
    baseRenderMenuGroupsForNotices(container);
    if (!container || container.id !== 'portalHomeMenu') return;
    const actions = container.querySelector('.portal-menu-actions-section');
    if (actions && !container.querySelector('.portal-maintenance-info-section')) {
        actions.insertAdjacentHTML('beforebegin', maintenanceInfoHomeHtml());
    }
    bindMaintenanceHome(container);
};

renderPortalHome = function renderPortalHomeWithNewNotices() {
    baseRenderPortalHomeForNotices();
    const noticeContainer = $('portalHomeAnnouncements');
    if (noticeContainer) renderPortalNoticeHome(noticeContainer);
};

// Used by the bootstrap lazy loader to confirm the integration hooks are ready.
window.__KANADE_PORTAL_NOTICES_MODULE_LOADED__ = true;

if (typeof ACCESS_LOG_MENU_LABELS !== 'undefined') {
    ACCESS_LOG_MENU_LABELS.announcement = 'メンテナンス情報';
    ACCESS_LOG_MENU_LABELS['member-announce'] = 'メンテナンス情報';
    ACCESS_LOG_MENU_LABELS['announcement-detail'] = 'メンテナンス情報詳細';
    ACCESS_LOG_MENU_LABELS['system-maintenance-info'] = 'メンテナンス情報';
    ACCESS_LOG_MENU_LABELS['maintenance-history'] = 'メンテナンス情報一覧';
    ACCESS_LOG_MENU_LABELS['notice-register'] = 'お知らせ登録';
    ACCESS_LOG_MENU_LABELS['notice-history'] = 'お知らせ一覧';
    ACCESS_LOG_MENU_LABELS['notice-detail'] = 'お知らせ詳細';
}
