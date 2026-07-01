var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

async function saveAnnouncement() {
    const payload = {
        date: $('annDate').value || window.portalRuntimeContext.today(),
        title: $('annTitle') ? $('annTitle').value.trim() : '',
        content: $('annContent').value.trim()
    };
    if (!payload.title && !payload.content) {
        showAlert('お知らせタイトルまたは内容を入力してください', 'warning');
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
    $('annDate').value = item.date || window.portalRuntimeContext.today();
    if ($('annTitle')) $('annTitle').value = item.title || '';
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
    $('annDate').value = window.portalRuntimeContext.today();
    if ($('annTitle')) $('annTitle').value = '';
    $('annContent').value = '';
}

function renderAnnouncements() {
    const admin = $('annListItems');
    const member = $('memberAnnList');
    admin.innerHTML = emptyText(appState.announcements, 'お知らせはまだありません');
    member.innerHTML = emptyText(appState.announcements, 'お知らせはまだありません');
    appState.announcements.forEach((ann) => {
        admin.appendChild(announcementItem(ann, true));
        member.appendChild(announcementItem(ann, false));
    });
    if (!appState.suppressDerivedRender) renderPortalHome();
}

function announcementItem(ann, selectable) {
    const item = document.createElement(selectable ? 'button' : 'li');
    item.className = 'list-group-item list-group-item-action';
    if (selectable) item.type = 'button';
    else item.style.cursor = 'pointer';

    if (!selectable) {
        item.innerHTML = `<div><span class="small text-muted">${escapeHtml(formatDateWithWeekday(ann.date))}</span> <strong>${escapeHtml(ann.title || '')}</strong></div>`;
        item.addEventListener('click', () => {
            appState.portalSelectedAnnouncementId = ann.id;
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

    const ann = appState.announcements.find((a) => a.id === appState.portalSelectedAnnouncementId);
    if (!ann) {
        header.textContent = 'お知らせ詳細';
        content.innerHTML = '<p class="text-muted">お知らせが見つかりません</p>';
        return;
    }

    header.textContent = `${formatDateWithWeekday(ann.date)} ${ann.title || ''}`;
    content.innerHTML = `
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-sm btn-outline-secondary" id="annDetailBackBtn" type="button">ポータルメニューに戻る</button>
        </div>
        <div>${escapeHtml(ann.content || 'コンテンツなし')}</div>
    `;
    $('annDetailBackBtn')?.addEventListener('click', () => {
        appState.portalSelectedAnnouncementId = null;
        showMemberTab('member-home');
    });
}
