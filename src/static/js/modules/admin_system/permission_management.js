// System-admin-only assignment of the existing system-admin permission.

var appState = (typeof window.getAppState === 'function')
    ? window.getAppState()
    : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function systemPermissionMemberName(member) {
    return String(member.name || `${member.last_name || ''}${member.first_name || ''}` || '名称未設定');
}

async function renderSystemPermissionManagement() {
    const list = $('systemPermissionManagementList');
    const status = $('systemPermissionManagementStatus');
    if (!list) return;
    if (status) {
        status.hidden = false;
        status.textContent = '団員一覧を読み込み中...';
    }
    const members = await request('/api/system/members');
    appState.members = Array.isArray(members) ? members : [];
    if (status) status.hidden = true;
    if (!appState.members.length) {
        list.innerHTML = '<p class="text-muted mb-0">登録済み団員はいません</p>';
        return;
    }
    list.innerHTML = `<div class="list-group">${appState.members.map((member) => {
        const isSystemAdmin = member.permission === 'システム管理者';
        return `<div class="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
            <div><strong>${escapeHtml(systemPermissionMemberName(member))}</strong><div class="small text-muted">パート: ${escapeHtml(member.part || '未設定')} / 現在の権限: ${escapeHtml(member.permission || '一般')}</div></div>
            <button class="btn btn-sm btn-outline-primary system-permission-grant-btn" type="button" data-member-id="${escapeHtml(String(member.id || ''))}" ${isSystemAdmin ? 'disabled' : ''}>${isSystemAdmin ? '付与済み' : 'システム管理者を付与'}</button>
        </div>`;
    }).join('')}</div>`;
    list.querySelectorAll('.system-permission-grant-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '付与中...', () => grantSystemPermission(button.dataset.memberId || '')));
    });
}

async function grantSystemPermission(memberId) {
    if (!memberId) return;
    await request(`/api/system/members/${encodeURIComponent(memberId)}/permission`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission: 'システム管理者' }),
    });
    await renderSystemPermissionManagement();
    showAlert('システム管理者権限を付与しました', 'success');
}
